import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent.js';
import { normalizeConfig } from '../src/config.js';
import { Notifier } from '../src/notify.js';
import { StateStore } from '../src/state.js';

const INITIAL_CONTENT = {
  title: 'Accueil',
  subtitle: 'Bienvenue',
  price: 10,
  city: 'Paris',
  phone: '0100000000',
  open: true,
  stock: 12,
};

const CHECK_SCRIPT = `const content = JSON.parse(require('fs').readFileSync('content.json', 'utf8'));
process.exit(content.failTests ? 1 : 0);
`;
const DEPLOY_SCRIPT = `require('fs').appendFileSync('deploys.log', 'deploy\\n');
if (JSON.parse(require('fs').readFileSync('content.json', 'utf8')).failDeploy) process.exit(1);
`;
const RESTART_SCRIPT = `require('fs').rmSync('.down', { force: true });
`;

function pretty(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@localhost', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function startSite(siteDir) {
  const server = createServer((request, response) => {
    if (existsSync(path.join(siteDir, '.down'))) {
      response.writeHead(503).end('hors service');
      return;
    }
    try {
      const content = JSON.parse(readFileSync(path.join(siteDir, 'content.json'), 'utf8'));
      if (content.broken) throw new Error('page cassée');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<h1>${content.title}</h1>`);
    } catch {
      response.writeHead(500).end('erreur');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Crée un vrai site local : dépôt Git, dépôt distant, serveur HTTP et source de contenu.
export async function createSandbox({ overrides = {}, now, silent = true, agentOptions = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'site-agent-'));
  const remote = path.join(root, 'remote.git');
  const siteDir = path.join(root, 'site');
  const devDir = path.join(root, 'dev');
  const sourceFile = path.join(root, 'source.json');

  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  execFileSync('git', ['clone', '--quiet', remote, siteDir], { stdio: 'ignore' });
  git(siteDir, 'checkout', '--quiet', '-B', 'main');

  writeFileSync(path.join(siteDir, 'content.json'), pretty(INITIAL_CONTENT));
  writeFileSync(path.join(siteDir, 'check.cjs'), CHECK_SCRIPT);
  writeFileSync(path.join(siteDir, 'deploy.cjs'), DEPLOY_SCRIPT);
  writeFileSync(path.join(siteDir, 'restart.cjs'), RESTART_SCRIPT);
  writeFileSync(path.join(siteDir, '.gitignore'), '.down\ndeploys.log\n');
  git(siteDir, 'add', '-A');
  git(siteDir, 'commit', '--quiet', '-m', 'Site initial');
  git(siteDir, 'push', '--quiet', 'origin', 'main');
  execFileSync('git', ['clone', '--quiet', remote, devDir], { stdio: 'ignore' });
  writeFileSync(sourceFile, pretty(INITIAL_CONTENT));

  const server = await startSite(siteDir);
  const { port } = server.address();

  const raw = {
    dryRun: false,
    stateDir: path.join(root, 'state'),
    site: {
      dir: siteDir,
      pushAfterSuccess: true,
      commands: { test: 'node check.cjs', deploy: 'node deploy.cjs', restart: 'node restart.cjs' },
    },
    health: {
      urls: [`http://127.0.0.1:${port}/`],
      samples: 2,
      intervalMs: 0,
      maxP95LatencyMs: 5000,
      settleSeconds: 0,
    },
    detectors: {
      code: { enabled: true, sensitivePaths: ['^migrations/'] },
      content: {
        enabled: true,
        sources: [{ name: 'accueil', file: sourceFile, target: 'content.json', format: 'json', requiredKeys: ['title'] }],
      },
      incident: { enabled: true, failuresBeforeAction: 2, cooldownMinutes: 0, maxPerDay: 5 },
    },
    policy: {
      rules: [
        { name: 'Petit code', when: { type: 'code', risk: 'low' }, action: 'auto' },
        { name: 'Petit contenu', when: { type: 'content', risk: 'low' }, action: 'auto' },
      ],
    },
    ...overrides,
  };
  const config = normalizeConfig(raw, root);

  const store = new StateStore(config.stateDir);
  const agent = new Agent(config, {
    now,
    notifier: new Notifier({ store, silent, now }),
    ...agentOptions,
  });

  return {
    agent,
    config,
    raw,
    siteDir,
    head: () => git(siteDir, 'rev-parse', 'HEAD'),
    remoteHead: () => git(devDir, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0],
    content: () => JSON.parse(readFileSync(path.join(siteDir, 'content.json'), 'utf8')),
    deployCount: () => {
      const log = path.join(siteDir, 'deploys.log');
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
    },
    setSource: (patch) => writeFileSync(sourceFile, pretty({ ...INITIAL_CONTENT, ...patch })),
    pushCode(file, text) {
      git(devDir, 'pull', '--quiet', 'origin', 'main');
      mkdirSync(path.dirname(path.join(devDir, file)), { recursive: true });
      writeFileSync(path.join(devDir, file), text);
      git(devDir, 'add', '-A');
      git(devDir, 'commit', '--quiet', '-m', `Modifie ${file}`);
      git(devDir, 'push', '--quiet', 'origin', 'main');
      return git(devDir, 'rev-parse', 'HEAD');
    },
    // Casse le site sans passer par l'agent, comme le ferait une intervention extérieure.
    commitBrokenSite() {
      writeFileSync(path.join(siteDir, 'content.json'), pretty({ ...INITIAL_CONTENT, broken: true }));
      git(siteDir, 'add', '-A');
      git(siteDir, 'commit', '--quiet', '-m', 'Modification qui casse le site');
      writeFileSync(sourceFile, pretty({ ...INITIAL_CONTENT, broken: true }));
    },
    takeDown: () => writeFileSync(path.join(siteDir, '.down'), ''),
    dirty: () => writeFileSync(path.join(siteDir, 'modif-manuelle.txt'), 'x'),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
