import { createSandbox } from './sandbox.js';

function step(title) {
  console.log(`\n── ${title}`);
}

function show(report) {
  for (const { title, outcome, reasons } of report.decisions) {
    console.log(`   [${outcome}] ${title} — ${reasons.join(' ; ')}`);
  }
  if (report.applied) console.log(`   Résultat : ${report.applied.result}`);
  if (report.incident) console.log(`   Incident : ${report.incident.action}`);
}

const sandbox = await createSandbox({ silent: false });
const { agent } = sandbox;

try {
  step('1. État initial : le site est sain, rien à faire');
  show(await agent.runCycle());

  step('2. Petite modification de contenu : déployée automatiquement');
  sandbox.setSource({ price: 12 });
  show(await agent.runCycle());

  step('3. Contenu qui casse le site : déployé, détecté, annulé');
  sandbox.setSource({ price: 12, broken: true });
  show(await agent.runCycle());
  console.log(`   Prix en ligne après retour arrière : ${sandbox.content().price}`);
  show(await agent.runCycle());

  step('4. Code sensible : mis en attente de validation');
  sandbox.setSource({ price: 12 });
  sandbox.pushCode('migrations/001.sql', 'ALTER TABLE t ADD c INT;\n');
  const pending = await agent.runCycle();
  show(pending);
  const { id } = pending.decisions.find(({ outcome }) => outcome === 'awaiting-approval');

  step(`5. Validation humaine de ${id.slice(0, 13)}… : déployé au cycle suivant`);
  await agent.approve(id);
  show(await agent.runCycle());

  step('6. Panne du site : redémarrage automatique après 2 échecs');
  sandbox.takeDown();
  show(await agent.runCycle({ detect: false }));
  show(await agent.runCycle({ detect: false }));
} finally {
  await sandbox.close();
}
