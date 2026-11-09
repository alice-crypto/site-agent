import { exec, execFile } from 'node:child_process';

const MAX_BUFFER = 50 * 1024 * 1024;

export class CommandError extends Error {
  constructor(label, error, stdout, stderr) {
    const output = (stderr || stdout || error.message).trim().slice(-2000);
    super(`Échec de « ${label} » : ${output}`);
    this.exitCode = error.code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function settle(label, resolve, reject, allowFailure) {
  return (error, stdout, stderr) => {
    if (error && !allowFailure) reject(new CommandError(label, error, stdout, stderr));
    else resolve({ stdout, stderr, exitCode: error ? error.code : 0 });
  };
}

// Pour les commandes écrites dans la configuration, qui ont besoin d'un shell.
export function runShell(command, { cwd, timeoutSeconds = 600, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd, timeout: timeoutSeconds * 1000, maxBuffer: MAX_BUFFER },
      settle(command, resolve, reject, allowFailure),
    );
  });
}

// Sans shell : à préférer dès qu'un argument vient d'une donnée.
export function runFile(file, args, { cwd, timeoutSeconds = 600, allowFailure = false, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, timeout: timeoutSeconds * 1000, maxBuffer: MAX_BUFFER, ...(env ? { env } : {}) },
      settle(`${file} ${args.join(' ')}`, resolve, reject, allowFailure),
    );
  });
}
