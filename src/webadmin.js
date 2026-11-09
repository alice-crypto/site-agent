import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// L'administration Django (comptes, groupes, journal) tourne à côté de l'agent : c'est elle que l'équipe ouvre.
// L'agent la démarre et la relance si elle s'arrête.

export const WEBADMIN_DIR = fileURLToPath(new URL('../webadmin/', import.meta.url));
const RESTART_DELAY_MS = 5000;
// Ligne écrite par « manage.py serve » quand Waitress écoute ; le « ê » peut arriver déformé selon la page de code.
const READY = /Administration Django pr.{1,2}te/;

export function webadminPython(env = process.env) {
  if (env.SITE_AGENT_PYTHON) return env.SITE_AGENT_PYTHON;
  const venv = process.platform === 'win32'
    ? path.join(WEBADMIN_DIR, '.venv', 'Scripts', 'python.exe')
    : path.join(WEBADMIN_DIR, '.venv', 'bin', 'python');
  if (!existsSync(venv)) {
    throw new Error(
      `Environnement Python de l'administration introuvable (${venv}). Créez-le une fois : ` +
        'python -m venv webadmin/.venv, puis webadmin/.venv/Scripts/python -m pip install -r webadmin/requirements/production.txt',
    );
  }
  return venv;
}

export function startWebAdmin({ home, agentPort, webPort, publicUrl, log = console.log, python = webadminPython() }) {
  let child = null;
  let stopped = false;
  let timer = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  const env = {
    ...process.env,
    SITE_AGENT_HOME: home,
    SITE_AGENT_AGENT_URL: `http://127.0.0.1:${agentPort}`,
    // Sans adresse publique dans agent.defaults.json, celle de webadmin/.env (ou l'adresse locale) s'applique.
    ...(publicUrl ? { SITE_AGENT_PUBLIC_URL: publicUrl } : {}),
    DJANGO_SETTINGS_MODULE: 'config.settings.production',
    PYTHONUNBUFFERED: '1',
    // Sans cela, Python écrit dans la page de code de Windows et les accents du journal arrivent déformés.
    PYTHONIOENCODING: 'utf-8',
  };

  const launch = () => {
    const args = ['manage.py', 'serve', '--port', String(Number(webPort))];
    const options = { cwd: WEBADMIN_DIR, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
    // Un lanceur .cmd (py.exe enveloppé, par exemple) ne s'exécute que par l'interpréteur de commandes.
    child = /\.(cmd|bat)$/i.test(python)
      ? spawn(`"${python}" ${args.join(' ')}`, { ...options, shell: true })
      : spawn(python, args, options);
    const relay = (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        log(`[admin] ${line}`);
        if (READY.test(line)) resolveReady(true);
      }
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', (error) => log(`[admin] Démarrage impossible : ${error.message}`));
    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      log(`[admin] Arrêtée (code ${code}). Nouvel essai dans ${RESTART_DELAY_MS / 1000} s.`);
      timer = setTimeout(launch, RESTART_DELAY_MS);
    });
  };
  launch();

  return {
    url: publicUrl ?? `http://127.0.0.1:${webPort}`,
    localUrl: `http://127.0.0.1:${webPort}`,
    ready,
    stop() {
      stopped = true;
      clearTimeout(timer);
      if (!child) return Promise.resolve();
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      return exited;
    },
  };
}
