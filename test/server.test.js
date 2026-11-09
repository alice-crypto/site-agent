import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBackup } from '../src/backup.js';
import { redactGitUrl, validateGitUrl } from '../src/git-clone.js';
import { Registry } from '../src/registry.js';
import { createUiServer } from '../src/ui/server.js';
import { signedClient } from './support.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'cli.js');

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function cli(home, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args, '--home', home], { timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, output: stdout + stderr });
    });
  });
}

// Un dépôt source, comme celui d'un site sur GitHub, mais local.
function createSourceRepository() {
  const dir = tempDir('site-agent-source-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  git('init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(dir, 'index.html'), '<h1>Bonjour</h1>\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'init');
  return { dir, url: pathToFileURL(dir).href.replace(/^file:\/\/(?!\/)/, 'file:///') };
}

async function withServer(home, options, scenario) {
  const registry = new Registry(home);
  const server = await createUiServer(registry, { port: 0, log: () => {}, ...options });
  const { origin } = await server.listen();
  const call = signedClient(origin, readFileSync(path.join(registry.dataDir(), 'proxy-secret'), 'utf8'), { username: 'admin', role: 'admin' });
  try {
    await scenario(call);
  } finally {
    await server.close();
  }
}

test('adresse Git : seules les adresses HTTPS et SSH sont acceptées', () => {
  assert.equal(validateGitUrl('git@github.com:equipe/site.git'), 'git@github.com:equipe/site.git');
  assert.equal(validateGitUrl('https://github.com/equipe/site.git'), 'https://github.com/equipe/site.git');
  assert.equal(validateGitUrl('ssh://git@exemple.fr:2222/site.git'), 'ssh://git@exemple.fr:2222/site.git');
  for (const dangerous of ['--upload-pack=calc.exe', 'ext::sh -c touch% /tmp/x', 'file:///C:/secret', 'http://exemple.fr/site.git', 'C:\\depot', '']) {
    assert.throws(() => validateGitUrl(dangerous), /non acceptée/, dangerous);
  }
  assert.equal(redactGitUrl('https://jean:ghp_secret@github.com/a/b.git'), 'https://***@github.com/a/b.git');
});

test('ajout par adresse Git : copie dédiée créée, puis retirée si l’ajout échoue', async () => {
  const home = tempDir('site-agent-home-');
  const sitesRoot = path.join(home, 'checkouts');
  const source = createSourceRepository();
  try {
    await withServer(home, { gitProtocols: ['https', 'ssh', 'file'], sitesRoot }, async (call) => {
      const added = await call('POST', '/sites', { name: 'vitrine', gitUrl: source.url, urls: ['https://vitrine.example.fr'] });
      assert.equal(added.status, 200, JSON.stringify(added.json));
      assert.equal(added.json.dir, path.join(sitesRoot, 'vitrine'));
      assert.ok(existsSync(path.join(sitesRoot, 'vitrine', 'index.html')));
      assert.equal(added.json.remote, 'origin');

      const [site] = (await call('GET', '/sites')).json.sites;
      assert.equal(site.name, 'vitrine');
      assert.equal(site.live, false, 'un site ajouté démarre en simulation');

      assert.equal((await call('POST', '/sites', { name: 'vitrine', gitUrl: source.url, urls: ['https://x.fr'] })).status, 400, 'nom déjà pris');
      assert.equal((await call('POST', '/sites', { name: '../evade', gitUrl: source.url, urls: ['https://x.fr'] })).status, 400);
      assert.equal((await call('POST', '/sites', { name: 'piege', gitUrl: '--upload-pack=calc.exe', urls: ['https://x.fr'] })).status, 400);

      const missing = await call('POST', '/sites', { name: 'absent', gitUrl: `${source.url}-inexistant`, urls: ['https://x.fr'] });
      assert.equal(missing.status, 400);
      assert.match(missing.json.error, /Clonage impossible/);
      assert.ok(!existsSync(path.join(sitesRoot, 'absent')), 'pas de copie à moitié faite');

      const noUrl = await call('POST', '/sites', { name: 'sansurl', gitUrl: source.url, urls: [] });
      assert.equal(noUrl.status, 400);
      assert.ok(!existsSync(path.join(sitesRoot, 'sansurl')), 'copie retirée si l’association échoue');
    });

    // Sans configuration particulière, une adresse locale est refusée.
    await withServer(home, { sitesRoot }, async (call) => {
      assert.equal((await call('POST', '/sites', { name: 'local', gitUrl: source.url, urls: ['https://x.fr'] })).status, 400);
    });
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(source.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('surveillance : reprise automatique après redémarrage', async () => {
  const home = tempDir('site-agent-home-');
  try {
    await withServer(home, {}, async (call) => {
      assert.equal((await call('POST', '/watch', { enabled: true })).json.watching, true);
    });
    await withServer(home, {}, async (call) => {
      assert.equal((await call('GET', '/sites')).json.watching, true, 'reprise après redémarrage');
      await call('POST', '/watch', { enabled: false });
    });
    await withServer(home, {}, async (call) => {
      assert.equal((await call('GET', '/sites')).json.watching, false, 'l’arrêt est aussi conservé');
    });
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('sauvegarde : configuration et historique, sans verrou ni clés', async () => {
  const home = tempDir('site-agent-home-');
  try {
    writeFileSync(path.join(home, 'agent.defaults.json'), '{}');
    mkdirSync(path.join(home, 'sites'));
    writeFileSync(path.join(home, 'sites', 'vitrine.json'), '{}');
    mkdirSync(path.join(home, '.site-agent', 'vitrine'), { recursive: true });
    for (const file of ['watch.json', 'lock', 'proxy-secret', 'django-secret-key']) writeFileSync(path.join(home, '.site-agent', file), 'x');
    writeFileSync(path.join(home, '.site-agent', 'vitrine', 'history.jsonl'), 'x');

    const target = await createBackup(home, { now: new Date('2026-11-09T10:00:00Z') });
    for (const kept of ['agent.defaults.json', 'sites/vitrine.json', '.site-agent/watch.json', '.site-agent/vitrine/history.jsonl']) {
      assert.ok(existsSync(path.join(target, kept)), kept);
    }
    for (const skipped of ['.site-agent/lock', '.site-agent/proxy-secret', '.site-agent/django-secret-key']) assert.ok(!existsSync(path.join(target, skipped)), skipped);

    for (let day = 10; day < 14; day += 1) await createBackup(home, { keep: 3, now: new Date(`2026-11-${day}T10:00:00Z`) });
    const remaining = readdirSync(path.join(home, 'backups')).sort();
    assert.equal(remaining.length, 3, 'seules les plus récentes sont gardées');
    assert.match(remaining.at(-1), /^2026-11-13/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('serve : démarre sans navigateur, lance l’administration, répond et sauvegarde', async () => {
  const home = tempDir('site-agent-home-');
  writeFileSync(path.join(home, 'agent.defaults.json'), JSON.stringify({ ui: { port: 0, webPort: 0 } }));
  // Un faux Python : on vérifie que l'agent lance l'administration, pas Django lui-même.
  const fakePython = path.join(home, 'fake-python.cmd');
  writeFileSync(fakePython, ['@echo Administration Django prête %*', '@ping -n 30 127.0.0.1 >nul', ''].join('\r\n'));
  const child = spawn(process.execPath, [CLI, 'serve', '--home', home], { env: { ...process.env, SITE_AGENT_PYTHON: fakePython } });
  try {
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100 && !(output.includes('Sauvegarde créée') && output.includes('[admin]')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const origin = /démarré sur (http:\/\/[\d.]+:\d+)/.exec(output)?.[1];
    assert.ok(origin, output);
    assert.match(output, /\[admin\] Administration Django pr.{1,2}te .*manage\.py serve --port 0/);
    const session = await (await fetch(`${origin}/api/session`)).json();
    assert.equal(session.service, 'site-agent');
    assert.equal(session.user, null, 'sans identité signée par Django, personne n’est connecté');
    assert.ok(existsSync(path.join(home, '.site-agent', 'proxy-secret')), 'la clé partagée est créée');
    assert.equal(readdirSync(path.join(home, 'backups')).length, 1);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('scripts Windows : syntaxe PowerShell valide', { skip: process.platform !== 'win32' && 'Windows uniquement' }, () => {
  for (const script of ['install.ps1', 'uninstall.ps1']) {
    const file = path.join(ROOT, 'deploy', 'windows', script);
    const command = `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e); $e.Count`;
    const errors = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim();
    assert.equal(errors, '0', script);
  }
});
