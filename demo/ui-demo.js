// Ouvre l'interface sur trois sites locaux factices, sans toucher à votre configuration.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

const server = await createUiServer(registry, { port: Number(process.env.PORT ?? 4310), requireAuth: false });
const { loginUrl } = await server.listen();
console.log(`Démo disponible à cette adresse :\n${loginUrl}`);
if (!process.argv.includes('--no-open')) openInBrowser(loginUrl);

const stop = async () => {
  await server.close();
  await Promise.all([boutique.close(), vitrine.close(), blog.close()]);
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
