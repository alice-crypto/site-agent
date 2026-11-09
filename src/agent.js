import { setTimeout as delay } from 'node:timers/promises';
import { runShell } from './exec.js';
import { Git } from './git.js';
import { probe } from './health.js';
import { Notifier } from './notify.js';
import { decide } from './policy.js';
import { scheduleStatus } from './schedule.js';
import { StateStore } from './state.js';
import * as code from './detectors/code.js';
import * as content from './detectors/content.js';
import * as dependencies from './detectors/dependencies.js';

const DETECTORS = [
  { key: 'dependencies', type: 'dependency', module: dependencies },
  { key: 'code', type: 'code', module: code },
  { key: 'content', type: 'content', module: content },
];
const SEVERITY_RANK = { critical: 0, high: 1 };
const RISK_RANK = { low: 0, medium: 1, high: 2 };
const DAY_MS = 24 * 60 * 60 * 1000;

function priority(change) {
  return [SEVERITY_RANK[change.severity] ?? 2, RISK_RANK[change.risk] ?? 3];
}

function comparePriority(a, b) {
  const [severityA, riskA] = priority(a);
  const [severityB, riskB] = priority(b);
  return severityA - severityB || riskA - riskB;
}

function byActor(actor) {
  return actor ? ` par ${actor}` : '';
}

function withoutPayload({ payload, ...record }) {
  return record;
}

export class Agent {
  constructor(config, { fetchImpl = fetch, now = () => new Date(), sleep = delay, notifier, silent = false, onReport = null } = {}) {
    this.config = config;
    this.onReport = onReport;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.store = new StateStore(config.stateDir);
    this.git = new Git(config.site);
    this.notifier =
      notifier ??
      new Notifier({
        store: this.store,
        siteName: config.name,
        silent,
        fetchImpl,
        now,
        webhookUrl: process.env[config.notify.webhookUrlEnv] ?? null,
      });
  }

  async runCycle({ detect = true } = {}) {
    const report = await this.store.withLock(() => this.#cycle(detect));
    this.onReport?.(this.config.name, report);
    return report;
  }

  async #cycle(detect) {
    const state = await this.store.load();
    const health = await this.#probe();
    const report = { dryRun: this.config.dryRun, health, decisions: [], applied: null, incident: null };

    if (health.healthy) {
      await this.#markHealthy(state);
    } else {
      report.incident = await this.#handleIncident(state, health);
    }

    if (detect) await this.#processChanges(state, health.healthy, report);

    if (!this.config.dryRun) await this.store.save(state);
    return report;
  }

  #probe() {
    return probe(this.config.health, { fetchImpl: this.fetchImpl, sleep: this.sleep });
  }

  async #settledProbe() {
    await this.sleep(this.config.health.settleSeconds * 1000);
    return this.#probe();
  }

  #command(name) {
    const command = this.config.site.commands[name];
    if (!command) return null;
    return runShell(command, { cwd: this.config.site.dir, timeoutSeconds: this.config.site.commandTimeoutSeconds });
  }

  async #markHealthy(state) {
    const { failuresBeforeAction } = this.config.detectors.incident;
    if (state.healthFailures >= failuresBeforeAction && !this.config.dryRun) {
      await this.notifier.send('success', 'Le site répond de nouveau normalement.');
    }
    state.healthFailures = 0;
    if (!state.lastKnownGood) state.lastKnownGood = await this.git.head();
  }

  async #alertIncident(state, message) {
    const cooldownMs = this.config.detectors.incident.cooldownMinutes * 60 * 1000;
    const last = state.lastIncidentAlertAt ? Date.parse(state.lastIncidentAlertAt) : 0;
    if (this.now().getTime() - last < cooldownMs) return;
    state.lastIncidentAlertAt = this.now().toISOString();
    await this.notifier.send('critical', message);
  }

  async #handleIncident(state, health) {
    const settings = this.config.detectors.incident;
    state.healthFailures += 1;
    if (!settings.enabled || state.healthFailures < settings.failuresBeforeAction) return { action: 'observed' };
    if (this.config.dryRun) return { action: 'simulated' };

    const summary = health.reasons.join(' ; ');
    if (state.paused) {
      await this.#alertIncident(state, `Site en panne et agent en pause (${state.paused.reason}) : ${summary}`);
      return { action: 'paused' };
    }

    const now = this.now().getTime();
    state.remediations = state.remediations.filter((at) => now - Date.parse(at) < DAY_MS);
    const last = state.remediations.at(-1);
    if (last && now - Date.parse(last) < settings.cooldownMinutes * 60 * 1000) return { action: 'cooldown' };
    if (state.remediations.length >= settings.maxPerDay) {
      await this.#alertIncident(state, `Site en panne, limite de ${settings.maxPerDay} réparations par 24 h atteinte : ${summary}`);
      return { action: 'limit-reached' };
    }
    state.remediations.push(this.now().toISOString());

    if (await this.#tryRestart()) {
      state.healthFailures = 0;
      await this.notifier.send('success', `Incident résolu par un redémarrage : ${summary}`);
      return { action: 'restarted' };
    }

    const head = await this.git.head();
    if (state.lastKnownGood && state.lastKnownGood !== head) {
      if (!(await this.git.isClean())) {
        state.paused = { reason: 'panne avec des fichiers modifiés à la main sur le serveur', at: this.now().toISOString() };
        await this.notifier.send('critical', 'Site en panne : retour arrière refusé, des fichiers ont été modifiés à la main.');
        return { action: 'manual-required' };
      }
      if (await this.#rollback(head, state.lastKnownGood)) {
        state.blocked[`code:${head}`] = { reason: 'version retirée après une panne', at: this.now().toISOString() };
        state.healthFailures = 0;
        await this.notifier.send('warn', `Incident résolu par un retour à ${state.lastKnownGood.slice(0, 7)} : ${summary}`);
        return { action: 'rolled-back', to: state.lastKnownGood };
      }
    }

    state.paused = { reason: 'réparation automatique sans effet', at: this.now().toISOString() };
    await this.notifier.send('critical', `Site toujours en panne après réparation automatique, intervention requise : ${summary}`);
    return { action: 'manual-required' };
  }

  async #tryRestart() {
    if (!this.config.site.commands.restart) return false;
    try {
      await this.#command('restart');
    } catch (error) {
      await this.notifier.send('warn', error.message);
      return false;
    }
    return (await this.#settledProbe()).healthy;
  }

  async #detectAll() {
    const context = {
      config: this.config,
      git: this.git,
      fetchImpl: this.fetchImpl,
      warn: (message) => this.notifier.send('warn', message),
    };
    const changes = [];
    for (const { key, module } of DETECTORS) {
      if (!this.config.detectors[key].enabled) continue;
      try {
        changes.push(...(await module.detect(context)));
      } catch (error) {
        // Une source en panne ne doit pas bloquer les autres types de mises à jour.
        await this.notifier.send('warn', `Détection « ${key} » impossible : ${error.message}`);
      }
    }
    return changes.sort(comparePriority);
  }

  async #processChanges(state, healthy, report) {
    const changes = await this.#detectAll();
    const now = this.now();
    state.autoApplied = state.autoApplied.filter((at) => now.getTime() - Date.parse(at) < DAY_MS);
    const context = {
      policy: this.config.policy,
      state,
      healthy,
      schedule: scheduleStatus(now, this.config.schedule),
      autoCountToday: state.autoApplied.length,
    };

    const decisions = changes.map((change) => ({ change, ...decide(change, context) }));
    report.decisions = decisions.map(({ change, outcome, reasons }) => ({
      id: change.id,
      title: change.title,
      risk: change.risk,
      outcome,
      reasons,
    }));
    if (this.config.dryRun) return;

    await this.#syncApprovals(state, decisions);

    // Un seul déploiement par cycle : une panne reste attribuable à un seul changement.
    const next = decisions.find(({ outcome }) => outcome === 'apply');
    if (next) report.applied = await this.#execute(next.change, state);
  }

  async #syncApprovals(state, decisions) {
    const previous = state.pending;
    state.pending = {};
    for (const { change, outcome } of decisions) {
      if (outcome !== 'awaiting-approval') continue;
      const firstSeen = previous[change.id]?.firstSeen ?? this.now().toISOString();
      state.pending[change.id] = { ...withoutPayload(change), firstSeen };
      if (!previous[change.id]) {
        await this.notifier.send('warn', `Validation requise : ${change.title} [${change.id}]`, { changeId: change.id });
      }
    }
    // Une approbation ne vaut que pour la version précise : si le changement n'est plus détecté, elle tombe.
    const detected = new Set(decisions.map(({ change }) => change.id));
    state.approved = state.approved.filter((id) => detected.has(id));
  }

  async #execute(change, state) {
    if (!(await this.git.isClean())) {
      await this.notifier.send('warn', `${change.title} : mise à jour annulée, le dépôt contient des modifications manuelles.`);
      return { id: change.id, result: 'dirty-worktree' };
    }

    const previous = await this.git.head();
    try {
      await this.#prepare(change, previous);
    } catch (error) {
      await this.git.restore(previous);
      this.#block(state, change, 'échec de la préparation ou des tests');
      await this.notifier.send('warn', `${change.title} : abandon avant déploiement, production inchangée. ${error.message}`);
      return { id: change.id, result: 'preparation-failed' };
    }

    if ((await this.git.head()) === previous) {
      state.approved = state.approved.filter((id) => id !== change.id);
      delete state.pending[change.id];
      return { id: change.id, result: 'no-change' };
    }

    const failure = await this.#deployAndVerify();
    if (failure) return this.#recover(change, state, previous, failure);

    state.lastKnownGood = await this.git.head();
    state.consecutiveFailures = 0;
    state.approved = state.approved.filter((id) => id !== change.id);
    delete state.pending[change.id];
    state.autoApplied.push(this.now().toISOString());
    await this.notifier.send('success', `Mise à jour déployée : ${change.title}`, { changeId: change.id, sha: state.lastKnownGood });
    await this.#push();
    return { id: change.id, result: 'deployed', sha: state.lastKnownGood };
  }

  async #prepare(change, previous) {
    const detector = DETECTORS.find(({ type }) => type === change.type);
    await detector.module.apply(change, { config: this.config, git: this.git });
    await this.git.commitAll(`chore(site-agent): ${change.title}`);
    await this.#installIfNeeded(previous, 'HEAD');
    await this.#command('test');
    await this.#command('build');
  }

  async #installIfNeeded(from, to) {
    const changed = await this.git.changedFiles(from, to);
    if (changed.some((file) => this.config.site.installTriggers.includes(file))) await this.#command('install');
  }

  async #deployAndVerify() {
    try {
      await this.#command('deploy');
    } catch (error) {
      return error.message;
    }
    const health = await this.#settledProbe();
    return health.healthy ? null : health.reasons.join(' ; ');
  }

  async #recover(change, state, previous, failure) {
    this.#block(state, change, `retirée après échec : ${failure}`);
    state.consecutiveFailures += 1;

    const restored = await this.#rollback(await this.git.head(), previous);
    if (!restored) {
      state.paused = { reason: `retour arrière en échec après ${change.id}`, at: this.now().toISOString() };
      await this.notifier.send('critical', `${change.title} : le retour arrière a échoué, intervention immédiate requise. ${failure}`);
      return { id: change.id, result: 'rollback-failed' };
    }

    await this.notifier.send('warn', `${change.title} : retour arrière effectué. ${failure}`);
    if (state.consecutiveFailures >= this.config.policy.maxConsecutiveFailures) {
      state.paused = { reason: `${state.consecutiveFailures} échecs consécutifs`, at: this.now().toISOString() };
      await this.notifier.send('critical', `Agent mis en pause après ${state.consecutiveFailures} échecs consécutifs.`);
    }
    return { id: change.id, result: 'rolled-back' };
  }

  async #rollback(from, to) {
    try {
      await this.git.restore(to);
      await this.#installIfNeeded(from, to);
      await this.#command('build');
      await this.#command('deploy');
    } catch (error) {
      await this.notifier.send('critical', error.message);
      return false;
    }
    return (await this.#settledProbe()).healthy;
  }

  #block(state, change, reason) {
    state.blocked[change.id] = { reason, at: this.now().toISOString() };
    state.approved = state.approved.filter((id) => id !== change.id);
    delete state.pending[change.id];
  }

  async #push() {
    if (!this.config.site.pushAfterSuccess) return;
    try {
      await this.git.push();
    } catch (error) {
      await this.notifier.send('warn', `Déploiement réussi, mais envoi vers le dépôt distant impossible : ${error.message}`);
    }
  }

  #updateState(task) {
    return this.store.withLock(
      async () => {
        const state = await this.store.load();
        const result = await task(state);
        await this.store.save(state);
        return result;
      },
      { waitMs: 30_000 },
    );
  }

  approve(id, actor = null) {
    return this.#updateState(async (state) => {
      if (!state.pending[id]) throw new Error(`Aucune validation en attente pour ${id}`);
      if (!state.approved.includes(id)) state.approved.push(id);
      await this.notifier.send('info', `Approuvé${byActor(actor)} : ${state.pending[id].title}`, { changeId: id, actor });
    });
  }

  reject(id, actor = null) {
    return this.#updateState(async (state) => {
      const pending = state.pending[id];
      if (!pending) throw new Error(`Aucune validation en attente pour ${id}`);
      this.#block(state, pending, `refusé${byActor(actor) || ' manuellement'}`);
      await this.notifier.send('info', `Refusé${byActor(actor)} : ${pending.title}`, { changeId: id, actor });
    });
  }

  resume(actor = null) {
    return this.#updateState(async (state) => {
      state.paused = null;
      state.consecutiveFailures = 0;
      state.remediations = [];
      await this.notifier.send('info', `Reprise de l'agent demandée${byActor(actor) || ' manuellement'}.`, { actor });
    });
  }

  status() {
    return this.store.load();
  }
}
