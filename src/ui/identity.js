import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Les comptes sont gérés par l'administration Django (dossier webadmin). Pour chaque requête,
// Django transmet qui est connecté et avec quel rôle, signé avec une clé partagée.
// Le même calcul existe côté Django, dans webadmin/gateway/signing.py.

export const ROLES = ['viewer', 'operator', 'admin'];
const MAX_SKEW_MS = 60_000;

export function hasRole(user, role) {
  return Boolean(user) && ROLES.indexOf(user.role) >= ROLES.indexOf(role);
}

// La clé est créée au premier démarrage de l'agent ; Django la lit dans le même dossier.
export async function loadProxySecret(dataDir) {
  const file = path.join(dataDir, 'proxy-secret');
  const existing = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (existing) return existing;
  const secret = randomBytes(32).toString('hex');
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, secret, { mode: 0o600 });
  return secret;
}

function sign(secret, parts) {
  return createHmac('sha256', secret).update(parts.join('\n')).digest('hex');
}

export function identityHeaders(secret, { method, url, username, name, role, now = Date.now() }) {
  const time = String(now);
  const user = encodeURIComponent(username);
  const display = encodeURIComponent(name);
  return {
    'x-site-agent-time': time,
    'x-site-agent-user': user,
    'x-site-agent-name': display,
    'x-site-agent-role': role,
    'x-site-agent-signature': sign(secret, [time, method, url, user, display, role]),
  };
}

// Renvoie l'utilisateur, ou null si la requête ne porte pas une identité valide et récente.
export function verifyIdentity(request, secret, now = Date.now()) {
  const headers = request.headers;
  const time = headers['x-site-agent-time'];
  const user = headers['x-site-agent-user'];
  const display = headers['x-site-agent-name'] ?? '';
  const role = headers['x-site-agent-role'];
  const signature = String(headers['x-site-agent-signature'] ?? '');
  if (!secret || !time || !user || !ROLES.includes(role) || !/^[0-9a-f]{64}$/.test(signature)) return null;
  // Une requête captée ne peut pas être rejouée plus tard.
  if (Math.abs(now - Number(time)) > MAX_SKEW_MS) return null;
  const expected = Buffer.from(sign(secret, [time, request.method, request.url, user, display, role]), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return null;
  try {
    const id = decodeURIComponent(user);
    return { id, name: decodeURIComponent(display) || id, role };
  } catch {
    return null;
  }
}
