import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from './agent.js';
import { SiteNotFoundError } from './registry.js';
import { LockBusyError } from './state.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const WEBHOOK_PATH = /^\/webhook\/([a-z0-9][a-z0-9_-]*)$/i;

export function verifySignature(secret, body, header) {
  if (!header) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

// Un appel entrant déclenche seulement une vérification : son contenu n'est jamais utilisé,
// et le changement détecté passe par les mêmes règles que les autres.
// Un site inconnu reçoit la même réponse qu'une mauvaise signature, pour ne pas révéler la liste des sites.
export function createWebhookServer({ resolveSecret, onTrigger }) {
  return createServer((request, response) => {
    const route = request.method === 'POST' ? WEBHOOK_PATH.exec(request.url) : null;
    if (!route) {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', async () => {
      const secret = await resolveSecret(route[1]).catch(() => null);
      if (!secret || !verifySignature(secret, Buffer.concat(chunks), request.headers['x-hub-signature-256'])) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(202).end();
      onTrigger(route[1]);
    });
  });
}

// Chaque site a sa propre boucle : un déploiement long ou une panne n'en retarde aucun autre.
async function watchSite(name, registry, handle, { log, agentOptions }) {
  let lastDetection = 0;

  while (handle.running) {
    let waitSeconds = 60;
    try {
      // Relue à chaque tour : un réglage modifié s'applique sans redémarrer.
      const config = await registry.load(name);
      waitSeconds = config.schedule.healthIntervalSeconds;

      const detectDue = Date.now() - lastDetection >= config.schedule.detectIntervalMinutes * 60 * 1000;
      const detect = handle.triggered || detectDue;
      handle.triggered = false;

      const report = await new Agent(config, agentOptions).runCycle({ detect }).catch((error) => {
        if (error instanceof LockBusyError && detect) handle.triggered = true;
        throw error;
      });
      if (detect) {
        lastDetection = Date.now();
        for (const { title, outcome } of report.decisions) log(`[${name}] [${outcome}] ${title}`);
      }
    } catch (error) {
      if (error instanceof SiteNotFoundError) return;
      if (!(error instanceof LockBusyError)) log(`[${name}] Cycle en échec : ${error.message}`);
    }

    if (handle.triggered || !handle.running) continue;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitSeconds * 1000);
      handle.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

// Le registre est relu régulièrement : un site associé ou retiré est pris en compte sans redémarrage.
export async function runDaemon(registry, { only = null, signal, refreshMs = 30_000, log = console.log, agentOptions = {} } = {}) {
  const handles = new Map();

  const stopHandle = (handle) => {
    handle.running = false;
    handle.wake();
  };

  const refresh = async () => {
    const names = (await registry.names()).filter((name) => !only || only.includes(name));
    for (const name of names) {
      if (handles.has(name)) continue;
      const handle = { running: true, triggered: true, wake: () => {} };
      handles.set(name, handle);
      log(`Surveillance de ${name}.`);
      handle.done = watchSite(name, registry, handle, { log, agentOptions });
    }
    for (const [name, handle] of handles) {
      if (names.includes(name)) continue;
      stopHandle(handle);
      handles.delete(name);
      log(`Fin de la surveillance de ${name}.`);
    }
  };

  let server = null;
  const webhook = await registry.webhookSettings();
  if (webhook.enabled) {
    server = createWebhookServer({
      resolveSecret: async (name) => process.env[(await registry.load(name)).webhook.secretEnv],
      onTrigger: (name) => {
        const handle = handles.get(name);
        if (!handle) return;
        handle.triggered = true;
        handle.wake();
      },
    });
    server.on('error', (error) => log(`Webhook indisponible : ${error.message}`));
    server.listen(webhook.port, webhook.host);
  }

  const finished = [];
  while (!signal?.aborted) {
    try {
      await refresh();
      for (const handle of handles.values()) if (!finished.includes(handle.done)) finished.push(handle.done);
    } catch (error) {
      log(`Lecture du registre impossible : ${error.message}`);
    }
    await delay(refreshMs, undefined, { signal }).catch(() => {});
  }

  for (const handle of handles.values()) stopHandle(handle);
  await Promise.allSettled(finished);
  server?.close();
}
