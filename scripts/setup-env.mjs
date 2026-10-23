// Creates .env from .env.example with fresh random tokens (never committed). Usage: npm run setup
// If .env already exists it is kept; only APP_TOKEN / DEVICE_REGISTRY are added when they are missing.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
const rnd = () => crypto.randomBytes(18).toString('hex');
const deviceToken = rnd();
const registry = (tok) => `[{"deviceId":"esp32-01","plotId":1,"token":"${tok}"}]`;
if (existsSync('.env')) {
  const cur = readFileSync('.env', 'utf8');
  const add = [];
  if (!/^APP_TOKEN=\S+/m.test(cur)) add.push(`APP_TOKEN=${rnd()}`);
  if (!/^DEVICE_REGISTRY=\S+/m.test(cur)) add.push(`DEVICE_REGISTRY=${registry(deviceToken)}`);
  if (add.length) { appendFileSync('.env', (cur.endsWith('\n') ? '' : '\n') + add.join('\n') + '\n'); console.log(`.env existed; added ${add.map((a) => a.split('=')[0]).join(' and ')}.`); }
  else console.log('.env already complete; leaving it alone.');
  process.exit(0);
}
let t = readFileSync('.env.example', 'utf8');
t = t.replace('APP_TOKEN=replace-with-random-string', `APP_TOKEN=${rnd()}`)
     .replace('replace-with-random-device-token', deviceToken);
writeFileSync('.env', t, { mode: 0o600 });
console.log('Created .env with random APP_TOKEN and a device token for esp32-01 (plot 1). Open .env to see them; do not commit it.');
