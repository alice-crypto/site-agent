import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const EMPTY_STATE = {
  lastKnownGood: null,
  blocked: {},
  pending: {},
  approved: [],
  paused: null,
  consecutiveFailures: 0,
  healthFailures: 0,
  autoApplied: [],
  remediations: [],
  lastIncidentAlertAt: null,
};

export class LockBusyError extends Error {
  constructor() {
    super("Un cycle de l'agent est en cours, réessayez dans un instant.");
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export class StateStore {
  constructor(dir) {
    this.dir = dir;
    this.statePath = path.join(dir, 'state.json');
    this.historyPath = path.join(dir, 'history.jsonl');
    this.lockPath = path.join(dir, 'lock');
  }

  async load() {
    try {
      return { ...structuredClone(EMPTY_STATE), ...JSON.parse(await readFile(this.statePath, 'utf8')) };
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY_STATE);
      throw error;
    }
  }

  async save(state) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2));
    await rename(temporary, this.statePath);
  }

  async appendHistory(entry) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.historyPath, `${JSON.stringify(entry)}\n`);
  }

  async readHistory(limit = 20) {
    try {
      const lines = (await readFile(this.historyPath, 'utf8')).trim().split('\n');
      return lines.slice(-limit).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async #acquire(waitMs) {
    await mkdir(this.dir, { recursive: true });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const handle = await open(this.lockPath, 'wx');
        await handle.writeFile(String(process.pid));
        await handle.close();
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const holder = Number(await readFile(this.lockPath, 'utf8').catch(() => ''));
      if (holder && !isAlive(holder)) {
        await rm(this.lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new LockBusyError();
      await delay(200);
    }
  }

  async withLock(task, { waitMs = 0 } = {}) {
    await this.#acquire(waitMs);
    try {
      return await task();
    } finally {
      await rm(this.lockPath, { force: true });
    }
  }
}
