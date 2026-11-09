import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = '.site-agent';
// Le verrou et le lien d'installation n'ont aucun sens une fois restaurés.
const SKIPPED = new Set(['lock', 'ui-token']);

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// Copie la configuration, les sites associés, les comptes, l'état et l'historique.
export async function createBackup(home, { keep = 14, now = new Date() } = {}) {
  const root = path.join(home, 'backups');
  const target = path.join(root, stamp(now));
  await mkdir(target, { recursive: true });

  for (const entry of ['agent.defaults.json', 'sites', DATA_DIR]) {
    const source = path.join(home, entry);
    if (!(await exists(source))) continue;
    await cp(source, path.join(target, entry), {
      recursive: true,
      filter: (file) => !SKIPPED.has(path.basename(file)) && !file.endsWith('.tmp'),
    });
  }

  const backups = (await readdir(root)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    await rm(path.join(root, old), { recursive: true, force: true });
  }
  return target;
}
