// Ouvre l'interface sur trois sites locaux factices, sans toucher à votre configuration.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { Advisor } from '../src/advisor.js';
import { DEFAULTS } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { createUiServer, openInBrowser } from '../src/ui/server.js';
import { createSandbox } from './sandbox.js';

const home = mkdtempSync(path.join(tmpdir(), 'site-agent-ui-demo-'));
writeFileSync(path.join(home, 'agent.defaults.json'), JSON.stringify({ schedule: { timezone: 'Europe/Paris' } }));

const registry = new Registry(home);
const [boutique, vitrine, blog] = await Promise.all([createSandbox(), createSandbox(), createSandbox()]);
const raw = (sandbox, dryRun) => ({ ...sandbox.raw, stateDir: undefined, dryRun });

await registry.add('boutique', raw(boutique, false));
await registry.add('vitrine', raw(vitrine, true));
await registry.add('blog', raw(blog, false));

boutique.pushCode('migrations/001.sql', 'ALTER TABLE produits ADD promo INT;\n');
vitrine.setSource({ price: 12 });
blog.takeDown();

// Sans Ollama, la démo montre l'analyse IA avec des réponses écrites d'avance.
const demoAdvisor = new Advisor({ ...DEFAULTS.advisor, model: 'démo (sans Ollama)' }, {
  model: new FakeListChatModel({
    responses: [
      JSON.stringify({
        risk: 'high',
        recommendation: 'review',
        summary: 'Ajoute une colonne à la table des produits. Sans valeur par défaut, les pages produits peuvent échouer tant que le code ne la remplit pas.',
        concerns: ['Vérifier que la migration est jouée avant le déploiement du code', 'Prévoir une valeur par défaut pour les produits existants'],
      }),
      JSON.stringify({ risk: 'low', recommendation: 'apply', summary: 'Changement de prix sur la page d’accueil, sans effet sur le fonctionnement.', concerns: [] }),
    ],
  }),
});

const server = await createUiServer(registry, { port: Number(process.env.PORT ?? 4310), requireAuth: false, agentOptions: { advisor: demoAdvisor } });
const { origin } = await server.listen();
console.log(`Démo disponible à cette adresse :\n${origin}`);
if (!process.argv.includes('--no-open')) openInBrowser(origin);

const stop = async () => {
  await server.close();
  await Promise.all([boutique.close(), vitrine.close(), blog.close()]);
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
