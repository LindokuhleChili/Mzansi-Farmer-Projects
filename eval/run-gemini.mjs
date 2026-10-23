// npm run test:gemini : ONE live check of the real AI provider (Gemini through its OpenAI-compatible API).
// Skipped (exit 0) unless AI_PROVIDER=http and AI_BASE_URL, AI_API_KEY, AI_MODEL are set (environment or .env).
// OpenEdge is the in-process mock here; the point is to prove the real model's answer passes the schema, is not
// replaced by the fallback, and is then judged by the rules. The key is never printed.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../apps/api/src/env.js';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';

loadEnvFile();
const e = process.env;
if ((e.AI_PROVIDER || '').toLowerCase() !== 'http' || !e.AI_BASE_URL || !e.AI_API_KEY || !e.AI_MODEL) {
  console.log('SKIPPED: real-AI test needs AI_PROVIDER=http, AI_BASE_URL, AI_API_KEY, AI_MODEL (see docs/NOTES.md). Nothing was called.');
  process.exit(0);
}
const config = loadConfig({
  OE_MODE: 'mock', APP_TOKEN: 'gemini-test-app-token',
  DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'gemini-test-device-token' }]),
  AI_PROVIDER: 'http', AI_BASE_URL: e.AI_BASE_URL, AI_API_KEY: e.AI_API_KEY, AI_MODEL: e.AI_MODEL,
  LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-gemini-')),
});
const app = buildApp({ config, oe: createOeClient(config), provider: createProvider(config) });
const app_ = { authorization: 'Bearer gemini-test-app-token' };
let failed = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

console.log(`Real AI test: model ${e.AI_MODEL} (key not shown)`);
const post = await app.inject({ method: 'POST', url: '/api/v1/readings', headers: { 'x-device-token': 'gemini-test-device-token' },
  payload: { deviceId: 'esp32-01', plotId: 1, timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), soilMoisturePct: 17.5, temperatureC: 30.1, humidityPct: 38 } });
check(post.statusCode === 201, `a dry reading is stored (HTTP ${post.statusCode})`);

for (const lang of ['en', 'zu']) {
  let r, body;
  for (let attempt = 1; attempt <= 2; attempt++) { // one retry: the public model endpoints are sometimes overloaded
    r = await app.inject({ method: 'POST', url: '/api/v1/plots/1/advise', headers: app_, payload: { lang } });
    body = r.json();
    if (r.statusCode === 200 && !body.ai?.usedFallback) break;
  }
  console.log(`  [${lang}] ${r.statusCode} action=${body.proposal?.action} litres=${body.proposal?.litres} verdict=${body.verdict} fallback=${body.ai?.usedFallback}${body.ai?.fallbackReason ? ' (' + body.ai.fallbackReason + ')' : ''}`);
  console.log(`  [${lang}] reason: ${body.proposal?.reason}`);
  check(r.statusCode === 200, `[${lang}] advise returns 200`);
  check(body.ai?.usedFallback === false, `[${lang}] the real model's answer was used (no fallback)`);
  check(['irrigate', 'hold', 'notify'].includes(body.proposal?.action), `[${lang}] action is on the allow-list`);
  check(['approved_by_rules', 'rejected_by_rules'].includes(body.verdict), `[${lang}] OpenEdge rules gave a verdict (${body.verdict})`);
  check(body.proposal?.action !== 'irrigate' || (Number.isInteger(body.proposal.litres) && body.proposal.litres > 0), `[${lang}] litres is a positive integer when irrigating`);
}
await app.close();
console.log(failed ? `\nREAL AI TEST FAILED (${failed})` : '\nREAL AI TEST PASSED');
process.exit(failed ? 1 : 0);
