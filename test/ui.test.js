import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSandbox } from '../demo/sandbox.js';
import { normalizeConfig } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { identityHeaders, loadProxySecret } from '../src/ui/identity.js';
import { createUiServer, isUiRunning } from '../src/ui/server.js';
import { settingsPatch, settingsView } from '../src/ui/settings.js';
import { raw, signedClient } from './support.js';

const DEFAULTS = {
  health: { samples: 1, intervalMs: 0, settleSeconds: 0, maxP95LatencyMs: 5000 },
  detectors: { code: { sensitivePaths: ['^migrations/'] } },
  policy: { rules: [{ name: 'Petit code', when: { type: 'code', risk: 'low' }, action: 'auto' }] },
};

// L'agent tel que Django le voit : chaque personne est un client qui signe son identité avec la clé partagée.
async function withUi(scenario, options = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'site-agent-ui-'));
  writeFileSync(path.join(home, 'agent.defaults.json'), JSON.stringify(DEFAULTS));
  const registry = new Registry(home);
  const server = await createUiServer(registry, { port: 0, log: () => {}, ...options });
  const { origin } = await server.listen();
  const secret = options.requireAuth === false ? null : readFileSync(path.join(registry.dataDir(), 'proxy-secret'), 'utf8');
  const as = (role, username = role) => signedClient(origin, secret, { username, name: `Nom ${username}`, role });
  try {
    await scenario({ origin, secret, registry, as, admin: as('admin', 'alice'), server });
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test('identité : sans signature valide de Django, rien n’est accessible', () =>
  withUi(async ({ origin, secret, admin }) => {
    assert.equal((await admin('GET', '/sites')).status, 200);
    assert.equal((await raw(origin, { path: '/api/sites' })).status, 401, 'sans en-têtes');

    const forged = signedClient(origin, 'une-autre-cle', { username: 'eve', role: 'admin' });
    assert.equal((await forged('GET', '/sites')).status, 401, 'mauvaise clé');

    const late = signedClient(origin, secret, { username: 'eve', role: 'admin' }, { now: () => Date.now() - 5 * 60_000 });
    assert.equal((await late('GET', '/sites')).status, 401, 'signature trop ancienne : pas de rejeu');

    const session = JSON.parse((await raw(origin, { path: '/api/session' })).text);
    assert.equal(session.user, null, 'sans identité, personne n’est connecté');
  }));

test('identité : modifier le rôle ou l’adresse après signature est refusé', () =>
  withUi(async ({ origin, secret }) => {
    const headers = identityHeaders(secret, { method: 'GET', url: '/api/sites', username: 'bob', name: 'Bob', role: 'viewer' });
    assert.equal((await raw(origin, { path: '/api/sites', headers })).status, 200);
    assert.equal((await raw(origin, { path: '/api/sites', headers: { ...headers, 'x-site-agent-role': 'admin' } })).status, 401);
    assert.equal((await raw(origin, { path: '/api/sites/x/settings', headers })).status, 401);
    const post = { method: 'POST', path: '/api/sites', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' };
    assert.equal((await raw(origin, post)).status, 401, 'une signature de lecture ne vaut pas pour une écriture');
  }));

test('rôles : chacun ne peut faire que ce que son rôle permet, côté serveur', async () => {
  const site = await createSandbox();
  try {
    await withUi(async ({ as, admin }) => {
      assert.equal((await admin('POST', '/sites', { name: 'alpha', dir: site.siteDir, urls: [site.config.health.urls[0]] })).status, 200);
      const viewer = as('viewer');
      const operator = as('operator');
      const settings = (await admin('GET', '/sites/alpha/settings')).json;

      const expectations = [
        // [méthode, chemin, corps, lecteur, opérateur, administrateur]
        ['GET', '/sites', undefined, 200, 200, 200],
        ['GET', '/sites/alpha/history', undefined, 200, 200, 200],
        ['POST', '/sites/alpha/run', { simulate: true }, 403, 200, 200],
        ['POST', '/sites/alpha/approve', { id: 'inconnu' }, 403, 400, 400],
        ['POST', '/sites/alpha/resume', {}, 403, 200, 200],
        ['PUT', '/sites/alpha/settings', settings, 403, 403, 200],
        ['POST', '/sites/alpha/mode', { live: false }, 403, 403, 200],
        ['POST', '/inspect', { dir: site.siteDir }, 403, 403, 200],
        ['POST', '/watch', { enabled: false }, 403, 403, 200],
        ['DELETE', '/sites/alpha', undefined, 403, 403, 200],
      ];
      for (const [method, target, body, ...statuses] of expectations) {
        const actual = [];
        for (const person of [viewer, operator, admin]) actual.push((await person(method, target, body)).status);
        assert.deepEqual(actual, statuses, `${method} ${target}`);
      }
    });
  } finally {
    await site.close();
  }
});

test('audit : l’agent décrit chaque action à Django, sans secret', async () => {
  const site = await createSandbox();
  try {
    await withUi(async ({ as, admin }) => {
      const added = await admin('POST', '/sites', {
        name: 'alpha', dir: site.siteDir, urls: [site.config.health.urls[0]], commands: { deploy: 'node deploy.cjs' },
      });
      assert.equal(added.headers['x-site-agent-audit'], 'site.add');
      assert.equal(JSON.parse(decodeURIComponent(added.headers['x-site-agent-audit-details'])).name, 'alpha');
      await admin('POST', '/sites/alpha/mode', { live: true });

      const bob = as('operator', 'bob');
      site.pushCode('migrations/001.sql', 'A;\n');
      const report = (await bob('POST', '/sites/alpha/run', {})).json;
      const approval = await bob('POST', '/sites/alpha/approve', { id: report.decisions[0].id });
      assert.equal(approval.headers['x-site-agent-audit'], 'change.approve');
      assert.equal(decodeURIComponent(approval.headers['x-site-agent-audit-target']), 'alpha');
      assert.equal(decodeURIComponent(approval.headers['x-site-agent-audit-outcome']), 'ok');

      const failed = await admin('POST', '/sites/alpha/approve', { id: 'inconnu' });
      assert.match(decodeURIComponent(failed.headers['x-site-agent-audit-outcome']), /^refusé : /);

      const history = (await bob('GET', '/sites/alpha/history')).json.entries;
      assert.ok(history.some((entry) => entry.message.startsWith('Approuvé par Nom bob')), 'l’historique garde le nom de la personne');
      assert.equal((await bob('GET', '/sites')).headers['x-site-agent-audit'], undefined, 'une lecture n’est pas journalisée');
    });
  } finally {
    await site.close();
  }
});

test('accès : seul un appel local, sans origine étrangère, est accepté', () =>
  withUi(async ({ origin, admin }) => {
    assert.equal((await admin('POST', '/watch', { enabled: false }, { origin: 'https://attaquant.example' })).status, 403);
    // Nom de domaine piégé qui pointe vers 127.0.0.1.
    assert.equal((await admin('GET', '/sites', undefined, { host: 'attaquant.example' })).status, 403);
    assert.equal((await admin('GET', '/sites', undefined, { host: '10.10.10.18:8443' })).status, 403, 'seul Django parle à l’agent');
    // Un formulaire HTML ne peut pas envoyer de JSON.
    assert.equal((await admin('POST', '/watch', undefined, { 'content-type': 'text/plain' })).status, 415);

    const page = await raw(origin, { path: '/' });
    assert.equal(page.status, 200, 'la page ne contient aucune donnée');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
    for (const removed of ['/setup', '/invite']) assert.equal((await raw(origin, { path: removed })).status, 404, removed);
    for (const removed of ['/login', '/users', '/me/password']) {
      assert.equal((await admin('POST', removed, {})).status, 404, `${removed} : les comptes sont gérés par Django`);
    }
  }));

test('parcours complet : associer, simuler, passer en réel, valider, retirer', async () => {
  const site = await createSandbox();
  try {
    await withUi(async ({ admin: call }) => {
      const url = site.config.health.urls[0];

      const inspected = await call('POST', '/inspect', { dir: site.siteDir });
      assert.equal(inspected.json.remote, 'origin');
      assert.equal((await call('POST', '/inspect', { dir: path.join(site.siteDir, 'absent') })).status, 400);
      assert.equal((await call('POST', '/sites', { name: '../x', dir: site.siteDir, urls: [url] })).status, 400);

      const added = await call('POST', '/sites', { name: 'alpha', dir: site.siteDir, urls: [url], commands: { test: 'node check.cjs' } });
      assert.equal(added.status, 200, JSON.stringify(added.json));
      assert.equal((await call('GET', '/sites')).json.sites[0].live, false);

      // Sans déploiement, le mode réel est refusé.
      assert.equal((await call('POST', '/sites/alpha/mode', { live: true })).status, 400);
      const settings = (await call('GET', '/sites/alpha/settings')).json;
      settings.commands.deploy = 'node deploy.cjs';
      assert.equal((await call('PUT', '/sites/alpha/settings', settings)).status, 200);
      assert.equal((await call('POST', '/sites/alpha/mode', { live: true })).status, 200);

      const sensitive = site.pushCode('migrations/001.sql', 'A;\n');
      const before = site.head();
      const simulated = await call('POST', '/sites/alpha/run', { simulate: true });
      assert.equal(simulated.json.dryRun, true);
      assert.equal(site.head(), before);

      const pending = await call('POST', '/sites/alpha/run', {});
      assert.equal(pending.json.decisions[0].outcome, 'awaiting-approval');
      const [summary] = (await call('GET', '/sites')).json.sites;
      assert.equal(summary.pending.length, 1);

      assert.equal((await call('POST', '/sites/alpha/approve', { id: summary.pending[0].id })).status, 200);
      assert.equal((await call('POST', '/sites/alpha/run', {})).json.applied.result, 'deployed');
      assert.equal(site.head(), sensitive);

      assert.equal((await call('DELETE', '/sites/alpha')).status, 200);
      assert.equal((await call('GET', '/sites/alpha/settings')).status, 404);
      assert.equal(site.head(), sensitive, 'retirer un site ne touche pas à ses fichiers');
    });
  } finally {
    await site.close();
  }
});

test('surveillance : démarre et s’arrête depuis l’interface', () =>
  withUi(async ({ admin }) => {
    assert.equal((await admin('POST', '/watch', { enabled: true })).json.watching, true);
    assert.equal((await admin('GET', '/sites')).json.watching, true);
    assert.equal((await admin('POST', '/watch', { enabled: false })).json.watching, false);
  }));

test('démo : ouverte sans compte, mais fermée aux autres sites', () =>
  withUi(async ({ origin }) => {
    const session = JSON.parse((await raw(origin, { path: '/api/session' })).text);
    assert.equal(session.demo, true);
    assert.equal(session.user.role, 'admin');
    assert.equal((await raw(origin, { path: '/api/sites' })).status, 200);
    const foreign = await raw(origin, {
      method: 'POST',
      path: '/api/sites',
      body: '{}',
      headers: { 'content-type': 'application/json', origin: 'https://attaquant.example' },
    });
    assert.equal(foreign.status, 403);
  }, { requireAuth: false }));

test('relance : l’agent déjà lancé est reconnu, un autre programme non', () =>
  withUi(async ({ origin }) => {
    assert.equal(await isUiRunning(new URL(origin).port), true);
    assert.equal(await isUiRunning(1), false);
  }));

test('clé partagée : créée une fois puis conservée', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'site-agent-key-'));
  try {
    const first = await loadProxySecret(path.join(home, '.site-agent'));
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(await loadProxySecret(path.join(home, '.site-agent')), first);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const SETTINGS_BASE = {
  site: { dir: path.resolve('site'), commands: { deploy: 'd' } },
  health: { urls: ['http://x/'] },
  policy: {
    rules: [
      { name: 'a', when: { type: 'dependency', severity: ['critical', 'high'], updateKind: ['patch', 'minor', 'transitive'] }, action: 'auto', bypassWindow: true },
      { name: 'b', when: { type: 'code', risk: 'low' }, action: 'auto' },
    ],
  },
};

test('réglages : le tableau reflète les règles existantes', () => {
  const view = settingsView(normalizeConfig(SETTINGS_BASE));
  assert.equal(view.matrix['dep-security'], 'now');
  assert.equal(view.matrix['code-low'], 'auto');
  assert.equal(view.matrix['code-high'], 'approval', 'sans règle, la valeur par défaut s’applique');
  assert.equal(view.hasCustomRules, false);
});

test('réglages : sans modification, rien n’est écrit et l’héritage est conservé', () => {
  const config = normalizeConfig(SETTINGS_BASE);
  assert.deepEqual(settingsPatch(config, JSON.parse(JSON.stringify(settingsView(config)))), {});
});

test('réglages : une règle personnalisée survit si le tableau ne change pas', () => {
  const custom = { ...SETTINGS_BASE, policy: { rules: [{ when: { type: 'content', source: 'x' }, action: 'deny' }] } };
  const config = normalizeConfig(custom);
  const view = settingsView(config);
  assert.equal(view.hasCustomRules, true);
  assert.deepEqual(settingsPatch(config, JSON.parse(JSON.stringify(view))), {});
});

test('réglages : changer une case régénère des règles équivalentes', () => {
  const config = normalizeConfig(SETTINGS_BASE);
  const view = JSON.parse(JSON.stringify(settingsView(config)));
  view.matrix['code-high'] = 'deny';
  const patch = settingsPatch(config, view);
  const after = settingsView(normalizeConfig({ ...SETTINGS_BASE, policy: patch.policy }));
  assert.equal(after.matrix['code-high'], 'deny');
  assert.equal(after.matrix['dep-security'], 'now', 'les autres cases ne bougent pas');
  assert.equal(after.matrix['code-low'], 'auto');
});

test('réglages : vider une commande la supprime', () => {
  const config = normalizeConfig(SETTINGS_BASE);
  const view = JSON.parse(JSON.stringify(settingsView(config)));
  view.commands.deploy = '  ';
  assert.equal(settingsPatch(config, view).site.commands.deploy, null);
});

test('réglages : l’analyse IA s’active depuis l’interface, avec une adresse valide', () => {
  const config = normalizeConfig(SETTINGS_BASE);
  const view = settingsView(config);
  assert.equal(view.advisorEnabled, false);
  assert.equal(view.advisorModel, 'qwen2.5:7b');
  const patch = settingsPatch(config, { ...view, advisorEnabled: true, advisorModel: 'llama3.1:8b', advisorOnError: 'approval' });
  assert.deepEqual(patch.advisor, { enabled: true, model: 'llama3.1:8b', onError: 'approval' });
  assert.throws(() => settingsPatch(config, { ...view, advisorBaseUrl: 'file:///etc' }), /Adresse d'Ollama invalide/);
  assert.throws(() => settingsPatch(config, { ...view, advisorModel: ' ' }), /modèle Ollama/);
});

test('réglages : les valeurs invalides sont refusées', () => {
  const config = normalizeConfig(SETTINGS_BASE);
  const body = (patch) => ({ ...JSON.parse(JSON.stringify(settingsView(config))), ...patch });
  assert.throws(() => settingsPatch(config, body({ maxAutoPerDay: 'x' })), /Quota/);
  assert.throws(() => settingsPatch(config, body({ matrix: { 'code-low': 'now' } })), /invalide/);
  assert.throws(() => settingsPatch(config, body({ contentEnabled: true, sources: [] })), /source/);
  assert.throws(() => settingsPatch(config, body({ sources: [{ name: 'a', url: 'https://x/', target: '../hors-du-site' }] })), /sort du dossier/);
  assert.throws(() => settingsPatch(config, body({ sources: [{ name: 'a', url: 'file:///etc/passwd', target: 'a' }] })), /invalide/);
  assert.throws(() => normalizeConfig({ ...SETTINGS_BASE, schedule: { windows: [{ start: '25:00', end: '02:00' }] } }), /heures invalides/);
  assert.throws(() => normalizeConfig({ ...SETTINGS_BASE, schedule: { freezes: [{ from: '2027-02-01', to: '2027-01-01' }] } }), /dates invalides/);
});
