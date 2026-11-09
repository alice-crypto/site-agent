import { createHash, randomBytes } from 'node:crypto';

const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// En mémoire : redémarrer le serveur déconnecte tout le monde, ce qui est acceptable pour une petite équipe.
export class SessionStore {
  #sessions = new Map();

  constructor({ now = () => new Date(), idleMs = IDLE_MS, absoluteMs = ABSOLUTE_MS } = {}) {
    this.now = now;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
  }

  create(user) {
    const token = randomBytes(32).toString('base64url');
    const at = this.now().getTime();
    this.#sessions.set(hashToken(token), { userId: user.id, version: user.sessionVersion, createdAt: at, lastSeen: at });
    return token;
  }

  resolve(token) {
    if (!token) return null;
    const key = hashToken(token);
    const session = this.#sessions.get(key);
    if (!session) return null;
    const at = this.now().getTime();
    if (at - session.lastSeen > this.idleMs || at - session.createdAt > this.absoluteMs) {
      this.#sessions.delete(key);
      return null;
    }
    session.lastSeen = at;
    return session;
  }

  destroy(token) {
    if (token) this.#sessions.delete(hashToken(token));
  }

  destroyUser(userId) {
    for (const [key, session] of this.#sessions) if (session.userId === userId) this.#sessions.delete(key);
  }
}

// Bloque une adresse e-mail après plusieurs échecs, pour empêcher de deviner un mot de passe par essais successifs.
export class LoginGuard {
  #failures = new Map();

  constructor({ now = () => new Date(), maxFailures = MAX_FAILURES, lockMs = LOCK_MS } = {}) {
    this.now = now;
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
  }

  #recent(key) {
    const since = this.now().getTime() - this.lockMs;
    const recent = (this.#failures.get(key) ?? []).filter((at) => at > since);
    this.#failures.set(key, recent);
    return recent;
  }

  isLocked(key) {
    return this.#recent(key).length >= this.maxFailures;
  }

  fail(key) {
    this.#recent(key).push(this.now().getTime());
  }

  reset(key) {
    this.#failures.delete(key);
  }
}
