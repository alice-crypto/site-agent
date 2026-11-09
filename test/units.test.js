import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeConfig } from '../src/config.js';
import { createWebhookServer, verifySignature } from '../src/daemon.js';
import { classifyCodeRisk } from '../src/detectors/code.js';
import { changeRatio, resolveTarget, validateContent } from '../src/detectors/content.js';
import { buildChanges, classifyUpdate } from '../src/detectors/dependencies.js';
import { probe } from '../src/health.js';
import { decide } from '../src/policy.js';
import { scheduleStatus } from '../src/schedule.js';

const POLICY = {
  default: 'approval',
  maxAutoPerDay: 2,
  rules: [
    { name: 'faille', when: { type: 'dependency', severity: ['critical'] }, action: 'auto', bypassWindow: true },
    { name: 'correctif', when: { type: 'dependency', updateKind: 'patch' }, action: 'auto' },
    { name: 'interdit', when: { type: 'code', risk: 'high' }, action: 'deny' },
  ],
};

function context(overrides = {}) {
  return {
    policy: POLICY,
    state: { blocked: {}, approved: [], paused: null },
    healthy: true,
    schedule: { allowed: true, frozen: false, reason: null },
    autoCountToday: 0,
    ...overrides,
  };
}

const patch = { id: 'a', type: 'dependency', updateKind: 'patch', risk: 'low' };
const critical = { id: 'b', type: 'dependency', updateKind: 'minor', severity: 'critical', risk: 'medium' };
const major = { id: 'c', type: 'dependency', updateKind: 'major', risk: 'high' };
const closed = { allowed: false, frozen: false, reason: 'hors plage autorisée' };
const frozen = { allowed: false, frozen: true, reason: 'gel' };

test('politique : une règle auto applique le changement', () => {
  assert.equal(decide(patch, context()).outcome, 'apply');
});

test('politique : sans règle, la validation humaine est requise', () => {
  assert.equal(decide(major, context()).outcome, 'awaiting-approval');
});

test('politique : deny ne peut pas être contourné', () => {
  const change = { id: 'd', type: 'code', risk: 'high' };
  assert.equal(decide(change, context()).outcome, 'denied');
});

test('politique : hors plage, seule une règle bypassWindow passe', () => {
  assert.equal(decide(patch, context({ schedule: closed })).outcome, 'deferred');
  assert.equal(decide(critical, context({ schedule: closed })).outcome, 'apply');
});

test('politique : un gel arrête tout, même bypassWindow et approbation', () => {
  assert.equal(decide(critical, context({ schedule: frozen })).outcome, 'deferred');
  const state = { blocked: {}, approved: ['c'], paused: null };
  assert.equal(decide(major, context({ schedule: frozen, state })).outcome, 'deferred');
});

test('politique : un site instable reporte même une approbation', () => {
  const state = { blocked: {}, approved: ['c'], paused: null };
  assert.equal(decide(major, context({ healthy: false, state })).outcome, 'deferred');
  assert.equal(decide(major, context({ state })).outcome, 'apply');
});

test('politique : le quota limite les automatismes, pas les approbations', () => {
  assert.equal(decide(patch, context({ autoCountToday: 2 })).outcome, 'deferred');
  const state = { blocked: {}, approved: ['c'], paused: null };
  assert.equal(decide(major, context({ autoCountToday: 2, state })).outcome, 'apply');
});

test('politique : blocage et pause priment', () => {
  const blockedState = { blocked: { a: { reason: 'x' } }, approved: [], paused: null };
  assert.equal(decide(patch, context({ state: blockedState })).outcome, 'blocked');
  const pausedState = { blocked: {}, approved: [], paused: { reason: 'x' } };
  assert.equal(decide(patch, context({ state: pausedState })).outcome, 'deferred');
});

const PARIS_NIGHT = {
  timezone: 'Europe/Paris',
  windows: [{ days: ['mon'], start: '23:00', end: '02:00' }],
  freezes: [],
};

test('calendrier : plage à cheval sur minuit et fuseau horaire', () => {
  // Lundi 9 mars 2026 à 23 h 30 à Paris = 22 h 30 UTC.
  assert.equal(scheduleStatus(new Date('2026-03-09T22:30:00Z'), PARIS_NIGHT).allowed, true);
  // Mardi à 1 h à Paris : encore dans la plage commencée lundi.
  assert.equal(scheduleStatus(new Date('2026-03-10T00:00:00Z'), PARIS_NIGHT).allowed, true);
  // Mardi à 3 h : terminé.
  assert.equal(scheduleStatus(new Date('2026-03-10T02:00:00Z'), PARIS_NIGHT).allowed, false);
  // Mardi à 23 h 30 : mauvais jour.
  assert.equal(scheduleStatus(new Date('2026-03-10T22:30:00Z'), PARIS_NIGHT).allowed, false);
});

test('calendrier : sans plage tout est permis, sauf en période de gel', () => {
  const schedule = { timezone: 'UTC', windows: [], freezes: [{ from: '2026-12-20', to: '2027-01-02' }] };
  assert.equal(scheduleStatus(new Date('2026-06-01T12:00:00Z'), schedule).allowed, true);
  const status = scheduleStatus(new Date('2026-12-25T12:00:00Z'), schedule);
  assert.equal(status.allowed, false);
  assert.equal(status.frozen, true);
});

test('dépendances : classification des versions', () => {
  assert.equal(classifyUpdate('1.2.3', '1.2.4'), 'patch');
  assert.equal(classifyUpdate('1.2.3', '1.3.0'), 'minor');
  assert.equal(classifyUpdate('1.2.3', '2.0.0'), 'major');
  assert.equal(classifyUpdate('1.2.3', '2.0.0-beta.1'), 'unknown');
});

test('dépendances : préfère la version compatible et ajoute la gravité', () => {
  const [change] = buildChanges(
    { express: { current: '4.1.0', wanted: '4.1.5', latest: '5.0.0' } },
    { vulnerabilities: { express: { severity: 'high', isDirect: true, fixAvailable: true } } },
  );
  assert.equal(change.id, 'dependency:express@4.1.5');
  assert.equal(change.updateKind, 'patch');
  assert.equal(change.severity, 'high');
  assert.equal(change.risk, 'low');
});

test('dépendances : ignore les noms dangereux pour le shell', () => {
  const changes = buildChanges({ 'x & calc': { current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' } }, {});
  assert.deepEqual(changes, []);
});

test('dépendances : regroupe les failles indirectes, sans rupture majeure', () => {
  const changes = buildChanges({}, {
    vulnerabilities: {
      a: { severity: 'moderate', isDirect: false, fixAvailable: true },
      b: { severity: 'critical', isDirect: false, fixAvailable: true },
      c: { severity: 'critical', isDirect: false, fixAvailable: { isSemVerMajor: true } },
      d: { severity: 'high', isDirect: false, fixAvailable: false },
    },
  });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].updateKind, 'transitive');
  assert.equal(changes[0].severity, 'critical');
  assert.match(changes[0].title, /2 dépendance/);
});

test('code : le risque dépend de la taille et des chemins sensibles', () => {
  const limits = { maxLowRiskFiles: 2, maxLowRiskLines: 10, sensitivePaths: ['^migrations/'] };
  assert.equal(classifyCodeRisk([{ file: 'a.js', added: 1, deleted: 1 }], limits).risk, 'low');
  assert.equal(classifyCodeRisk([{ file: 'a.js', added: 50, deleted: 0 }], limits).risk, 'medium');
  assert.equal(classifyCodeRisk([{ file: 'migrations/1.sql', added: 1, deleted: 0 }], limits).risk, 'high');
});

test('contenu : validation du format, de la taille et des clés', () => {
  const source = { format: 'json', requiredKeys: ['title'], maxBytes: 100 };
  assert.equal(validateContent('{"title":"x"}', source), null);
  assert.match(validateContent('{oups', source), /JSON invalide/);
  assert.match(validateContent('{"a":1}', source), /clés manquantes/);
  assert.match(validateContent(`{"title":"${'x'.repeat(200)}"}`, source), /taille/);
  assert.match(validateContent('null', source), /clés manquantes/);
});

test('contenu : la cible ne peut pas sortir du site', () => {
  const site = path.resolve('site');
  assert.equal(resolveTarget(site, 'public/a.json'), path.join(site, 'public', 'a.json'));
  assert.throws(() => resolveTarget(site, '../secret'));
  assert.throws(() => resolveTarget(site, path.resolve('ailleurs')));
  assert.throws(() => resolveTarget(site, '.'));
});

test('contenu : ratio de lignes modifiées', () => {
  assert.equal(changeRatio('a\nb\nc\nd', 'a\nb\nc\nX'), 0.25);
  assert.equal(changeRatio('a', 'a'), 0);
});

test('webhook : signature HMAC vérifiée', () => {
  const body = Buffer.from('{}');
  const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
  assert.equal(verifySignature('secret', body, signature), true);
  assert.equal(verifySignature('autre', body, signature), false);
  assert.equal(verifySignature('secret', body, 'sha256=abc'), false);
  assert.equal(verifySignature('secret', body, undefined), false);
});

test('webhook : seul un appel signé déclenche une vérification', async () => {
  const triggers = [];
  const server = createWebhookServer({
    resolveSecret: async (name) => (name === 'alpha' ? 'secret' : null),
    onTrigger: (name) => triggers.push(name),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/webhook`;
  const url = `${base}/alpha`;
  const body = '{"ref":"refs/heads/main"}';
  const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
  try {
    const post = (headers) => fetch(url, { method: 'POST', body, headers });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ 'x-hub-signature-256': 'sha256=faux' })).status, 401);
    assert.deepEqual(triggers, []);
    assert.equal((await post({ 'x-hub-signature-256': signature })).status, 202);
    assert.deepEqual(triggers, ['alpha']);
    assert.equal((await fetch(url)).status, 404);
    const unknown = await fetch(`${base}/inconnu`, { method: 'POST', body, headers: { 'x-hub-signature-256': signature } });
    assert.equal(unknown.status, 401);
    assert.equal((await fetch(`${base}/..%2Fx`, { method: 'POST', body })).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('santé : erreurs et texte attendu', async () => {
  const sleep = async () => {};
  const health = { urls: ['http://x/'], samples: 2, intervalMs: 0, timeoutMs: 100, maxErrorRate: 0, maxP95LatencyMs: 5000, mustContain: 'ok' };
  const respond = (status, text) => async () => new Response(text, { status });
  assert.equal((await probe(health, { fetchImpl: respond(200, 'ok'), sleep })).healthy, true);
  assert.equal((await probe(health, { fetchImpl: respond(500, 'ok'), sleep })).healthy, false);
  assert.equal((await probe(health, { fetchImpl: respond(200, 'autre'), sleep })).healthy, false);
  const down = await probe(health, { fetchImpl: async () => { throw new Error('refusé'); }, sleep });
  assert.equal(down.healthy, false);
  assert.equal(down.errorRate, 1);
});

test('configuration : rejette ce qui est dangereux ou incomplet', () => {
  const base = { site: { dir: 'x' }, health: { urls: ['http://x/'] } };
  assert.equal(normalizeConfig(base).dryRun, true);
  assert.throws(() => normalizeConfig({ health: base.health }), /site\.dir/);
  assert.throws(() => normalizeConfig({ ...base, dryRun: false }), /deploy/);
  assert.throws(() => normalizeConfig({ ...base, policy: { default: 'yolo' } }), /policy\.default/);
  assert.throws(() => normalizeConfig({ ...base, schedule: { timezone: 'Mars/Olympus' } }), /timezone/);
});
