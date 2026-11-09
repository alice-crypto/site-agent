import path from 'node:path';
import { inspectSite } from './site-inspector.js';

export const COMMAND_NAMES = ['install', 'test', 'build', 'deploy', 'restart'];

export const DEDICATED_COPY_WARNING =
  "En mode réel, l'agent fait des git reset --hard dans ce dossier. Utilisez une copie dédiée, pas votre dossier de travail.";

// Point d'entrée commun à la ligne de commande et à l'interface.
export async function associateSite(registry, name, { dir, urls, branch, remote, commands = {} }) {
  if (!dir) throw new Error('Le dossier du site est obligatoire.');
  if (!urls?.length) throw new Error("L'adresse du site est obligatoire.");

  const absoluteDir = path.resolve(dir);
  const info = await inspectSite(absoluteDir);
  const finalBranch = branch || info.branch;
  if (!finalBranch) throw new Error('Branche non détectée : précisez-la.');
  const finalRemote = remote || info.remote;

  const finalCommands = { ...info.commands };
  for (const command of COMMAND_NAMES) if (commands[command]) finalCommands[command] = commands[command];

  await registry.add(name, {
    dryRun: true,
    site: {
      dir: absoluteDir,
      branch: finalBranch,
      ...(finalRemote ? { remote: finalRemote } : {}),
      pushAfterSuccess: Boolean(finalRemote),
      commands: finalCommands,
    },
    health: { urls },
    detectors: { dependencies: { enabled: info.hasLock }, code: { enabled: Boolean(finalRemote) } },
  });

  const warnings = [DEDICATED_COPY_WARNING];
  if (!info.isClean) warnings.push('Ce dossier contient des modifications non enregistrées dans Git.');
  if (!finalCommands.deploy) warnings.push('Il faudra une commande de déploiement avant le mode réel.');

  return {
    branch: finalBranch,
    remote: finalRemote,
    commands: finalCommands,
    tracksDependencies: info.hasLock,
    tracksCode: Boolean(finalRemote),
    warnings,
  };
}
