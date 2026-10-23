import { loadEnvFile } from './env.js';
import { loadConfig } from './config.js';
import { createOeClient } from './oe/client.js';
import { createProvider } from './ai/provider.js';
import { buildApp } from './app.js';

loadEnvFile();
const config = loadConfig();
if (config.problems.length) {
  console.error('Cannot start:\n - ' + config.problems.join('\n - '));
  process.exit(1);
}
const oe = createOeClient(config);
const provider = createProvider(config);
const app = buildApp({ config, oe, provider });
await app.listen({ port: config.port, host: config.host });
console.log(`mzansi-farmer-ops API on http://${config.host}:${config.port}  (OE_MODE=${oe.mode}, AI=${provider.name})  EXAMPLE DATA ONLY`);
if (oe.mode === 'mock') console.log('NOTE: OE_MODE=mock uses the Node port of the ABL rules (mock-pasoe), not a real OpenEdge database.');
