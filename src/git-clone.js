import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { runFile } from './exec.js';

const PATTERNS = {
  https: /^https:\/\/[^\s]+$/i,
  ssh: /^(ssh:\/\/[^\s]+|[\w.-]+@[\w.-]+:[^\s]+)$/i,
  file: /^file:\/\/\/[^\s]+$/i,
};

export function validateGitUrl(url, protocols = ['https', 'ssh']) {
  const value = String(url ?? '').trim();
  // Un argument qui commence par « - » serait lu comme une option de git, par exemple --upload-pack.
  if (value.startsWith('-') || !protocols.some((protocol) => PATTERNS[protocol].test(value))) {
    throw new Error(`Adresse Git non acceptée : utilisez une adresse ${protocols.includes('ssh') ? 'SSH (git@hôte:dépôt.git) ou ' : ''}HTTPS.`);
  }
  return value;
}

// Retire un éventuel identifiant ou jeton d'une adresse avant de l'écrire dans un journal.
export function redactGitUrl(url) {
  return String(url ?? '').replace(/(\/\/)[^@/\s]+@/, '$1***@');
}

// Clone sans jamais attendre une saisie : sur un serveur, une demande de mot de passe bloquerait l'agent indéfiniment.
export async function cloneRepository(url, dir, { protocols = ['https', 'ssh'], timeoutSeconds = 600 } = {}) {
  const safeUrl = validateGitUrl(url, protocols);
  if (await stat(dir).then(() => true, () => false)) throw new Error(`Le dossier ${dir} existe déjà.`);
  await mkdir(path.dirname(dir), { recursive: true });

  const allow = ['-c', 'protocol.allow=never', ...protocols.flatMap((protocol) => ['-c', `protocol.${protocol}.allow=always`])];
  try {
    await runFile('git', [...allow, 'clone', '--quiet', '--', safeUrl, dir], {
      timeoutSeconds,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      },
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`Clonage impossible. Vérifiez l'adresse et la clé de déploiement du serveur. ${redactGitUrl(error.message)}`);
  }
}
