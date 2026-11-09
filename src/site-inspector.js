import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { runFile } from './exec.js';

const NPM_DEFAULT_TEST = 'no test specified';

export function suggestCommands(packageJson, hasLock) {
  if (!packageJson) return {};
  const scripts = packageJson.scripts ?? {};
  const commands = { install: hasLock ? 'npm ci' : 'npm install' };
  if (scripts.test && !scripts.test.includes(NPM_DEFAULT_TEST)) commands.test = 'npm test';
  if (scripts.build) commands.build = 'npm run build';
  if (scripts.deploy) commands.deploy = 'npm run deploy';
  return commands;
}

async function exists(file) {
  return stat(file).then(() => true, () => false);
}

async function gitOutput(dir, args) {
  const { stdout, exitCode } = await runFile('git', args, { cwd: dir, allowFailure: true });
  return exitCode === 0 ? stdout.trim() : null;
}

// Lecture seule : l'analyse ne modifie rien dans le dossier du site.
export async function inspectSite(dir) {
  const stats = await stat(dir).catch(() => null);
  if (!stats?.isDirectory()) throw new Error(`Dossier introuvable : ${dir}`);

  const topLevel = await gitOutput(dir, ['rev-parse', '--show-toplevel']);
  if (topLevel === null) throw new Error(`${dir} n'est pas un dépôt Git : l'agent en a besoin pour revenir en arrière.`);

  const branch = await gitOutput(dir, ['symbolic-ref', '--short', 'HEAD']);
  const remotes = ((await gitOutput(dir, ['remote'])) ?? '').split('\n').filter(Boolean);
  const status = await gitOutput(dir, ['status', '--porcelain']);

  const packageJson = await readFile(path.join(dir, 'package.json'), 'utf8').then(JSON.parse, () => null);
  const hasLock = await exists(path.join(dir, 'package-lock.json'));

  return {
    branch,
    remote: remotes.includes('origin') ? 'origin' : (remotes[0] ?? null),
    isClean: status === '',
    hasLock,
    commands: suggestCommands(packageJson, hasLock),
  };
}
