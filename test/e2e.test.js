import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createSandbox } from '../demo/sandbox.js';

async function withSandbox(options, scenario) {
  const sandbox = await createSandbox(options);
  try {
    await scenario(sandbox);
  } finally {
    await sandbox.close();
  }
}

function outcomeOf(report, type) {
  return report.decisions.find(({ id }) => id.startsWith(type))?.outcome;
}

test('contenu à faible risque : déployé et poussé sans intervention', () =>
  withSandbox({}, async (s) => {
    s.setSource({ price: 12 });
    const report = await s.agent.runCycle();
    assert.equal(report.applied.result, 'deployed');
    assert.equal(s.content().price, 12);
    assert.equal(s.deployCount(), 1);
    assert.equal(s.remoteHead(), s.head());
    assert.equal((await s.agent.status()).lastKnownGood, s.head());
  }));

test('site cassé après déploiement : retour arrière et blocage durable', () =>
  withSandbox({}, async (s) => {
    await s.agent.runCycle();
    const before = s.head();
    const remoteBefore = s.remoteHead();

    s.setSource({ broken: true });
    const report = await s.agent.runCycle();

    assert.equal(report.applied.result, 'rolled-back');
    assert.equal(s.head(), before);
    assert.equal(s.content().broken, undefined);
    assert.equal(s.remoteHead(), remoteBefore, 'une version cassée ne doit jamais être poussée');
    assert.equal(s.deployCount(), 2, 'déploiement fautif puis redéploiement de la version saine');

    const retry = await s.agent.runCycle();
    assert.equal(outcomeOf(retry, 'content'), 'blocked');
    assert.equal(retry.applied, null);
    assert.equal(s.deployCount(), 2);
  }));

test('échec de déploiement : retour arrière', () =>
  withSandbox({}, async (s) => {
    const before = s.head();
    s.setSource({ failDeploy: true });
    const report = await s.agent.runCycle();
    assert.equal(report.applied.result, 'rolled-back');
    assert.equal(s.head(), before);
  }));

test('tests en échec : aucun déploiement', () =>
  withSandbox({}, async (s) => {
    const before = s.head();
    s.setSource({ failTests: true });
    const report = await s.agent.runCycle();
    assert.equal(report.applied.result, 'preparation-failed');
    assert.equal(s.head(), before);
    assert.equal(s.deployCount(), 0);
    assert.equal(s.content().failTests, undefined);
  }));

test('code sensible : attend une validation, puis est déployé', () =>
  withSandbox({}, async (s) => {
    const sha = s.pushCode('migrations/001.sql', 'ALTER TABLE t ADD c INT;\n');
    const first = await s.agent.runCycle();
    assert.equal(outcomeOf(first, 'code'), 'awaiting-approval');
    assert.notEqual(s.head(), sha);

    const id = `code:${sha}`;
    assert.ok((await s.agent.status()).pending[id]);
    await s.agent.approve(id);

    const second = await s.agent.runCycle();
    assert.equal(second.applied.result, 'deployed');
    assert.equal(s.head(), sha);
    assert.deepEqual((await s.agent.status()).pending, {});
  }));

test('approbation périmée : un nouveau commit exige une nouvelle validation', () =>
  withSandbox({}, async (s) => {
    const sha = s.pushCode('migrations/001.sql', 'A;\n');
    await s.agent.runCycle();
    await s.agent.approve(`code:${sha}`);

    const newer = s.pushCode('migrations/002.sql', 'B;\n');
    const report = await s.agent.runCycle();

    assert.equal(report.applied, null);
    assert.equal(outcomeOf(report, 'code'), 'awaiting-approval');
    const state = await s.agent.status();
    assert.deepEqual(state.approved, []);
    assert.ok(state.pending[`code:${newer}`]);
    assert.equal(state.pending[`code:${sha}`], undefined);
  }));

test('refus humain : le changement reste bloqué', () =>
  withSandbox({}, async (s) => {
    const id = `code:${s.pushCode('migrations/001.sql', 'A;\n')}`;
    await s.agent.runCycle();
    await s.agent.reject(id);
    const report = await s.agent.runCycle();
    assert.equal(outcomeOf(report, 'code'), 'blocked');
  }));

test('petit code : déployé automatiquement', () =>
  withSandbox({}, async (s) => {
    const sha = s.pushCode('page.html', '<p>Bonjour</p>\n');
    const report = await s.agent.runCycle();
    assert.equal(report.applied.result, 'deployed');
    assert.equal(s.head(), sha);
  }));

test('hors plage horaire : reporté, puis déployé dans la plage', async () => {
  let current = new Date('2026-03-09T12:00:00Z');
  const overrides = { schedule: { timezone: 'UTC', windows: [{ start: '02:00', end: '04:00' }] } };
  await withSandbox({ overrides, now: () => current }, async (s) => {
    s.setSource({ price: 12 });
    const closed = await s.agent.runCycle();
    assert.equal(outcomeOf(closed, 'content'), 'deferred');
    assert.equal(s.deployCount(), 0);

    current = new Date('2026-03-10T03:00:00Z');
    const open = await s.agent.runCycle();
    assert.equal(open.applied.result, 'deployed');
  });
});

test('site instable : aucune mise à jour, puis redémarrage après le seuil', () =>
  withSandbox({}, async (s) => {
    s.setSource({ price: 12 });
    s.takeDown();

    const first = await s.agent.runCycle();
    assert.equal(first.health.healthy, false);
    assert.equal(outcomeOf(first, 'content'), 'deferred');
    assert.equal(first.incident.action, 'observed');

    const second = await s.agent.runCycle({ detect: false });
    assert.equal(second.incident.action, 'restarted');
    assert.equal(s.deployCount(), 0);

    const third = await s.agent.runCycle();
    assert.equal(third.applied.result, 'deployed');
  }));

test('panne non résolue par un redémarrage : retour à la dernière version saine', () =>
  withSandbox({}, async (s) => {
    await s.agent.runCycle();
    const good = s.head();
    s.commitBrokenSite();

    await s.agent.runCycle({ detect: false });
    const report = await s.agent.runCycle({ detect: false });

    assert.equal(report.incident.action, 'rolled-back');
    assert.equal(s.head(), good);
    assert.equal((await s.agent.runCycle({ detect: false })).health.healthy, true);
  }));

test('panne irréparable : pause et intervention humaine, sans boucle', () =>
  withSandbox({}, async (s) => {
    s.commitBrokenSite(); // Aucune version saine connue : l'agent n'a jamais vu le site en bonne santé.
    await s.agent.runCycle({ detect: false });
    const second = await s.agent.runCycle({ detect: false });
    assert.equal(second.incident.action, 'manual-required');
    assert.ok((await s.agent.status()).paused);

    const third = await s.agent.runCycle({ detect: false });
    assert.equal(third.incident.action, 'paused');
    assert.equal(s.deployCount(), 0);
  }));

test('coupe-circuit : deux échecs de suite mettent en pause, resume relance', () =>
  withSandbox({ overrides: { policy: { rules: [{ when: { type: 'content' }, action: 'auto' }] } } }, async (s) => {
    s.setSource({ broken: true });
    await s.agent.runCycle();
    s.setSource({ broken: true, price: 11 });
    await s.agent.runCycle();
    assert.ok((await s.agent.status()).paused);

    s.setSource({ price: 13 });
    const paused = await s.agent.runCycle();
    assert.equal(outcomeOf(paused, 'content'), 'deferred');
    assert.equal(paused.applied, null);

    await s.agent.resume();
    const resumed = await s.agent.runCycle();
    assert.equal(resumed.applied.result, 'deployed');
  }));

test('quota journalier : les automatismes s’arrêtent au plafond', () =>
  withSandbox({ overrides: { policy: { maxAutoPerDay: 1, rules: [{ when: { type: 'content' }, action: 'auto' }] } } }, async (s) => {
    s.setSource({ price: 11 });
    assert.equal((await s.agent.runCycle()).applied.result, 'deployed');
    s.setSource({ price: 12 });
    const report = await s.agent.runCycle();
    assert.equal(outcomeOf(report, 'content'), 'deferred');
    assert.equal(s.deployCount(), 1);
  }));

test('simulation : décide sans rien modifier', () =>
  withSandbox({ overrides: { dryRun: true } }, async (s) => {
    const before = s.head();
    s.setSource({ price: 12 });
    const report = await s.agent.runCycle();
    assert.equal(outcomeOf(report, 'content'), 'apply');
    assert.equal(report.applied, null);
    assert.equal(s.head(), before);
    assert.equal(s.deployCount(), 0);
    assert.equal(s.content().price, 10);
    assert.equal((await s.agent.status()).lastKnownGood, null);
  }));

test('fichiers modifiés à la main : l’agent ne les écrase pas', () =>
  withSandbox({}, async (s) => {
    s.dirty();
    s.setSource({ price: 12 });
    const report = await s.agent.runCycle();
    assert.equal(report.applied.result, 'dirty-worktree');
    assert.equal(s.content().price, 10);
    assert.equal(s.deployCount(), 0);
  }));

test('fins de ligne réécrites par Git : pas de faux changement de contenu', () =>
  withSandbox({}, async (s) => {
    const file = path.join(s.siteDir, 'content.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    const report = await s.agent.runCycle();
    assert.deepEqual(report.decisions, []);
  }));

test('après un retour arrière : le contenu sain n’est plus vu comme modifié', () =>
  withSandbox({}, async (s) => {
    s.setSource({ price: 12 });
    await s.agent.runCycle();
    s.setSource({ price: 12, broken: true });
    assert.equal((await s.agent.runCycle()).applied.result, 'rolled-back');
    s.setSource({ price: 12 });
    assert.deepEqual((await s.agent.runCycle()).decisions, []);
  }));

test('contenu invalide : refusé dès la détection', () =>
  withSandbox({}, async (s) => {
    s.setSource({ title: undefined });
    const report = await s.agent.runCycle();
    assert.equal(report.decisions.length, 0);
    assert.equal(s.deployCount(), 0);
  }));
