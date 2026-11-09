import { createHash } from 'node:crypto';
import { runShell } from '../exec.js';

const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];
const SAFE_NAME = /^(@[a-z0-9~._-]+\/)?[a-z0-9~._-]+$/i;
const SAFE_VERSION = /^[0-9a-z.+-]+$/i;

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return match ? match.slice(1).map(Number) : null;
}

export function classifyUpdate(current, target) {
  const from = parseVersion(current);
  const to = parseVersion(target);
  if (!from || !to) return 'unknown';
  if (to[0] !== from[0]) return 'major';
  if (to[1] !== from[1]) return 'minor';
  return 'patch';
}

const RISK_BY_KIND = { patch: 'low', minor: 'medium', major: 'high', unknown: 'high' };

function highestSeverity(severities) {
  return severities.reduce(
    (highest, severity) => (SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(highest) ? severity : highest),
    'info',
  );
}

export function buildChanges(outdated, audit) {
  const vulnerabilities = audit?.vulnerabilities ?? {};
  const changes = [];

  for (const [name, entry] of Object.entries(outdated ?? {})) {
    if (!entry.current) continue;
    // La version compatible avec la plage déclarée passe d'abord ; la majeure vient ensuite, seule.
    const target = entry.wanted && entry.wanted !== entry.current ? entry.wanted : entry.latest;
    if (!target || target === entry.current) continue;
    if (!SAFE_NAME.test(name) || !SAFE_VERSION.test(target)) continue;

    const updateKind = classifyUpdate(entry.current, target);
    const severity = vulnerabilities[name]?.severity ?? null;
    changes.push({
      id: `dependency:${name}@${target}`,
      type: 'dependency',
      title: `${name} ${entry.current} → ${target}${severity ? ` (faille ${severity})` : ''}`,
      updateKind,
      severity,
      risk: RISK_BY_KIND[updateKind],
      payload: { kind: 'package', name, target },
    });
  }

  const transitive = Object.entries(vulnerabilities).filter(
    ([, vulnerability]) =>
      !vulnerability.isDirect && vulnerability.fixAvailable && vulnerability.fixAvailable.isSemVerMajor !== true,
  );
  if (transitive.length) {
    const names = transitive.map(([name]) => name).sort();
    const fingerprint = createHash('sha256').update(names.join(',')).digest('hex').slice(0, 12);
    const severity = highestSeverity(transitive.map(([, vulnerability]) => vulnerability.severity));
    changes.push({
      id: `dependency:audit-fix:${fingerprint}`,
      type: 'dependency',
      title: `Correctif de ${names.length} dépendance(s) indirecte(s) (faille ${severity})`,
      updateKind: 'transitive',
      severity,
      risk: 'medium',
      payload: { kind: 'audit-fix' },
    });
  }
  return changes;
}

async function readJson(command, cwd) {
  // npm renvoie un code d'erreur dès qu'il trouve quelque chose : seul un JSON illisible est un échec.
  const { stdout } = await runShell(command, { cwd, allowFailure: true });
  const parsed = JSON.parse(stdout.trim() || '{}');
  if (parsed.error) throw new Error(`${command} : ${parsed.error.summary ?? parsed.error.code}`);
  return parsed;
}

export async function detect({ config }) {
  const cwd = config.site.dir;
  const [outdated, audit] = await Promise.all([readJson('npm outdated --json', cwd), readJson('npm audit --json', cwd)]);
  return buildChanges(outdated, audit);
}

export async function apply(change, { config }) {
  const options = { cwd: config.site.dir, timeoutSeconds: config.site.commandTimeoutSeconds };
  if (change.payload.kind === 'audit-fix') {
    await runShell('npm audit fix', options);
    return;
  }
  await runShell(`npm install ${change.payload.name}@${change.payload.target}`, options);
}
