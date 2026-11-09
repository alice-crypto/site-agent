import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 1_000_000;

// Git peut réécrire les fins de ligne à l'extraction (core.autocrlf) : elles ne comptent pas comme un changement.
function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

export function changeRatio(previous, next) {
  const previousLines = new Set(previous.split('\n'));
  const nextLines = next.split('\n');
  const changed = nextLines.filter((line) => !previousLines.has(line)).length;
  return changed / Math.max(nextLines.length, previous.split('\n').length);
}

export function validateContent(body, source) {
  const maxBytes = source.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(body) > maxBytes) return `taille supérieure à ${maxBytes} octets`;
  if (!body.trim()) return 'contenu vide';
  if (source.format !== 'json') return null;

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'JSON invalide';
  }
  const missing = (source.requiredKeys ?? []).filter((key) => !(key in Object(parsed)));
  return missing.length ? `clés manquantes : ${missing.join(', ')}` : null;
}

export function resolveTarget(siteDir, target) {
  const resolved = path.resolve(siteDir, target);
  const relative = path.relative(siteDir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`La cible ${target} sort du dossier du site`);
  }
  return resolved;
}

async function readSource(source, { config, fetchImpl }) {
  if (source.file) return readFile(path.resolve(config.baseDir, source.file), 'utf8');
  const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(config.health.timeoutMs * 2) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export async function detect(context) {
  const { config, warn } = context;
  const { sources, maxLowRiskChangeRatio } = config.detectors.content;
  const changes = [];

  for (const source of sources) {
    let body;
    try {
      body = await readSource(source, context);
    } catch (error) {
      await warn(`Source de contenu ${source.name} illisible : ${error.message}`);
      continue;
    }

    const invalid = validateContent(body, source);
    if (invalid) {
      await warn(`Contenu ${source.name} refusé : ${invalid}`);
      continue;
    }

    const target = resolveTarget(config.site.dir, source.target);
    const existing = await readFile(target, 'utf8').catch(() => null);
    const previous = existing === null ? null : normalizeNewlines(existing);
    const next = normalizeNewlines(body);
    if (previous === next) continue;

    const ratio = previous === null ? 1 : changeRatio(previous, next);
    const fingerprint = createHash('sha256').update(next).digest('hex').slice(0, 12);
    changes.push({
      id: `content:${source.name}:${fingerprint}`,
      type: 'content',
      title: `Contenu ${source.name} : ${Math.round(ratio * 100)} % modifié`,
      source: source.name,
      changeRatio: ratio,
      risk: previous !== null && ratio <= maxLowRiskChangeRatio ? 'low' : 'medium',
      payload: { target, body },
    });
  }
  return changes;
}

// Écrit le contenu déjà validé à la détection : on ne relit pas une source qui a pu changer entre-temps.
export async function apply(change) {
  await mkdir(path.dirname(change.payload.target), { recursive: true });
  await writeFile(change.payload.target, change.payload.body);
}
