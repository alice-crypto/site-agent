import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ACTIONS = new Set(['auto', 'approval', 'deny']);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const DEFAULTS = {
  name: null,
  dryRun: true,
  stateDir: '.site-agent',
  site: {
    dir: null,
    remote: 'origin',
    branch: 'main',
    pushAfterSuccess: false,
    commandTimeoutSeconds: 600,
    installTriggers: ['package.json', 'package-lock.json'],
    commands: { install: null, test: null, build: null, deploy: null, restart: null },
  },
  health: {
    urls: [],
    samples: 5,
    intervalMs: 1000,
    timeoutMs: 5000,
    maxErrorRate: 0,
    maxP95LatencyMs: 2000,
    mustContain: null,
    settleSeconds: 5,
  },
  schedule: {
    healthIntervalSeconds: 60,
    detectIntervalMinutes: 60,
    timezone: 'UTC',
    windows: [],
    freezes: [],
  },
  detectors: {
    dependencies: { enabled: false },
    code: { enabled: false, maxLowRiskFiles: 5, maxLowRiskLines: 100, sensitivePaths: [] },
    content: { enabled: false, maxLowRiskChangeRatio: 0.3, sources: [] },
    incident: { enabled: true, failuresBeforeAction: 3, cooldownMinutes: 30, maxPerDay: 3 },
  },
  policy: { default: 'approval', maxAutoPerDay: 5, maxConsecutiveFailures: 2, rules: [] },
  // Analyse de chaque mise à jour par un modèle de langage local (LangChain + Ollama). Elle ne peut que rendre plus prudent.
  advisor: {
    enabled: false,
    provider: 'ollama',
    model: 'qwen2.5:7b',
    baseUrl: 'http://127.0.0.1:11434',
    timeoutSeconds: 120,
    maxDiffChars: 12000,
    // Si le modèle ne répond pas : « rules » décide avec les règles seules, « approval » exige une validation.
    onError: 'rules',
  },
  webhook: { enabled: false, host: '127.0.0.1', port: 8787, secretEnv: 'SITE_AGENT_WEBHOOK_SECRET' },
  ui: { port: 4310, webPort: 8000, publicUrl: null },
  notify: { webhookUrlEnv: 'SITE_AGENT_NOTIFY_WEBHOOK' },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    merged[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return merged;
}

export function normalizeConfig(raw, baseDir = process.cwd()) {
  const config = deepMerge(DEFAULTS, raw);
  const errors = [];

  if (!config.site.dir) errors.push('site.dir est obligatoire');
  if (!config.health.urls.length) errors.push('health.urls doit contenir au moins une URL');
  for (const url of config.health.urls) {
    if (!/^https?:\/\/\S+$/i.test(url)) errors.push(`health.urls : adresse invalide ${url}`);
  }
  if (!config.dryRun && !config.site.commands.deploy) {
    errors.push('site.commands.deploy est obligatoire hors simulation');
  }

  if (!ACTIONS.has(config.policy.default)) errors.push(`policy.default invalide : ${config.policy.default}`);
  config.policy.rules.forEach((rule, index) => {
    if (!ACTIONS.has(rule.action)) errors.push(`policy.rules[${index}].action invalide : ${rule.action}`);
    if (!isPlainObject(rule.when)) errors.push(`policy.rules[${index}].when doit être un objet`);
  });

  for (const pattern of config.detectors.code.sensitivePaths) {
    try {
      new RegExp(pattern);
    } catch {
      errors.push(`detectors.code.sensitivePaths : expression invalide ${pattern}`);
    }
  }

  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: config.schedule.timezone });
  } catch {
    errors.push(`schedule.timezone invalide : ${config.schedule.timezone}`);
  }

  config.schedule.windows.forEach((window, index) => {
    if (!TIME.test(window.start ?? '') || !TIME.test(window.end ?? '')) {
      errors.push(`Plage ${index + 1} : heures invalides, format attendu 02:00`);
    }
    if (window.days && (!window.days.length || window.days.some((day) => !WEEK_DAYS.includes(day)))) {
      errors.push(`Plage ${index + 1} : choisissez au moins un jour valide`);
    }
  });
  config.schedule.freezes.forEach(({ from, to }, index) => {
    if (!DATE.test(from ?? '') || !DATE.test(to ?? '') || from > to) {
      errors.push(`Gel ${index + 1} : dates invalides`);
    }
  });

  const { advisor } = config;
  if (advisor.provider !== 'ollama') errors.push(`advisor.provider invalide : ${advisor.provider} (seul ollama est pris en charge)`);
  if (typeof advisor.model !== 'string' || !advisor.model.trim()) errors.push('advisor.model manquant');
  if (!/^https?:\/\//.test(String(advisor.baseUrl))) errors.push(`advisor.baseUrl doit être une adresse http(s) : ${advisor.baseUrl}`);
  if (!['rules', 'approval'].includes(advisor.onError)) errors.push(`advisor.onError invalide : ${advisor.onError}`);
  for (const key of ['timeoutSeconds', 'maxDiffChars']) {
    if (!(Number.isFinite(advisor[key]) && advisor[key] > 0)) errors.push(`advisor.${key} doit être un nombre positif`);
  }

  if (errors.length) throw new Error(`Configuration invalide :\n- ${errors.join('\n- ')}`);

  config.baseDir = baseDir;
  config.site.dir = path.resolve(baseDir, config.site.dir);
  config.stateDir = path.resolve(baseDir, config.stateDir);
  return config;
}

export async function loadConfig(file) {
  const absolute = path.resolve(file);
  const raw = JSON.parse(await readFile(absolute, 'utf8'));
  return normalizeConfig(raw, path.dirname(absolute));
}
