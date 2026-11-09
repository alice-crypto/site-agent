import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '../demo/sandbox.js';
import { AccountStore, hashPassword, verifyPassword } from '../src/accounts.js';
import { normalizeConfig } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { createUiServer } from '../src/ui/server.js';
import { settingsPatch, settingsView } from '../src/ui/settings.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const PASSWORD = 'un mot de passe solide';
const DEFAULTS = {
  health: { samples: 1, intervalMs: 0, settleSeconds: 0, maxP95LatencyMs: 5000 },
  detectors: { code: { sensitivePaths: ['^migrations/'] } },
  policy: { rules: [{ name: 'Petit code', when: { type: 'code', risk: 'low' }, action: 'auto' }] },
};

// Passe par http.request : fetch interdit de choisir les en-têtes Host et Origin, or ce sont eux qu'on teste.
function raw(origin, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${target}`, { method, headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function cookieFrom(response) {
  return response.headers['set-cookie']?.[0]?.split(';')[0] ?? null;
}

async function withUi(scenario, options = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'site-agent-ui-'));
  writeFileSync(path.join(home, 'agent.defaults.json'), JSON.stringify(DEFAULTS));
  const registry = new Registry(home);
  const server = await createUiServer(registry, { port: 0, log: () => {}, ...options });
  const { origin, loginUrl } = await server.listen();

  // Un client garde son cookie de session, comme un navigateur.
  const client = (cookie = null) => {
    const state = { cookie };
    const call = async (method, target, body, headers = {}) => {
      const response = await raw(origin, {
        method,
        path: `/api${target}`,
        headers: {
          ...(state.cookie ? { cookie: state.cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const fresh = cookieFrom(response);
      if (fresh) state.cookie = fresh;
      let json = {};
      try {
        json = JSON.parse(response.text || '{}');
      } catch {
        json = { text: response.text };
      }
      return { status: response.status, json, headers: response.headers };
    };
    call.state = state;
    return call;
  };

  const setupToken = new URL(loginUrl).searchParams.get('token');
  const admin = client();
  const createAdmin = async () => {
    const result = await admin('POST', '/setup', { token: setupToken, name: 'Alice', email: 'alice@example.com', password: PASSWORD });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return admin;
  };

  // Invite puis active un compte du rôle demandé, et renvoie son client connecté.
  const member = async (role, email = `${role}@example.com`) => {
    const { json } = await admin('POST', '/users', { email, name: role, role });
    const token = new URL(json.inviteUrl).searchParams.get('token');
    const person = client();
    const accepted = await person('POST', '/invite/accept', { token, password: PASSWORD });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    person.id = json.user.id;
    return person;
  };

  try {
    await scenario({ origin, loginUrl, setupToken, registry, client, admin, createAdmin, member, server });
  } finally {
    await server.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test('comptes : empreinte de mot de passe sûre', async () => {
  const stored = await hashPassword(PASSWORD);
  assert.match(stored, /^scrypt\$/);
  assert.ok(!stored.includes(PASSWORD));
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword('autre chose encore', stored), false);
  assert.notEqual(await hashPassword(PASSWORD), stored, 'chaque empreinte a son propre sel');
});

test('installation : le premier administrateur se crée une seule fois, avec le lien', () =>
  withUi(async ({ client, setupToken, registry, admin }) => {
    const anonymous = client();
    assert.equal((await anonymous('GET', '/session')).json.setupRequired, true);
    assert.equal((await anonymous('POST', '/setup', { token: 'faux', email: 'x@y.fr', password: PASSWORD })).status, 403);
    assert.equal((await anonymous('POST', '/setup', { token: setupToken, email: 'x@y.fr', password: 'court' })).status, 400);

    const created = await admin('POST', '/setup', { token: setupToken, name: 'Alice', email: 'alice@example.com', password: PASSWORD });
    assert.equal(created.status, 200);
    assert.equal(created.json.user.role, 'admin');
    assert.equal((await admin('GET', '/session')).json.user.email, 'alice@example.com');
    assert.equal(existsSync(path.join(registry.dataDir(), 'ui-token')), false, 'le lien d’installation est détruit');

    assert.equal((await client()('POST', '/setup', { token: setupToken, email: 'eve@y.fr', password: PASSWORD })).status, 403);
    assert.equal((await client()('GET', '/session')).json.setupRequired, false);

    const users = JSON.parse(readFileSync(path.join(registry.dataDir(), 'users.json'), 'utf8'));
    assert.ok(!JSON.stringify(users).includes(PASSWORD), 'aucun mot de passe en clair sur le disque');
  }));

test('connexion : bon et mauvais mot de passe, déconnexion', () =>
  withUi(async ({ client, createAdmin }) => {
    await createAdmin();
    const person = client();
    assert.equal((await person('GET', '/sites')).status, 401);
    const wrong = await person('POST', '/login', { email: 'alice@example.com', password: 'mauvais mot de passe' });
    assert.equal(wrong.status, 401);
    const unknown = await person('POST', '/login', { email: 'inconnu@example.com', password: PASSWORD });
    assert.equal(unknown.json.error, wrong.json.error, 'même message : on ne révèle pas quels comptes existent');

    const ok = await person('POST', '/login', { email: 'ALICE@example.com ', password: PASSWORD });
    assert.equal(ok.status, 200);
    const header = ok.headers['set-cookie'][0];
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.doesNotMatch(header, /Secure/);
    assert.equal((await person('GET', '/sites')).status, 200);

    const stolen = person.state.cookie;
    await person('POST', '/logout', {});
    assert.equal((await client(stolen)('GET', '/sites')).status, 401, 'la session est détruite côté serveur');
  }));

test('connexion : cookie Secure derrière HTTPS', () =>
  withUi(async ({ client, createAdmin }) => {
    await createAdmin();
    const response = await client()('POST', '/login', { email: 'alice@example.com', password: PASSWORD }, { 'x-forwarded-proto': 'https' });
    assert.match(response.headers['set-cookie'][0], /Secure/);
  }));

test('connexion : blocage après 5 échecs, même avec le bon mot de passe', () =>
  withUi(async ({ client, createAdmin }) => {
    await createAdmin();
    const attacker = client();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await attacker('POST', '/login', { email: 'alice@example.com', password: `essai ${attempt} raté` })).status, 401);
    }
    assert.equal((await attacker('POST', '/login', { email: 'alice@example.com', password: PASSWORD })).status, 429);
  }));

test('rôles : chacun ne peut faire que ce que son rôle permet, côté serveur', async () => {
  const site = await createSandbox();
  try {
    await withUi(async ({ createAdmin, member }) => {
      const admin = await createAdmin();
      assert.equal((await admin('POST', '/sites', { name: 'alpha', dir: site.siteDir, urls: [site.config.health.urls[0]] })).status, 200);
      const viewer = await member('viewer');
      const operator = await member('operator');
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
        ['GET', '/users', undefined, 403, 403, 200],
        ['POST', '/users', { email: 'x@example.com', role: 'admin' }, 403, 403, 200],
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

test('invitations : usage unique, expiration, mot de passe exigeant', async () => {
  let current = new Date('2026-11-09T10:00:00Z');
  await withUi(async ({ admin, createAdmin, client }) => {
    await createAdmin();
    const { json } = await admin('POST', '/users', { email: 'bob@example.com', name: 'Bob', role: 'operator' });
    const token = new URL(json.inviteUrl).searchParams.get('token');
    assert.equal(json.user.pending, true);
    assert.equal((await admin('POST', '/users', { email: 'bob@example.com', role: 'viewer' })).status, 400, 'pas de doublon');
    assert.equal((await admin('POST', '/users', { email: 'pas-une-adresse', role: 'viewer' })).status, 400);
    assert.equal((await admin('POST', '/users', { email: 'c@example.com', role: 'superadmin' })).status, 400);

    const bob = client();
    assert.equal((await bob('POST', '/invite/check', { token })).json.user.email, 'bob@example.com');
    assert.equal((await bob('POST', '/invite/accept', { token, password: 'court' })).status, 400);
    assert.equal((await bob('POST', '/invite/accept', { token, password: PASSWORD })).status, 200);
    assert.equal((await bob('GET', '/session')).json.user.role, 'operator');
    assert.equal((await client()('POST', '/invite/accept', { token, password: PASSWORD })).status, 400, 'lien à usage unique');

    const late = await admin('POST', '/users', { email: 'carol@example.com', role: 'viewer' });
    const lateToken = new URL(late.json.inviteUrl).searchParams.get('token');
    current = new Date('2026-11-11T11:00:00Z');
    assert.equal((await client()('POST', '/invite/accept', { token: lateToken, password: PASSWORD })).status, 400, 'expiré après 48 h');
  }, { now: () => current });
});

test('comptes : désactivation et changement de rôle immédiats', () =>
  withUi(async ({ admin, createAdmin, member }) => {
    await createAdmin();
    const bob = await member('operator', 'bob@example.com');
    assert.equal((await bob('POST', '/sites/x/resume', {})).status, 404, 'rôle suffisant, site inconnu');

    await admin('POST', `/users/${bob.id}`, { role: 'viewer' });
    assert.equal((await bob('POST', '/sites/x/resume', {})).status, 403, 'le nouveau rôle s’applique sans reconnexion');

    await admin('POST', `/users/${bob.id}`, { disabled: true });
    assert.equal((await bob('GET', '/sites')).status, 401, 'déconnecté immédiatement');
    assert.equal((await bob('POST', '/login', { email: 'bob@example.com', password: PASSWORD })).status, 401);
  }));

test('comptes : il reste toujours un administrateur actif', () =>
  withUi(async ({ admin, createAdmin }) => {
    await createAdmin();
    const { json } = await admin('GET', '/users');
    const self = json.users[0].id;
    assert.equal((await admin('POST', `/users/${self}`, { role: 'viewer' })).status, 400);
    assert.equal((await admin('POST', `/users/${self}`, { disabled: true })).status, 400);
  }));

test('mot de passe : le changer déconnecte les autres sessions', () =>
  withUi(async ({ admin, createAdmin, client }) => {
    await createAdmin();
    const otherDevice = client();
    await otherDevice('POST', '/login', { email: 'alice@example.com', password: PASSWORD });

    assert.equal((await admin('POST', '/me/password', { current: 'faux mot de passe', next: 'nouveau mot de passe solide' })).status, 400);
    assert.equal((await admin('POST', '/me/password', { current: PASSWORD, next: 'nouveau mot de passe solide' })).status, 200);
    assert.equal((await admin('GET', '/sites')).status, 200, 'la session courante continue');
    assert.equal((await otherDevice('GET', '/sites')).status, 401);
    assert.equal((await client()('POST', '/login', { email: 'alice@example.com', password: PASSWORD })).status, 401);
  }));

test('audit : chaque action garde son auteur, jamais de mot de passe', async () => {
  const site = await createSandbox();
  try {
    await withUi(async ({ admin, createAdmin, member, client, registry }) => {
      await createAdmin();
      await admin('POST', '/sites', { name: 'alpha', dir: site.siteDir, urls: [site.config.health.urls[0]], commands: { deploy: 'node deploy.cjs' } });
      await admin('POST', '/sites/alpha/mode', { live: true });
      const bob = await member('operator', 'bob@example.com');
      site.pushCode('migrations/001.sql', 'A;\n');
      const report = (await bob('POST', '/sites/alpha/run', {})).json;
      assert.equal((await bob('POST', '/sites/alpha/approve', { id: report.decisions[0].id })).status, 200);
      await client()('POST', '/login', { email: 'alice@example.com', password: 'tentative ratée ici' });

      const lines = readFileSync(path.join(registry.dataDir(), 'audit.jsonl'), 'utf8');
      const entries = lines.trim().split('\n').map((line) => JSON.parse(line));
      const approval = entries.find((entry) => entry.action === 'change.approve');
      assert.equal(approval.user, 'bob@example.com');
      assert.equal(approval.target, 'alpha');
      assert.ok(entries.some((entry) => entry.action === 'login' && entry.user === 'alice@example.com' && entry.outcome.startsWith('refusé')));
      assert.ok(!lines.includes(PASSWORD) && !lines.includes('tentative ratée'), 'aucun mot de passe dans le journal');

      const history = (await bob('GET', '/sites/alpha/history')).json.entries;
      assert.ok(history.some((entry) => entry.message.startsWith('Approuvé par operator')));
    });
  } finally {
    await site.close();
  }
});

test('accès : un autre site ne peut pas piloter l’agent', () =>
  withUi(async ({ origin, admin, createAdmin }) => {
    await createAdmin();
    const add = { method: 'POST', path: '/api/sites', body: '{}', headers: { cookie: admin.state.cookie, 'content-type': 'application/json' } };
    assert.equal((await raw(origin, { ...add, headers: { ...add.headers, origin: 'https://attaquant.example' } })).status, 403);
    // Nom de domaine piégé qui pointe vers 127.0.0.1.
    assert.equal((await raw(origin, { ...add, headers: { ...add.headers, host: 'attaquant.example' } })).status, 403);
    // Un formulaire HTML ne peut pas envoyer de JSON.
    assert.equal((await raw(origin, { ...add, headers: { cookie: admin.state.cookie, 'content-type': 'text/plain' } })).status, 415);

    const page = await raw(origin, { path: '/' });
    assert.equal(page.status, 200, 'la page de connexion est publique, sans aucune donnée');
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
  }));

test('accès : l’adresse publique configurée est acceptée', () =>
  withUi(async ({ origin, client, createAdmin }) => {
    await createAdmin();
    const response = await raw(origin, { path: '/api/session', headers: { host: 'agent.example.fr' } });
    assert.equal(response.status, 200);
    const invite = await client()('POST', '/login', { email: 'x', password: 'y' }, { host: 'autre.example.fr' });
    assert.equal(invite.status, 403);
  }, { publicUrl: 'https://agent.example.fr' }));

test('parcours complet : associer, simuler, passer en réel, valider, retirer', async () => {
  const site = await createSandbox();
  try {
    await withUi(async ({ admin: call, createAdmin }) => {
      await createAdmin();
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
  withUi(async ({ admin, createAdmin }) => {
    await createAdmin();
    assert.equal((await admin('POST', '/watch', { enabled: true })).json.watching, true);
    assert.equal((await admin('GET', '/sites')).json.watching, true);
    assert.equal((await admin('POST', '/watch', { enabled: false })).json.watching, false);
  }));

test('démo : ouverte sans compte, mais fermée aux autres sites', () =>
  withUi(async ({ origin, loginUrl, client }) => {
    assert.equal(loginUrl, origin);
    const session = (await client()('GET', '/session')).json;
    assert.equal(session.demo, true);
    assert.equal(session.user.role, 'admin');
    assert.equal((await client()('GET', '/sites')).status, 200);
    const foreign = await raw(origin, {
      method: 'POST',
      path: '/api/sites',
      body: '{}',
      headers: { 'content-type': 'application/json', origin: 'https://attaquant.example' },
    });
    assert.equal(foreign.status, 403);
  }, { requireAuth: false }));

test('relance : l’interface déjà ouverte redonne son adresse, un autre programme ne reçoit rien', () =>
  withUi(async ({ origin, loginUrl, registry }) => {
    const relaunch = (port) => new Promise((resolve) => {
      execFile(process.execPath, [CLI, 'ui', '--no-open', '--port', port, '--home', registry.home], { timeout: 20000 }, (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, output: stdout + stderr });
      });
    });
    const other = createServer((_, response) => response.end('autre application'));
    await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
    try {
      const again = await relaunch(new URL(origin).port);
      assert.equal(again.code, 0, again.output);
      assert.ok(again.output.includes(loginUrl), 'premier lancement : le lien d’installation est redonné');

      const refused = await relaunch(String(other.address().port));
      assert.equal(refused.code, 1);
      assert.doesNotMatch(refused.output, /token=/);
    } finally {
      other.close();
    }
  }));

test('ligne de commande : inviter et désactiver un compte en secours', () =>
  withUi(async ({ registry, createAdmin, client }) => {
    await createAdmin();
    const cli = (...args) => new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args, '--home', registry.home], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, output: stdout + stderr }));
    });
    const added = await cli('user', 'add', 'dan@example.com', '--role', 'viewer', '--name', 'Dan');
    assert.equal(added.code, 0, added.output);
    const token = /token=([\w-]+)/.exec(added.output)[1];
    assert.equal((await client()('POST', '/invite/accept', { token, password: PASSWORD })).status, 200);
    assert.match((await cli('user', 'list')).output, /dan@example\.com — Dan — Lecteur — actif/);
    assert.equal((await cli('user', 'disable', 'dan@example.com')).code, 0);
    assert.equal((await client()('POST', '/login', { email: 'dan@example.com', password: PASSWORD })).status, 401);
    assert.equal((await cli('user', 'disable', 'alice@example.com')).code, 1, 'dernier administrateur protégé');
  }));

test('comptes : écritures simultanées sans perte', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'site-agent-accounts-'));
  try {
    const accounts = new AccountStore(dir);
    await Promise.all(Array.from({ length: 10 }, (_, index) => accounts.invite({ email: `p${index}@example.com`, role: 'viewer' })));
    assert.equal(await accounts.count(), 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
