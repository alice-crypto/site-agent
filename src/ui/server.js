import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '../agent.js';
import { runDaemon } from '../daemon.js';
import { probe } from '../health.js';
import { SiteNotFoundError } from '../registry.js';
import { cloneRepository, redactGitUrl } from '../git-clone.js';
import { associateSite } from '../site-setup.js';
import { inspectSite } from '../site-inspector.js';
import { LockBusyError } from '../state.js';
import { hasRole, loadProxySecret, verifyIdentity } from './identity.js';
import { settingsPatch, settingsView } from './settings.js';

export const DEFAULT_UI_PORT = 4310;

const SERVICE = 'site-agent';
const MAX_BODY_BYTES = 1024 * 1024;
const HEALTH_MAX_AGE_MS = 30_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const INDEX = ['index.html', 'text/html; charset=utf-8'];
const STATIC_FILES = {
  '/': INDEX,
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
// Seuls ces champs entrent dans le journal d'audit : jamais un secret.
const AUDITED_FIELDS = ['id', 'name', 'live', 'simulate', 'enabled', 'dir'];
const DEMO_USER = { id: 'demo', name: 'Démo', role: 'admin' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Requête trop volumineuse.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'JSON invalide.'));
      }
    });
    request.on('error', reject);
  });
}

export function openInBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

// Vrai si le port est occupé par cette interface et non par une autre application.
export async function isUiRunning(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) });
    return (await response.json()).service === SERVICE;
  } catch {
    return false;
  }
}

// Les comptes sont ceux de l'administration Django, qui sert seule l'interface et signe l'identité de chaque requête.
// requireAuth à false est réservé à la démo, dont les sites sont factices : tout le monde y est administrateur.
export async function createUiServer(
  registry,
  {
    host = '127.0.0.1',
    port = DEFAULT_UI_PORT,
    log = console.log,
    requireAuth = true,
    now = () => new Date(),
    sitesRoot = path.join(registry.home, 'checkouts'),
    gitProtocols = ['https', 'ssh'],
    // Options passées à chaque agent : la démo y branche une analyse IA simulée.
    agentOptions = {},
  } = {},
) {
  const dataDir = registry.dataDir();
  const watchFile = path.join(dataDir, 'watch.json');
  const secret = requireAuth ? await loadProxySecret(dataDir) : null;

  const reports = new Map();
  const healthCache = new Map();
  const healthInFlight = new Set();
  const busy = new Set();
  let watcher = null;
  let activePort = port;

  /* Contrôles d'accès */

  // Bloque un site malveillant qui viserait ce serveur, directement ou par un nom de domaine piégé.
  // Seul Django, sur la même machine, s'adresse à l'agent.
  function isAllowedRequest(request) {
    const requestHost = request.headers.host ?? '';
    if (!LOCAL_HOSTS.has(requestHost.replace(/:\d+$/, ''))) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === requestHost;
    } catch {
      return false;
    }
  }

  function currentUser(request) {
    return requireAuth ? verifyIdentity(request, secret, now().getTime()) : DEMO_USER;
  }

  /* Sites */

  const remember = (name, report) => {
    reports.set(name, { at: now().toISOString(), report });
    healthCache.set(name, { at: Date.now(), ...report.health });
  };

  function refreshHealth(name, config) {
    const cached = healthCache.get(name);
    if (healthInFlight.has(name) || (cached && Date.now() - cached.at < HEALTH_MAX_AGE_MS)) return;
    healthInFlight.add(name);
    probe({ ...config.health, samples: 1 }, { sleep: async () => {} })
      .then((health) => healthCache.set(name, { at: Date.now(), ...health }))
      .finally(() => healthInFlight.delete(name));
  }

  async function siteSummary(name) {
    let config;
    try {
      config = await registry.load(name);
    } catch (error) {
      return { name, invalid: error.message };
    }
    refreshHealth(name, config);
    const state = await new Agent(config).status();
    return {
      name,
      live: !config.dryRun,
      urls: config.health.urls,
      dir: config.site.dir,
      branch: config.site.branch,
      hasDeploy: Boolean(config.site.commands.deploy),
      busy: busy.has(name),
      health: healthCache.get(name) ?? null,
      paused: state.paused,
      healthFailures: state.healthFailures,
      lastKnownGood: state.lastKnownGood,
      pending: Object.values(state.pending).map((change) => ({ ...change, approved: state.approved.includes(change.id) })),
      blocked: Object.entries(state.blocked).map(([id, entry]) => ({ id, ...entry })),
      lastReport: reports.get(name) ?? null,
    };
  }

  async function runCycle(name, simulate) {
    if (busy.has(name)) throw new HttpError(409, 'Un cycle est déjà en cours sur ce site.');
    const config = await registry.load(name);
    if (simulate) config.dryRun = true;
    busy.add(name);
    try {
      return await new Agent(config, { ...agentOptions, onReport: remember }).runCycle();
    } finally {
      busy.delete(name);
    }
  }

  function setWatching(enabled) {
    if (enabled && !watcher) {
      const controller = new AbortController();
      const done = runDaemon(registry, { signal: controller.signal, log, agentOptions: { ...agentOptions, onReport: remember } });
      watcher = { controller, done };
    }
    if (!enabled && watcher) {
      watcher.controller.abort();
      // Le cycle en cours va à son terme : l'interrompre laisserait un déploiement à moitié fait.
      const stopped = watcher;
      watcher = null;
      return stopped.done;
    }
    return undefined;
  }

  // Le choix est conservé : après un redémarrage du serveur, la surveillance reprend toute seule.
  async function saveWatching(enabled) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(watchFile, JSON.stringify({ enabled }));
  }

  async function savedWatching() {
    try {
      return JSON.parse(await readFile(watchFile, 'utf8')).enabled === true;
    } catch {
      return false;
    }
  }

  async function addSite(body) {
    if (!body.gitUrl) return associateSite(registry, body.name, body);
    const name = registry.validateName(body.name);
    if ((await registry.names()).includes(name)) throw new Error(`Le site ${name} existe déjà.`);
    const dir = path.join(sitesRoot, name);
    await cloneRepository(body.gitUrl, dir, { protocols: gitProtocols });
    try {
      return { ...(await associateSite(registry, name, { ...body, dir })), dir };
    } catch (error) {
      // La copie vient d'être créée par l'agent : on la retire pour pouvoir réessayer proprement.
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  const agentFor = async (name) => new Agent(await registry.load(name));

  /* Routes : [méthode, chemin, rôle minimal ou 'public', action, action d'audit] */
  const routes = [
    // En service, Django répond lui-même à /api/session : cette route ne sert qu'à la démo et aux vérifications.
    ['GET', /^\/api\/session$/, 'public', async ({ user }) => ({ service: SERVICE, demo: !requireAuth, user })],

    ['GET', /^\/api\/sites$/, 'viewer', async () => ({
      watching: Boolean(watcher),
      sites: await Promise.all((await registry.names()).map(siteSummary)),
    })],
    ['POST', /^\/api\/inspect$/, 'admin', async ({ body }) => {
      if (!body.dir) throw new HttpError(400, 'Dossier manquant.');
      return inspectSite(path.resolve(body.dir));
    }],
    ['POST', /^\/api\/sites$/, 'admin', async ({ body }) => addSite(body), 'site.add'],
    ['POST', /^\/api\/watch$/, 'admin', async ({ body }) => {
      await setWatching(Boolean(body.enabled));
      await saveWatching(Boolean(watcher));
      return { watching: Boolean(watcher) };
    }, 'watch'],
    ['DELETE', /^\/api\/sites\/([^/]+)$/, 'admin', async ({ params: [name] }) => {
      await registry.remove(name);
      reports.delete(name);
      healthCache.delete(name);
      return {};
    }, 'site.remove'],
    ['POST', /^\/api\/sites\/([^/]+)\/mode$/, 'admin', async ({ params: [name], body }) => {
      await registry.update(name, { dryRun: !body.live });
      return {};
    }, 'site.mode'],
    ['POST', /^\/api\/sites\/([^/]+)\/run$/, 'operator', async ({ params: [name], body }) => runCycle(name, Boolean(body.simulate)), 'site.run'],
    ['POST', /^\/api\/sites\/([^/]+)\/approve$/, 'operator', async ({ params: [name], body, user }) => {
      await (await agentFor(name)).approve(body.id, user.name);
      return {};
    }, 'change.approve'],
    ['POST', /^\/api\/sites\/([^/]+)\/reject$/, 'operator', async ({ params: [name], body, user }) => {
      await (await agentFor(name)).reject(body.id, user.name);
      return {};
    }, 'change.reject'],
    ['POST', /^\/api\/sites\/([^/]+)\/resume$/, 'operator', async ({ params: [name], user }) => {
      await (await agentFor(name)).resume(user.name);
      return {};
    }, 'site.resume'],
    ['GET', /^\/api\/sites\/([^/]+)\/history$/, 'viewer', async ({ params: [name] }) => ({
      entries: (await (await agentFor(name)).store.readHistory(100)).reverse(),
    })],
    ['GET', /^\/api\/sites\/([^/]+)\/settings$/, 'viewer', async ({ params: [name] }) => settingsView(await registry.load(name))],
    ['PUT', /^\/api\/sites\/([^/]+)\/settings$/, 'admin', async ({ params: [name], body }) => {
      const config = await registry.load(name);
      return settingsView(await registry.update(name, settingsPatch(config, body)));
    }, 'site.settings'],
  ];

  function sendJson(response, status, payload) {
    response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  }

  function statusOf(error) {
    if (error.status) return error.status;
    if (error instanceof SiteNotFoundError) return 404;
    if (error instanceof LockBusyError) return 409;
    return 400;
  }

  async function handleApi(request, response, pathname) {
    const route = routes.find(([method, pattern]) => method === request.method && pattern.test(pathname));
    if (!route) throw new HttpError(404, 'Route inconnue.');
    const [, pattern, role, handler, auditAction] = route;

    let body = {};
    if (request.method === 'POST' || request.method === 'PUT') {
      // Un formulaire d'un autre site ne peut pas envoyer ce type de contenu sans autorisation du serveur.
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Contenu JSON attendu.');
      body = await readBody(request);
    }

    const user = currentUser(request);
    // Le rôle est vérifié ici, côté serveur : masquer un bouton dans l'interface ne suffirait pas.
    if (role !== 'public') {
      if (!user) throw new HttpError(401, 'Connectez-vous pour continuer.');
      if (!hasRole(user, role)) throw new HttpError(403, 'Votre rôle ne permet pas cette action.');
    }

    const params = pattern.exec(pathname).slice(1).map(decodeURIComponent);
    const details = Object.fromEntries(AUDITED_FIELDS.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
    if (body.gitUrl) details.gitUrl = redactGitUrl(body.gitUrl);

    // Le journal d'audit est tenu par Django, dans la base de données : l'agent lui décrit l'action.
    const describe = (outcome) => {
      if (!auditAction) return;
      const target = params[0] ?? '';
      response.setHeader('x-site-agent-audit', auditAction);
      response.setHeader('x-site-agent-audit-outcome', encodeURIComponent(outcome));
      response.setHeader('x-site-agent-audit-target', encodeURIComponent(target));
      response.setHeader('x-site-agent-audit-details', encodeURIComponent(JSON.stringify(details)));
    };
    try {
      const result = await handler({ params, body, user, request, response });
      describe('ok');
      sendJson(response, 200, result);
    } catch (error) {
      describe(`refusé : ${error.message}`);
      throw error;
    }
  }

  async function handle(request, response) {
    if (!isAllowedRequest(request)) {
      response.writeHead(403, SECURITY_HEADERS).end('Accès refusé.');
      return;
    }
    const url = new URL(request.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      try {
        await handleApi(request, response, url.pathname);
      } catch (error) {
        sendJson(response, statusOf(error), { error: error.message });
      }
      return;
    }

    // Les fichiers de l'interface ne contiennent aucune donnée : ils sont servis à tous, les données passent par l'API.
    const file = request.method === 'GET' ? STATIC_FILES[url.pathname] : null;
    if (!file) {
      response.writeHead(404, SECURITY_HEADERS).end();
      return;
    }
    response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': file[1] });
    response.end(await readFile(path.join(PUBLIC_DIR, file[0])));
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, SECURITY_HEADERS);
      response.end();
      log(`Erreur de l'interface : ${error.message}`);
    });
  });

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, async () => {
          activePort = server.address().port;
          if (await savedWatching()) {
            setWatching(true);
            log('Surveillance reprise, comme avant le dernier arrêt.');
          }
          resolve({ origin: `http://${host}:${activePort}` });
        });
      });
    },
    async close() {
      await setWatching(false);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
