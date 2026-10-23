// node scripts/demo.mjs [baseUrl]   (default http://localhost:3000; reads tokens from .env)
// Walks the whole loop against a RUNNING API: device posts a dry reading -> AI proposes -> OpenEdge rules validate
// -> farmer approves (two steps). Uses fictional example data. Prints each step; exits 1 if a step fails.
import { readFileSync, existsSync } from 'node:fs';
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const env = {};
if (existsSync('.env')) for (const l of readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
const appToken = process.env.APP_TOKEN || env.APP_TOKEN;
const registry = JSON.parse(process.env.DEVICE_REGISTRY || env.DEVICE_REGISTRY || '[]');
if (!appToken || !registry[0]) { console.error('Run `npm run setup` first (needs APP_TOKEN and DEVICE_REGISTRY in .env).'); process.exit(1); }
const dev = registry[0];
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};
const app = { Authorization: `Bearer ${appToken}` };
let failed = false;
const step = (n, title, r, okStatus) => {
  const ok = [].concat(okStatus).includes(r.status); if (!ok) failed = true;
  console.log(`\n${n}. ${title}\n   HTTP ${r.status} ${ok ? 'OK' : 'UNEXPECTED'}\n   ${JSON.stringify(r.body).slice(0, 600)}`);
  return r;
};
console.log(`Mzansi Farmer Ops demo against ${base} (example data)`);
const h = step(1, 'Health', await call('GET', '/health'), 200);
console.log(`   (OpenEdge mode: ${h.body.oeMode}, AI provider: ${h.body.aiProvider})`);
step(2, `Device ${dev.deviceId} posts a DRY reading for plot ${dev.plotId}`, await call('POST', '/api/v1/readings',
  { deviceId: dev.deviceId, plotId: dev.plotId, timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), soilMoisturePct: 17.5, temperatureC: 30.1, humidityPct: 38 },
  { 'X-Device-Token': dev.token }), 201);
const adv = step(3, 'AI proposes, OpenEdge rules validate', await call('POST', `/api/v1/plots/${dev.plotId}/advise`, { lang: 'en' }, app), 200);
const id = adv.body.suggestionId;
if (adv.body.verdict === 'approved_by_rules') {
  const a1 = step(4, 'Farmer approves, step 1 (nothing changes, a confirmation token is issued)', await call('POST', `/api/v1/suggestions/${id}/approve`, {}, app), 202);
  step(5, 'Farmer confirms, step 2 (rules re-run at approval time)', await call('POST', `/api/v1/suggestions/${id}/approve`, { confirmToken: a1.body.confirmToken }, app), 200);
} else {
  console.log(`\nThe rules refused this suggestion: ${JSON.stringify(adv.body.rejectReasons)}. That is a valid outcome (e.g. weekly water budget used up: reseed to reset).`);
}
step(6, 'Audit trail (newest first)', await call('GET', '/api/v1/audit?limit=5', undefined, app), 200);
console.log(failed ? '\nDEMO FAILED' : '\nDEMO COMPLETED');
process.exit(failed ? 1 : 0);
