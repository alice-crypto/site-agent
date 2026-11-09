import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, deepMerge, normalizeConfig } from './config.js';
import { StateStore } from './state.js';

const SITE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEFAULT_HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class SiteNotFoundError extends Error {
  constructor(name) {
    super(`Site inconnu : ${name}. Voir la commande « list ».`);
  }
}

function sameDir(a, b) {
  const normalize = (dir) => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));
  return normalize(a) === normalize(b);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export class Registry {
  constructor(home = DEFAULT_HOME) {
    this.home = path.resolve(home);
    this.sitesDir = path.join(this.home, 'sites');
    this.defaultsPath = path.join(this.home, 'agent.defaults.json');
  }

  #sitePath(name) {
    if (!SITE_NAME.test(name ?? '')) {
      throw new Error(`Nom de site invalide : ${name}. Lettres, chiffres, « - » et « _ » uniquement.`);
    }
    return path.join(this.sitesDir, `${name}.json`);
  }

  async #defaults() {
    try {
      return await readJson(this.defaultsPath);
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async #readSite(name) {
    try {
      return await readJson(this.#sitePath(name));
    } catch (error) {
      if (error.code === 'ENOENT') throw new SiteNotFoundError(name);
      throw error;
    }
  }

  async #write(name, raw) {
    await mkdir(this.sitesDir, { recursive: true });
    const target = this.#sitePath(name);
    await writeFile(`${target}.tmp`, `${JSON.stringify(raw, null, 2)}\n`);
    await rename(`${target}.tmp`, target);
  }

  #build(name, defaults, raw) {
    const stateRoot = defaults.stateDir ?? DEFAULTS.stateDir;
    return normalizeConfig({ ...deepMerge(defaults, raw), name, stateDir: path.join(stateRoot, name) }, this.home);
  }

  validateName(name) {
    this.#sitePath(name);
    return name;
  }

  async names() {
    try {
      const files = await readdir(this.sitesDir);
      return files
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.slice(0, -'.json'.length))
        .sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async load(name) {
    return this.#build(name, await this.#defaults(), await this.#readSite(name));
  }

  async #findOwnerOfDir(dir) {
    for (const name of await this.names()) {
      const raw = await this.#readSite(name).catch(() => null);
      if (raw?.site?.dir && sameDir(raw.site.dir, dir)) return name;
    }
    return null;
  }

  async add(name, raw) {
    const target = this.#sitePath(name);
    if (await readFile(target).then(() => true, () => false)) throw new Error(`Le site ${name} existe déjà.`);

    // Deux agents sur la même copie Git s'écraseraient lors d'un retour arrière.
    const owner = await this.#findOwnerOfDir(raw.site.dir);
    if (owner) throw new Error(`Ce dossier est déjà associé au site ${owner}.`);

    const config = this.#build(name, await this.#defaults(), raw);
    await this.#write(name, raw);
    return config;
  }

  async update(name, patch) {
    const raw = deepMerge(await this.#readSite(name), patch);
    const config = this.#build(name, await this.#defaults(), raw);
    await this.#write(name, raw);
    return config;
  }

  // L'état et l'historique sont conservés : le site les retrouve s'il est de nouveau associé.
  async remove(name) {
    const config = await this.load(name);
    await new StateStore(config.stateDir).withLock(() => rm(this.#sitePath(name)), { waitMs: 30_000 });
  }

  async webhookSettings() {
    return deepMerge(DEFAULTS.webhook, (await this.#defaults()).webhook);
  }

  async uiSettings() {
    return deepMerge(DEFAULTS.ui, (await this.#defaults()).ui);
  }

  // Dossier commun à tous les sites : état, clé partagée avec l'administration Django.
  dataDir() {
    return path.resolve(this.home, DEFAULTS.stateDir);
  }
}
