import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ROLES = ['viewer', 'operator', 'admin'];
export const ROLE_LABELS = { viewer: 'Lecteur', operator: 'Opérateur', admin: 'Administrateur' };

const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 256;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function hasRole(user, required) {
  return ROLE_RANK[user?.role] >= ROLE_RANK[required];
}

function derive(password, salt, { N, r, p, maxmem }) {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r, p, maxmem }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, expected] = (stored ?? '').split('$');
  if (scheme !== 'scrypt') return false;
  const key = await derive(password, Buffer.from(salt, 'base64'), {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  const reference = Buffer.from(expected, 'base64');
  return reference.length === key.length && timingSafeEqual(reference, key);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new Error(`Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`);
  }
  if (password.length > MAX_PASSWORD) throw new Error('Mot de passe trop long.');
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!EMAIL.test(normalized)) throw new Error('Adresse e-mail invalide.');
  return normalized;
}

function checkRole(role) {
  if (!ROLES.includes(role)) throw new Error(`Rôle invalide : ${role}`);
  return role;
}

// Ce qui peut quitter le serveur : jamais l'empreinte du mot de passe ni celle de l'invitation.
export function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    disabled: user.disabled,
    pending: !user.passwordHash,
    inviteExpiresAt: user.invite?.expiresAt ?? null,
    createdAt: user.createdAt,
  };
}

export class AccountStore {
  #queue = Promise.resolve();
  #dummyHash = null;

  constructor(dir, { now = () => new Date() } = {}) {
    this.file = path.join(dir, 'users.json');
    this.now = now;
  }

  async #read() {
    try {
      return JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { users: [] };
      throw error;
    }
  }

  async #write(data) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }

  // Les écritures passent une par une : deux invitations simultanées ne s'écrasent pas.
  #mutate(task) {
    const run = this.#queue.then(async () => {
      const data = await this.#read();
      const result = await task(data);
      await this.#write(data);
      return result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  #newInvite() {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + INVITE_TTL_MS).toISOString();
    return { token, invite: { hash: hashToken(token), expiresAt } };
  }

  async count() {
    return (await this.#read()).users.length;
  }

  async list() {
    return (await this.#read()).users.map(publicUser);
  }

  async get(id) {
    return (await this.#read()).users.find((user) => user.id === id) ?? null;
  }

  async findByEmail(email) {
    const normalized = String(email ?? '').trim().toLowerCase();
    return (await this.#read()).users.find((user) => user.email === normalized) ?? null;
  }

  async invite({ email, name, role }) {
    const normalized = normalizeEmail(email);
    checkRole(role);
    return this.#mutate((data) => {
      if (data.users.some((user) => user.email === normalized)) throw new Error('Un compte existe déjà avec cette adresse.');
      const { token, invite } = this.#newInvite();
      const user = {
        id: randomUUID(),
        email: normalized,
        name: String(name ?? '').trim() || normalized,
        role,
        disabled: false,
        passwordHash: null,
        sessionVersion: 0,
        invite,
        createdAt: this.now().toISOString(),
      };
      data.users.push(user);
      return { user: publicUser(user), token };
    });
  }

  // Sert aussi à réinitialiser un mot de passe oublié : l'ancien reste valable tant que le lien n'est pas utilisé.
  async reinvite(id) {
    return this.#mutate((data) => {
      const user = data.users.find((candidate) => candidate.id === id);
      if (!user) throw new Error('Compte introuvable.');
      const { token, invite } = this.#newInvite();
      user.invite = invite;
      return { user: publicUser(user), token };
    });
  }

  async checkInvite(token) {
    const hash = hashToken(String(token ?? ''));
    const user = (await this.#read()).users.find((candidate) => candidate.invite?.hash === hash);
    if (!user || user.disabled || Date.parse(user.invite.expiresAt) < this.now().getTime()) {
      throw new Error("Ce lien d'invitation est invalide ou a expiré. Demandez-en un nouveau à un administrateur.");
    }
    return publicUser(user);
  }

  async acceptInvite(token, password) {
    validatePassword(password);
    const passwordHash = await hashPassword(password);
    const hash = hashToken(String(token ?? ''));
    return this.#mutate((data) => {
      const user = data.users.find((candidate) => candidate.invite?.hash === hash);
      if (!user || user.disabled || Date.parse(user.invite.expiresAt) < this.now().getTime()) {
        throw new Error("Ce lien d'invitation est invalide ou a expiré. Demandez-en un nouveau à un administrateur.");
      }
      user.passwordHash = passwordHash;
      user.invite = null;
      user.sessionVersion += 1;
      return user;
    });
  }

  async createFirstAdmin({ email, name, password }) {
    const normalized = normalizeEmail(email);
    validatePassword(password);
    const passwordHash = await hashPassword(password);
    return this.#mutate((data) => {
      if (data.users.length) throw new Error('Un administrateur existe déjà.');
      const user = {
        id: randomUUID(),
        email: normalized,
        name: String(name ?? '').trim() || normalized,
        role: 'admin',
        disabled: false,
        passwordHash,
        sessionVersion: 0,
        invite: null,
        createdAt: this.now().toISOString(),
      };
      data.users.push(user);
      return user;
    });
  }

  // Le calcul a lieu même pour une adresse inconnue : le temps de réponse ne révèle pas quels comptes existent.
  async authenticate(email, password) {
    const user = await this.findByEmail(email);
    if (!user?.passwordHash || user.disabled) {
      this.#dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
      await verifyPassword(String(password ?? ''), this.#dummyHash);
      return null;
    }
    return (await verifyPassword(String(password ?? ''), user.passwordHash)) ? user : null;
  }

  async update(id, { role, disabled }) {
    if (role !== undefined) checkRole(role);
    return this.#mutate((data) => {
      const user = data.users.find((candidate) => candidate.id === id);
      if (!user) throw new Error('Compte introuvable.');
      const next = { ...user, ...(role !== undefined ? { role } : {}), ...(disabled !== undefined ? { disabled: Boolean(disabled) } : {}) };
      const activeAdmins = data.users
        .map((candidate) => (candidate.id === id ? next : candidate))
        .filter((candidate) => candidate.role === 'admin' && !candidate.disabled && candidate.passwordHash);
      if (!activeAdmins.length) throw new Error('Il doit rester au moins un administrateur actif.');
      Object.assign(user, next);
      return publicUser(user);
    });
  }

  async changePassword(id, current, next) {
    validatePassword(next);
    const user = await this.get(id);
    if (!user || !(await verifyPassword(String(current ?? ''), user.passwordHash))) {
      throw new Error('Mot de passe actuel incorrect.');
    }
    const passwordHash = await hashPassword(next);
    return this.#mutate((data) => {
      const stored = data.users.find((candidate) => candidate.id === id);
      stored.passwordHash = passwordHash;
      stored.sessionVersion += 1;
      return stored;
    });
  }
}
