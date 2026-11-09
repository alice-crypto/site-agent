import { resolveTarget } from '../detectors/content.js';
import { findRule } from '../policy.js';
import { COMMAND_NAMES } from '../site-setup.js';

const DEPENDENCY = 'dependency';

// Les lignes du tableau d'autonomie. L'ordre compte : la faille grave doit passer avant les autres dépendances.
const MATRIX_ROWS = [
  {
    key: 'dep-security',
    group: 'Dépendances',
    label: 'Faille grave, corrigeable sans rupture',
    allowNow: true,
    sample: { type: DEPENDENCY, severity: 'critical', updateKind: 'minor', risk: 'medium' },
    when: { type: DEPENDENCY, severity: ['critical', 'high'], updateKind: ['patch', 'minor', 'transitive'] },
  },
  {
    key: 'dep-patch',
    group: 'Dépendances',
    label: 'Version corrective',
    sample: { type: DEPENDENCY, updateKind: 'patch', risk: 'low' },
    when: { type: DEPENDENCY, updateKind: 'patch' },
  },
  {
    key: 'dep-minor',
    group: 'Dépendances',
    label: 'Version mineure ou faille indirecte',
    sample: { type: DEPENDENCY, updateKind: 'minor', risk: 'medium' },
    when: { type: DEPENDENCY, updateKind: ['minor', 'transitive'] },
  },
  {
    key: 'dep-major',
    group: 'Dépendances',
    label: 'Version majeure',
    sample: { type: DEPENDENCY, updateKind: 'major', risk: 'high' },
    when: { type: DEPENDENCY, updateKind: ['major', 'unknown'] },
  },
  {
    key: 'code-low',
    group: 'Code',
    label: 'Petit changement',
    sample: { type: 'code', risk: 'low' },
    when: { type: 'code', risk: 'low' },
  },
  {
    key: 'code-medium',
    group: 'Code',
    label: 'Gros changement',
    sample: { type: 'code', risk: 'medium' },
    when: { type: 'code', risk: 'medium' },
  },
  {
    key: 'code-high',
    group: 'Code',
    label: 'Fichier sensible',
    sample: { type: 'code', risk: 'high' },
    when: { type: 'code', risk: 'high' },
  },
  {
    key: 'content-low',
    group: 'Contenu',
    label: 'Petite modification',
    sample: { type: 'content', risk: 'low' },
    when: { type: 'content', risk: 'low' },
  },
  {
    key: 'content-medium',
    group: 'Contenu',
    label: 'Modification importante',
    sample: { type: 'content', risk: 'medium' },
    when: { type: 'content', risk: 'medium' },
  },
];

function ruleValue(rule, policy) {
  if (!rule) return policy.default;
  return rule.action === 'auto' && rule.bypassWindow ? 'now' : rule.action;
}

function currentMatrix(policy) {
  return Object.fromEntries(MATRIX_ROWS.map((row) => [row.key, ruleValue(findRule(row.sample, policy), policy)]));
}

function matrixToRules(matrix) {
  return MATRIX_ROWS.map((row) => {
    const value = matrix[row.key];
    if (!['now', 'auto', 'approval', 'deny'].includes(value) || (value === 'now' && !row.allowNow)) {
      throw new Error(`Valeur invalide pour « ${row.label} »`);
    }
    return {
      name: row.label,
      when: row.when,
      action: value === 'now' ? 'auto' : value,
      ...(value === 'now' ? { bypassWindow: true } : {}),
    };
  });
}

function hasCustomRules(policy) {
  const known = new Set(MATRIX_ROWS.map((row) => JSON.stringify(row.when)));
  return policy.rules.some((rule) => !known.has(JSON.stringify(rule.when)));
}

function currentCommands(config) {
  return Object.fromEntries(COMMAND_NAMES.map((name) => [name, config.site.commands[name] ?? '']));
}

export function settingsView(config) {
  return {
    urls: config.health.urls,
    maxP95LatencyMs: config.health.maxP95LatencyMs,
    timezone: config.schedule.timezone,
    windows: config.schedule.windows,
    freezes: config.schedule.freezes,
    detectIntervalMinutes: config.schedule.detectIntervalMinutes,
    maxAutoPerDay: config.policy.maxAutoPerDay,
    maxConsecutiveFailures: config.policy.maxConsecutiveFailures,
    commands: currentCommands(config),
    dependenciesEnabled: config.detectors.dependencies.enabled,
    codeEnabled: config.detectors.code.enabled,
    contentEnabled: config.detectors.content.enabled,
    sources: config.detectors.content.sources,
    matrix: currentMatrix(config.policy),
    rows: MATRIX_ROWS.map(({ key, group, label, allowNow = false }) => ({ key, group, label, allowNow })),
    hasCustomRules: hasCustomRules(config.policy),
    advisorEnabled: config.advisor.enabled,
    advisorModel: config.advisor.model,
    advisorBaseUrl: config.advisor.baseUrl,
    advisorOnError: config.advisor.onError,
  };
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} : nombre positif attendu`);
  return number;
}

function assign(target, keys, value) {
  let node = target;
  for (const key of keys.slice(0, -1)) node = node[key] ??= {};
  node[keys.at(-1)] = value;
}

// N'écrit que ce qui a changé : le reste continue d'hériter des règles communes.
export function settingsPatch(config, body) {
  const patch = {};
  const update = (keys, current, next) => {
    if (next !== undefined && JSON.stringify(current) !== JSON.stringify(next)) assign(patch, keys, next);
  };

  const urls = (body.urls ?? []).map((url) => url.trim()).filter(Boolean);
  update(['health', 'urls'], config.health.urls, urls);
  update(['health', 'maxP95LatencyMs'], config.health.maxP95LatencyMs, positiveNumber(body.maxP95LatencyMs, 'Latence maximale'));
  update(['schedule', 'timezone'], config.schedule.timezone, body.timezone);
  update(['schedule', 'windows'], config.schedule.windows, body.windows);
  update(['schedule', 'freezes'], config.schedule.freezes, body.freezes);
  update(['schedule', 'detectIntervalMinutes'], config.schedule.detectIntervalMinutes, positiveNumber(body.detectIntervalMinutes, 'Fréquence de vérification'));
  update(['policy', 'maxAutoPerDay'], config.policy.maxAutoPerDay, positiveNumber(body.maxAutoPerDay, 'Quota journalier'));
  update(['policy', 'maxConsecutiveFailures'], config.policy.maxConsecutiveFailures, positiveNumber(body.maxConsecutiveFailures, 'Échecs avant pause'));
  update(['detectors', 'dependencies', 'enabled'], config.detectors.dependencies.enabled, Boolean(body.dependenciesEnabled));
  update(['detectors', 'code', 'enabled'], config.detectors.code.enabled, Boolean(body.codeEnabled));

  if (body.advisorEnabled !== undefined) {
    const model = String(body.advisorModel ?? config.advisor.model).trim();
    const baseUrl = String(body.advisorBaseUrl ?? config.advisor.baseUrl).trim();
    if (!model) throw new Error('Indiquez le modèle Ollama, par exemple qwen2.5:7b.');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`Adresse d'Ollama invalide : ${baseUrl}`);
    if (!['rules', 'approval'].includes(body.advisorOnError ?? config.advisor.onError)) throw new Error('Choix invalide si le modèle ne répond pas.');
    update(['advisor', 'enabled'], config.advisor.enabled, Boolean(body.advisorEnabled));
    update(['advisor', 'model'], config.advisor.model, model);
    update(['advisor', 'baseUrl'], config.advisor.baseUrl, baseUrl);
    update(['advisor', 'onError'], config.advisor.onError, body.advisorOnError ?? config.advisor.onError);
  }

  for (const name of COMMAND_NAMES) {
    const next = body.commands?.[name]?.trim() ?? '';
    update(['site', 'commands', name], config.site.commands[name] ?? '', next);
    if (patch.site?.commands && name in patch.site.commands && !next) patch.site.commands[name] = null;
  }

  const sources = body.sources ?? [];
  for (const source of sources) {
    if (!source.name?.trim() || !(source.url?.trim() || source.file?.trim())) {
      throw new Error('Chaque source de contenu doit avoir un nom et une adresse.');
    }
    if (source.url && !/^https?:\/\//i.test(source.url)) throw new Error(`Adresse de source invalide : ${source.url}`);
    resolveTarget(config.site.dir, source.target ?? '');
  }
  if (body.contentEnabled && !sources.length) throw new Error('Ajoutez une source pour activer le suivi du contenu.');
  update(['detectors', 'content', 'enabled'], config.detectors.content.enabled, Boolean(body.contentEnabled));
  update(['detectors', 'content', 'sources'], config.detectors.content.sources, sources);

  // Le tableau n'exprime pas les règles personnalisées : on n'y touche que s'il a réellement changé.
  if (body.matrix && JSON.stringify(currentMatrix(config.policy)) !== JSON.stringify({ ...currentMatrix(config.policy), ...body.matrix })) {
    patch.policy = { ...patch.policy, rules: matrixToRules(body.matrix) };
  }
  return patch;
}
