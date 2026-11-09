import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '../demo/sandbox.js';
import { runDaemon } from '../src/daemon.js';
import { Registry, SiteNotFoundError } from '../src/registry.js';
import { suggestCommands } from '../src/site-inspector.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const FAST_DEFAULTS = {
  health: { samples: 1, intervalMs: 0, settleSeconds: 0, maxP95LatencyMs: 5000 },
  schedule: { healthIntervalSeconds: 0.05, detectIntervalMinutes: 0 },
  policy: { rules: [{ name: 'Petit code', when: { type: 'code', risk: 'low' }, action: 'auto' }] },
};

function createHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'site-agent-home-'));
  writeFileSync(path.join(home, 'agent.defaults.json'), JSON.stringify(FAST_DEFAULTS));
  return home;
}

function cli(home, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args, '--home', home], (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, output: stdout + stderr });
    });
  });
}

async function waitFor(condition, label) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) return;
    await delay(100);
  }
  assert.fail(`Délai dépassé : ${label}`);
}

test('registre : noms, doublons et mode réel sont contrôlés', async () => {
  const home = createHome();
  const registry = new Registry(home);
  const raw = { site: { dir: 'a' }, health: { urls: ['http://x/'] } };
  try {
    await assert.rejects(registry.add('../evil', raw), /invalide/);
    await assert.rejects(registry.load('../evil'), /invalide/);
    await assert.rejects(registry.add('b', { ...raw, health: { urls: ['ftp://x'] } }), /adresse invalide/);

    await registry.add('alpha', raw);
    await assert.rejects(registry.add('alpha', raw), /existe déjà/);
    await assert.rejects(registry.add('beta', raw), /déjà associé au site alpha/);

    await assert.rejects(registry.update('alpha', { dryRun: false }), /deploy/);
    assert.equal((await registry.load('alpha')).dryRun, true, 'un refus ne doit rien écrire');

    const config = await registry.load('alpha');
    assert.equal(config.name, 'alpha');
    assert.equal(path.basename(config.stateDir), 'alpha');
    assert.equal(config.policy.rules.length, 1, 'les règles communes sont héritées');

    await registry.remove('alpha');
    await assert.rejects(registry.load('alpha'), SiteNotFoundError);
    assert.deepEqual(await registry.names(), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('analyse : commandes proposées depuis package.json', () => {
  assert.deepEqual(suggestCommands(null, false), {});
  assert.deepEqual(
    suggestCommands({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'x', deploy: 'y' } }, true),
    { install: 'npm ci', build: 'npm run build', deploy: 'npm run deploy' },
  );
  assert.deepEqual(suggestCommands({ scripts: { test: 'vitest' } }, false), { install: 'npm install', test: 'npm test' });
});

test('ligne de commande : associer, simuler, passer en réel, retirer', async () => {
  const home = createHome();
  const site = await createSandbox();
  const url = site.config.health.urls[0];
  try {
    const added = await cli(home, 'add', 'alpha', '--dir', site.siteDir, '--url', url, '--deploy', 'node deploy.cjs', '--test', 'node check.cjs');
    assert.equal(added.code, 0, added.output);
    assert.match(added.output, /en simulation/);
    assert.match(added.output, /git reset --hard/);

    assert.equal((await cli(home, 'add', 'bis', '--dir', site.siteDir, '--url', url)).code, 1);
    assert.equal((await cli(home, 'add', 'x', '--dir', path.join(home, 'absent'), '--url', url)).code, 1);
    assert.equal((await cli(home, 'add', 'x', '--dir', home, '--url', url)).code, 1, 'un dossier sans Git est refusé');

    const before = site.head();
    const sha = site.pushCode('page.html', '<p>Bonjour</p>\n');

    const simulated = await cli(home, 'run', 'alpha');
    assert.match(simulated.output, /simulation/);
    assert.match(simulated.output, /\[apply\]/);
    assert.equal(site.head(), before, 'la simulation ne modifie rien');

    assert.equal((await cli(home, 'run', '--all', '--live')).code, 1, 'pas de passage en réel global');

    assert.equal((await cli(home, 'live', 'alpha')).code, 0);
    assert.match((await cli(home, 'list')).output, /alpha — réel/);

    const deployed = await cli(home, 'run', '--all');
    assert.match(deployed.output, /Résultat : deployed/);
    assert.equal(site.head(), sha);

    assert.match((await cli(home, 'status')).output, /alpha — réel — actif — 0 validation/);
    assert.match((await cli(home, 'status', 'alpha')).output, /Mise à jour déployée/);

    assert.equal((await cli(home, 'remove', 'alpha')).code, 0);
    assert.equal((await cli(home, 'run', 'alpha')).code, 1);
    assert.equal(site.head(), sha, 'retirer un site ne touche pas à ses fichiers');
  } finally {
    await site.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('surveillance : sites indépendants, ajout et retrait sans redémarrage', async () => {
  const home = createHome();
  const registry = new Registry(home);
  const [healthy, down, late] = await Promise.all([createSandbox(), createSandbox(), createSandbox()]);
  const controller = new AbortController();
  const logs = [];
  const registerRaw = (site) => ({ ...site.raw, stateDir: undefined });
  try {
    await registry.add('sain', registerRaw(healthy));
    await registry.add('panne', { ...registerRaw(down), site: { ...down.raw.site, commands: { deploy: 'node deploy.cjs' } } });
    down.takeDown();
    const first = healthy.pushCode('page.html', 'a\n');

    const daemon = runDaemon(registry, {
      signal: controller.signal,
      refreshMs: 100,
      log: (line) => logs.push(line),
      agentOptions: { silent: true },
    });

    await waitFor(() => healthy.head() === first, 'le site sain est mis à jour malgré la panne de l’autre');
    assert.equal(down.deployCount(), 0);

    // Associé pendant que l'agent tourne.
    const lateSha = late.pushCode('page.html', 'b\n');
    await registry.add('tardif', registerRaw(late));
    await waitFor(() => late.head() === lateSha, 'le site ajouté est pris en charge sans redémarrage');

    // Retiré pendant que l'agent tourne.
    await registry.remove('sain');
    await waitFor(() => logs.includes('Fin de la surveillance de sain.'), 'le site retiré n’est plus surveillé');
    const frozen = healthy.head();
    healthy.pushCode('page.html', 'c\n');
    await delay(500);
    assert.equal(healthy.head(), frozen);

    controller.abort();
    await daemon;
  } finally {
    controller.abort();
    await Promise.all([healthy.close(), down.close(), late.close()]);
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
