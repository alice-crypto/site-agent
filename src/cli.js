#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Agent } from './agent.js';
import { runDaemon } from './daemon.js';
import { Registry } from './registry.js';
import { associateSite, COMMAND_NAMES, DEDICATED_COPY_WARNING } from './site-setup.js';
import { createBackup } from './backup.js';
import { createUiServer, isUiRunning, openInBrowser } from './ui/server.js';
import { startWebAdmin } from './webadmin.js';

const USAGE = `Utilisation : node src/cli.js <commande>

Interface graphique (avec l'administration Django, qui gère les comptes) :
  ui [--no-open]              Ouvre le tableau de bord dans le navigateur

Sur un serveur :
  serve                       Interface et surveillance permanentes, sauvegarde quotidienne
  backup                      Sauvegarde la configuration et l'historique des sites

Les comptes, les groupes et le journal d'audit se gèrent dans l'administration Django, à l'adresse /admin/.

Associer des sites :
  add <site> --dir <dossier> --url <adresse>   Associe un site (toujours en simulation au départ)
      [--branch b] [--remote r] [--install c] [--test c] [--build c] [--deploy c] [--restart c]
  list                     Affiche les sites associés
  live <site>              Passe un site en mode réel
  simulate <site>          Repasse un site en simulation
  remove <site>            Retire un site (son historique est conservé)

Lancer à la demande :
  run <site> [--live | --dry-run]    Un cycle sur un site
  run --all [--dry-run]              Un cycle sur tous les sites
  daemon [site...]                   Surveillance continue de tous les sites, ou de ceux indiqués

Suivre :
  status [site]            État d'un site, ou résumé de tous
  approve <site> <id>      Autorise une mise à jour en attente
  reject <site> <id>       Refuse une mise à jour en attente
  resume <site>            Relance un site mis en pause

Option : --home <dossier> utilise un autre dossier de configuration.`;

function requireArgument(value, label) {
  if (!value) throw new Error(`${label} manquant. Lancez la commande sans argument pour voir l'aide.`);
  return value;
}

function printReport(name, report) {
  const { health } = report;
  console.log(`── ${name} (${report.dryRun ? 'simulation' : 'réel'})`);
  console.log(`Santé : ${health.healthy ? 'bonne' : `dégradée (${health.reasons.join(' ; ')})`}, p95 ${health.p95LatencyMs} ms`);
  if (report.incident) console.log(`Incident : ${report.incident.action}`);
  if (!report.decisions.length) console.log('Aucune mise à jour détectée.');
  for (const { title, risk, outcome, reasons } of report.decisions) {
    console.log(`  [${outcome}] ${title} — risque ${risk} — ${reasons.join(' ; ')}`);
  }
  if (report.applied) console.log(`Résultat : ${report.applied.result} (${report.applied.id})`);
}

async function add(registry, name, values) {
  requireArgument(name, 'Nom du site');
  const commands = Object.fromEntries(COMMAND_NAMES.map((command) => [command, values[command]]));
  const result = await associateSite(registry, name, {
    dir: values.dir,
    urls: values.url,
    branch: values.branch,
    remote: values.remote,
    commands,
  });

  console.log(`Site ${name} associé, en simulation.`);
  console.log(`  Branche : ${result.branch} — dépôt distant : ${result.remote ?? 'aucun'}`);
  for (const command of COMMAND_NAMES) console.log(`  ${command} : ${result.commands[command] ?? '—'}`);
  console.log(`  Dépendances suivies : ${result.tracksDependencies ? 'oui' : 'non'} — code suivi : ${result.tracksCode ? 'oui' : 'non'}`);
  for (const warning of result.warnings) console.log(`Attention : ${warning}`);
}

// L'agent et l'administration Django démarrent ensemble : Django sert l'interface et gère les comptes.
async function startAll(registry) {
  const settings = await registry.uiSettings();
  const server = await createUiServer(registry, { port: settings.port });
  const { origin } = await server.listen();
  const agentPort = Number(new URL(origin).port);
  const web = startWebAdmin({ home: registry.home, agentPort, webPort: settings.webPort, publicUrl: settings.publicUrl });
  const stop = async () => {
    await web.stop();
    await server.close();
  };
  return { origin, web, stop };
}

async function ui(registry, values) {
  const settings = await registry.uiSettings();
  let started;
  try {
    started = await startAll(registry);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    if (!(await isUiRunning(settings.port))) throw new Error(`Le port ${settings.port} est utilisé par une autre application.`);
    // Déjà lancée : on rouvre simplement l'adresse, sans démarrer une seconde interface.
    const url = settings.publicUrl ?? `http://127.0.0.1:${settings.webPort}`;
    console.log(`Site Agent tourne déjà : ${url}`);
    if (!values['no-open']) openInBrowser(url);
    return;
  }
  await started.web.ready;
  console.log(`Site Agent : ${started.web.url}`);
  console.log('Premier lancement ? Créez le compte administrateur : webadmin/.venv/Scripts/python webadmin/manage.py createsuperuser');
  if (!values['no-open']) openInBrowser(started.web.url);

  const stop = async () => {
    await started.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function list(registry) {
  const names = await registry.names();
  if (!names.length) console.log('Aucun site associé. Utilisez la commande « add ».');
  for (const name of names) {
    try {
      const config = await registry.load(name);
      console.log(`${name} — ${config.dryRun ? 'simulation' : 'réel'} — ${config.health.urls.join(', ')} — ${config.site.dir}`);
    } catch (error) {
      console.log(`${name} — configuration invalide : ${error.message}`);
    }
  }
}

async function runOne(registry, name, mode) {
  const config = await registry.load(name);
  if (mode !== null) config.dryRun = mode;
  printReport(name, await new Agent(config).runCycle());
}

async function run(registry, name, values) {
  if (values.live && values['dry-run']) throw new Error('Choisissez --live ou --dry-run, pas les deux.');
  const mode = values.live ? false : values['dry-run'] ? true : null;

  if (!values.all) return runOne(registry, requireArgument(name, 'Nom du site'), mode);

  // --live est refusé ici : passer tous les sites en réel d'un coup doit rester un choix site par site.
  if (values.live) throw new Error('--live ne fonctionne que sur un site nommé. Utilisez « live <site> » pour chacun.');
  let failures = 0;
  for (const siteName of await registry.names()) {
    try {
      await runOne(registry, siteName, mode);
    } catch (error) {
      failures += 1;
      console.error(`── ${siteName} : ${error.message}`);
    }
  }
  if (failures) process.exitCode = 1;
}

const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Mode serveur : lancé par le service Windows, sans navigateur, avec une sauvegarde par jour.
async function serve(registry) {
  const { origin, web, stop: stopAll } = await startAll(registry);
  console.log(`${new Date().toISOString()} Site Agent démarré sur ${origin}, administration sur ${web.url}.`);

  const backup = async () => {
    try {
      console.log(`${new Date().toISOString()} Sauvegarde créée : ${await createBackup(registry.home)}`);
    } catch (error) {
      console.error(`${new Date().toISOString()} Sauvegarde impossible : ${error.message}`);
    }
  };
  await backup();
  const timer = setInterval(backup, BACKUP_INTERVAL_MS);

  const stop = async () => {
    clearInterval(timer);
    await stopAll();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

async function printSiteStatus(registry, name) {
  const agent = new Agent(await registry.load(name));
  const state = await agent.status();
  console.log(`Dernière version saine : ${state.lastKnownGood ?? 'inconnue'}`);
  console.log(`Pause : ${state.paused ? state.paused.reason : 'non'}`);
  console.log('Validations en attente :');
  const pending = Object.values(state.pending);
  if (!pending.length) console.log('  aucune');
  for (const change of pending) {
    const mark = state.approved.includes(change.id) ? ' (approuvé)' : '';
    console.log(`  ${change.id}${mark} — ${change.title}, risque ${change.risk}`);
  }
  console.log('Historique récent :');
  for (const entry of await agent.store.readHistory(10)) console.log(`  ${entry.at} [${entry.level}] ${entry.message}`);
}

async function printSummary(registry) {
  const names = await registry.names();
  if (!names.length) console.log('Aucun site associé.');
  for (const name of names) {
    const config = await registry.load(name);
    const state = await new Agent(config).status();
    const pause = state.paused ? `EN PAUSE (${state.paused.reason})` : 'actif';
    console.log(`${name} — ${config.dryRun ? 'simulation' : 'réel'} — ${pause} — ${Object.keys(state.pending).length} validation(s) en attente`);
  }
}

async function daemon(registry, names) {
  for (const name of names) await registry.load(name);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  console.log("Surveillance démarrée, chaque site dans son propre mode. Ctrl+C pour arrêter.");
  await runDaemon(registry, { only: names.length ? names : null, signal: controller.signal });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      dir: { type: 'string' },
      url: { type: 'string', multiple: true },
      branch: { type: 'string' },
      remote: { type: 'string' },
      install: { type: 'string' },
      test: { type: 'string' },
      build: { type: 'string' },
      deploy: { type: 'string' },
      restart: { type: 'string' },
      all: { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
    },
  });
  const [command, name, argument] = positionals;
  const registry = new Registry(values.home);
  const agentFor = async () => new Agent(await registry.load(requireArgument(name, 'Nom du site')));

  switch (command) {
    case 'ui':
      await ui(registry, values);
      break;
    case 'serve':
      await serve(registry);
      break;
    case 'backup':
      console.log(`Sauvegarde créée : ${await createBackup(registry.home)}`);
      break;
    case 'add':
      await add(registry, name, values);
      break;
    case 'list':
      await list(registry);
      break;
    case 'remove':
      await registry.remove(requireArgument(name, 'Nom du site'));
      console.log(`Site ${name} retiré. Ses fichiers n'ont pas été touchés.`);
      break;
    case 'live':
      await registry.update(requireArgument(name, 'Nom du site'), { dryRun: false });
      console.log(`Site ${name} en mode réel.`);
      console.log(`Attention : ${DEDICATED_COPY_WARNING}`);
      break;
    case 'simulate':
      await registry.update(requireArgument(name, 'Nom du site'), { dryRun: true });
      console.log(`Site ${name} en simulation.`);
      break;
    case 'run':
      await run(registry, name, values);
      break;
    case 'daemon':
      await daemon(registry, positionals.slice(1));
      break;
    case 'status':
      await (name ? printSiteStatus(registry, name) : printSummary(registry));
      break;
    case 'approve':
      await (await agentFor()).approve(requireArgument(argument, 'Identifiant'));
      break;
    case 'reject':
      await (await agentFor()).reject(requireArgument(argument, 'Identifiant'));
      break;
    case 'resume':
      await (await agentFor()).resume();
      break;
    default:
      console.log(USAGE);
      if (command) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
