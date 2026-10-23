// Creates .env from .env.example with fresh random tokens (never committed). Usage: npm run setup
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
if (existsSync('.env')) { console.log('.env already exists; leaving it alone.'); process.exit(0); }
const rnd = () => crypto.randomBytes(18).toString('hex');
const deviceToken = rnd();
let t = readFileSync('.env.example', 'utf8');
t = t.replace('APP_TOKEN=replace-with-random-string', `APP_TOKEN=${rnd()}`)
     .replace('replace-with-random-device-token', deviceToken);
writeFileSync('.env', t, { mode: 0o600 });
console.log('Created .env with random APP_TOKEN and device token for esp32-01 (plot 1). Open .env to see them; do not commit it.');
