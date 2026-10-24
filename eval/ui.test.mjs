// Web UI tests (run by `npm test`, or alone: node --test eval/ui.test.mjs). They need no browser:
//  - the static routes serve the UI and refuse path traversal
//  - the local-only /ui/api proxy: it answers local requests, refuses everything else, and never leaks a token
//  - the demo tools (simulated reading, mock-AI behaviour) work and are mock-only where they should be
//  - the API response shapes the UI depends on (field names it reads)
//  - front-end files: every module parses, assets exist, the isiZulu table only has approved strings, every photo has a credit
// The click-through (Playwright, headless Chrome, both languages, mobile + desktop) is documented in docs/UI.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';

const APP = 'ui-app-token-fixture-123', DEV1 = 'ui-device-token-fixture-1', DEV2 = 'ui-device-token-fixture-2', KEY = 'ui-secret-ai-key-fixture';
const NOW = new Date('2026-10-23T20:00:00Z');
const WEB = fileURLToPath(new URL('../apps/web/public/', import.meta.url));
const HDR = { 'x-requested-with': 'mzansi-ui' };

function make(extra = {}, behaviour = 'normal') {
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', AI_API_KEY: KEY, LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-ui-')),
    DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: DEV1 }, { deviceId: 'esp32-02', plotId: 2, token: DEV2 }]), ...extra });
  const provider = createMockProvider({ behaviour });
  return buildApp({ config, oe: createOeClient(config, { clock: () => NOW }), provider, clock: () => NOW });
}
const ui = (app, method, url, payload, headers = HDR, extra = {}) => app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { host: 'localhost:3000', ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...extra });

// ---------------- static files
test('UI: / serves the app shell with security headers; assets are served with the right types', async () => {
  const app = make();
  const r = await app.inject({ method: 'GET', url: '/' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.body, /Mzansi Farmer AI/);
  for (const [url, type] of [['/assets/css/app.css', /text\/css/], ['/assets/js/main.js', /javascript/], ['/assets/photos/plot-maize.jpg', /image\/jpeg/], ['/assets/fonts/Inter.woff2', /font\/woff2/], ['/favicon.svg', /svg/]]) {
    const a = await app.inject({ method: 'GET', url });
    assert.equal(a.statusCode, 200, url); assert.match(a.headers['content-type'], type, url);
  }
  await app.close();
});
test('UI: path traversal and unknown files are 404, directories are not listed', async () => {
  const app = make();
  for (const url of ['/assets/../../../../.env', '/assets/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2f.env', '/assets/js/', '/assets/nope.js', '/assets//etc/passwd']) {
    const r = await app.inject({ method: 'GET', url });
    assert.equal(r.statusCode, 404, url);
    assert.ok(!/APP_TOKEN|AI_API_KEY|"name": "mzansi/.test(r.body), url);
  }
  await app.close();
});
test('UI: UI_ENABLED=0 switches the whole UI off and leaves the API untouched', async () => {
  const app = make({ UI_ENABLED: '0' });
  assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 404);
  assert.equal((await ui(app, 'GET', '/ui/session')).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/plots', headers: { authorization: `Bearer ${APP}` } })).statusCode, 200);
  await app.close();
});

// ---------------- session + proxy security
test('UI: /ui/session reports proxy mode locally and NEVER contains a token or key', async () => {
  const app = make();
  const r = await ui(app, 'GET', '/ui/session');
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.mode, 'proxy'); assert.equal(j.oeMode, 'mock'); assert.equal(j.aiProvider, 'mock');
  assert.deepEqual(j.demo.simulateReadingPlots, [1, 2]);
  assert.deepEqual(j.demo.aiBehaviour, { current: 'normal', options: ['normal', 'greedy'] });
  for (const secret of [APP, DEV1, DEV2, KEY]) assert.ok(!r.body.includes(secret), 'session leaked a secret');
  await app.close();
});
test('UI: without the X-Requested-With header, from a non-loopback address, or with a foreign Host, the proxy refuses and the UI asks for a token', async () => {
  const app = make();
  assert.equal((await ui(app, 'GET', '/ui/session', undefined, {})).json().mode, 'token');
  assert.equal((await ui(app, 'GET', '/ui/session', undefined, HDR, { remoteAddress: '192.168.1.50' })).json().mode, 'token');
  assert.equal((await app.inject({ method: 'GET', url: '/ui/session', headers: { ...HDR, host: 'evil.example.com' } })).json().mode, 'token');
  assert.equal((await ui(app, 'GET', '/ui/session', undefined, {})).json().demo, null);
  const noHdr = await ui(app, 'GET', '/ui/api/v1/plots', undefined, {});
  assert.equal(noHdr.statusCode, 403); assert.equal(noHdr.json().error, 'UI_HEADER_REQUIRED');
  const lan = await ui(app, 'GET', '/ui/api/v1/plots', undefined, HDR, { remoteAddress: '192.168.1.50' });
  assert.equal(lan.statusCode, 403); assert.equal(lan.json().error, 'UI_LOCAL_ONLY');
  const rebind = await app.inject({ method: 'GET', url: '/ui/api/v1/plots', headers: { ...HDR, host: 'evil.example.com:3000' } });
  assert.equal(rebind.statusCode, 403); assert.equal(rebind.json().error, 'UI_LOCAL_ONLY');
  for (const url of ['/ui/api/demo/reading', '/ui/api/demo/ai-behaviour']) {
    assert.equal((await ui(app, 'POST', url, { plotId: 1 }, HDR, { remoteAddress: '10.0.0.9' })).statusCode, 403, url);
    assert.equal((await ui(app, 'POST', url, { plotId: 1 }, {})).statusCode, 403, url);
  }
  assert.equal((await ui(app, 'GET', '/ui/api/facts/1', undefined, HDR, { remoteAddress: '10.0.0.9' })).statusCode, 403);
  await app.close();
});
test('UI: UI_ALLOW_REMOTE=1 lifts only the loopback check (header and Host checks stay)', async () => {
  const app = make({ UI_ALLOW_REMOTE: '1' });
  assert.equal((await ui(app, 'GET', '/ui/api/v1/plots', undefined, HDR, { remoteAddress: '192.168.1.50' })).statusCode, 200);
  assert.equal((await ui(app, 'GET', '/ui/api/v1/plots', undefined, {}, { remoteAddress: '192.168.1.50' })).statusCode, 403);
  await app.close();
});
test('UI: the proxy only reaches plots / suggestions / audit; the direct API still needs the bearer token', async () => {
  const app = make();
  assert.equal((await ui(app, 'GET', '/ui/api/v1/plots')).statusCode, 200);
  assert.equal((await ui(app, 'GET', '/ui/api/v1/audit?limit=3')).statusCode, 200);
  for (const url of ['/ui/api/v1/readings', '/ui/api/v1/../health', '/ui/api/v1/plots/../readings', '/ui/api/v1/unknown', '/ui/api/v1/']) {
    const r = await ui(app, 'POST', url, {});
    assert.ok([404, 400].includes(r.statusCode), `${url} -> ${r.statusCode}`);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/plots' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/plots', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  // a proxied response never carries the token back
  const r = await ui(app, 'GET', '/ui/api/v1/plots');
  assert.ok(!r.body.includes(APP) && !JSON.stringify(r.headers).includes(APP));
  await app.close();
});

// ---------------- demo tools + the full loop through the proxy
test('UI loop through the proxy: simulate reading -> ask AI -> two-step approve -> audit; rules re-run and the audit has the decision', async () => {
  const app = make();
  const rd = await ui(app, 'POST', '/ui/api/demo/reading', { plotId: 1, soilMoisturePct: 18.5, temperatureC: 29.4, humidityPct: 41, raining: false });
  assert.equal(rd.statusCode, 201); assert.ok(Number.isInteger(rd.json().id));
  // same instant again: the proxy moves one second on instead of failing with a duplicate
  const rd2 = await ui(app, 'POST', '/ui/api/demo/reading', { plotId: 1, soilMoisturePct: 18.4, temperatureC: 29.4, humidityPct: 41 });
  assert.equal(rd2.statusCode, 201);
  const adv = await ui(app, 'POST', '/ui/api/v1/plots/1/advise', { lang: 'en' });
  assert.equal(adv.statusCode, 200);
  const a = adv.json();
  assert.equal(a.status, 'pending_approval'); assert.equal(a.proposal.action, 'irrigate'); assert.equal(a.verdict, 'approved_by_rules');
  const s1 = await ui(app, 'POST', `/ui/api/v1/suggestions/${a.suggestionId}/approve`, {});
  assert.equal(s1.statusCode, 202); assert.match(s1.json().confirmToken, /^cfm_/); assert.equal(s1.json().expiresInSeconds, 120);
  assert.equal((await ui(app, 'GET', `/ui/api/v1/suggestions/${a.suggestionId}`)).json().status, 'pending_approval', 'step 1 changes nothing');
  const bad = await ui(app, 'POST', `/ui/api/v1/suggestions/${a.suggestionId}/approve`, { confirmToken: 'cfm_wrong' });
  assert.equal(bad.statusCode, 403); assert.equal(bad.json().error, 'CONFIRMATION_INVALID');
  const s2 = await ui(app, 'POST', `/ui/api/v1/suggestions/${a.suggestionId}/approve`, { confirmToken: s1.json().confirmToken });
  assert.equal(s2.statusCode, 200); assert.equal(s2.json().status, 'approved');
  const audit = (await ui(app, 'GET', '/ui/api/v1/audit?limit=100')).json().events.map((e) => e.event);
  assert.ok(audit.includes('rule_check') && audit.includes('suggestion_approved'), audit.join());
  const f = await ui(app, 'GET', '/ui/api/facts/1');
  assert.equal(f.statusCode, 200); assert.equal(f.json().facts.usedLast7DaysL, 1000 + a.proposal.litres);
  await app.close();
});
test('UI: declining over the proxy needs no confirmation; a rejected suggestion cannot be approved (409 NOT_APPROVABLE)', async () => {
  const app = make({}, 'greedy');
  await ui(app, 'POST', '/ui/api/demo/reading', { plotId: 1, soilMoisturePct: 60, temperatureC: 22, humidityPct: 70, raining: true });
  const adv = (await ui(app, 'POST', '/ui/api/v1/plots/1/advise', { lang: 'en' })).json();
  assert.equal(adv.status, 'rejected');
  const codes = adv.rejectReasons.map((r) => r.code);
  assert.ok(codes.includes('SOIL_NOT_DRY') && codes.includes('RAIN_DETECTED'), codes.join());
  const na = await ui(app, 'POST', `/ui/api/v1/suggestions/${adv.suggestionId}/approve`, {});
  assert.equal(na.statusCode, 409); assert.equal(na.json().error, 'NOT_APPROVABLE');
  await ui(app, 'POST', '/ui/api/demo/ai-behaviour', { behaviour: 'normal' });
  await ui(app, 'POST', '/ui/api/demo/reading', { plotId: 2, soilMoisturePct: 18, temperatureC: 29, humidityPct: 40 });
  const adv2 = (await ui(app, 'POST', '/ui/api/v1/plots/2/advise', { lang: 'zu' })).json();
  assert.equal(adv2.status, 'pending_approval');
  const dec = await ui(app, 'POST', `/ui/api/v1/suggestions/${adv2.suggestionId}/reject`, {});
  assert.equal(dec.statusCode, 200); assert.equal(dec.json().status, 'declined');
  await app.close();
});
test('UI demo tools: no device for the plot is 404, bad numbers are 400 with the field, AI behaviour only switches mock AI and only to known values', async () => {
  const app = make();
  const nodev = await ui(app, 'POST', '/ui/api/demo/reading', { plotId: 4, soilMoisturePct: 20, temperatureC: 20, humidityPct: 50 });
  assert.equal(nodev.statusCode, 404); assert.equal(nodev.json().error, 'NO_DEVICE_FOR_PLOT');
  const badv = await ui(app, 'POST', '/ui/api/demo/reading', { plotId: 1, soilMoisturePct: 140, temperatureC: 20, humidityPct: 50 });
  assert.equal(badv.statusCode, 400); assert.equal(badv.json().field, 'soilMoisturePct');
  const missing = await ui(app, 'POST', '/ui/api/demo/reading', { plotId: 1, temperatureC: 20, humidityPct: 50 });
  assert.equal(missing.statusCode, 400);
  assert.equal((await ui(app, 'POST', '/ui/api/demo/ai-behaviour', { behaviour: 'inject' })).statusCode, 400);
  assert.equal((await ui(app, 'POST', '/ui/api/demo/ai-behaviour', { behaviour: 'greedy' })).json().behaviour, 'greedy');
  assert.equal((await ui(app, 'GET', '/ui/session')).json().demo.aiBehaviour.current, 'greedy');
  await app.close();
  // a real (non-mock) provider cannot be switched from the browser
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-ui-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: DEV1 }]) });
  const real = buildApp({ config, oe: createOeClient(config), provider: { name: 'http', propose: async () => '{}' }, clock: () => NOW });
  const r = await ui(real, 'POST', '/ui/api/demo/ai-behaviour', { behaviour: 'greedy' });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error, 'NOT_MOCK_AI');
  assert.equal((await ui(real, 'GET', '/ui/session')).json().demo.aiBehaviour, null);
  await real.close();
});

// ---------------- API shapes the UI reads
test('API shapes the UI depends on: plots, readings, suggestions, advise facts, audit', async () => {
  const app = make();
  await ui(app, 'POST', '/ui/api/demo/reading', { plotId: 1, soilMoisturePct: 18.5, temperatureC: 29.4, humidityPct: 41 });
  const plots = (await ui(app, 'GET', '/ui/api/v1/plots')).json().plots;
  assert.equal(plots.length, 5);
  for (const k of ['plotId', 'plotName', 'crop', 'areaHa', 'maxIrrigationLitres', 'dryThresholdPct', 'weeklyWaterBudgetL']) assert.ok(k in plots[0], k);
  assert.ok(['Maize', 'Beans', 'Spinach', 'Tomato', 'Cabbage'].every((c) => plots.some((p) => p.crop === c)), 'every crop has a photo in the UI');
  const rd = (await ui(app, 'GET', '/ui/api/v1/plots/1/readings?limit=20')).json().readings;
  for (const k of ['readingId', 'deviceId', 'readAt', 'soilMoisturePct', 'temperatureC', 'humidityPct', 'raining']) assert.ok(k in rd[0], k);
  assert.ok(Date.parse(rd[0].readAt) >= Date.parse(rd[1].readAt), 'newest first');
  const adv = (await ui(app, 'POST', '/ui/api/v1/plots/1/advise', { lang: 'en' })).json();
  for (const k of ['suggestionId', 'requestId', 'status', 'proposal', 'verdict', 'rejectReasons', 'facts', 'ai']) assert.ok(k in adv, k);
  for (const k of ['soilMoisturePct', 'readingAgeMinutes', 'dryThresholdPct', 'maxIrrigationLitres', 'usedLast7DaysL', 'weeklyWaterBudgetL', 'staleLimitMinutes', 'raining']) assert.ok(k in adv.facts, 'facts.' + k);
  const sug = (await ui(app, 'GET', `/ui/api/v1/suggestions/${adv.suggestionId}`)).json();
  for (const k of ['suggestionId', 'plotId', 'action', 'litres', 'reason', 'provider', 'status', 'verdict', 'rejectReasons', 'createdAt', 'decidedAt', 'requestId']) assert.ok(k in sug, k);
  const list = (await ui(app, 'GET', '/ui/api/v1/suggestions')).json().suggestions;
  assert.ok(list.length >= 4); assert.equal((await ui(app, 'GET', '/ui/api/v1/suggestions?status=pending_approval')).json().suggestions.length, 1);
  const ev = (await ui(app, 'GET', '/ui/api/v1/audit?limit=5')).json().events[0];
  for (const k of ['auditId', 'at', 'requestId', 'actor', 'event', 'detail']) assert.ok(k in ev, k);
  await app.close();
});

// ---------------- front-end files
test('UI files: every JS module parses, index.html and CSS only reference files that exist', () => {
  const js = readdirSync(join(WEB, 'assets/js')).filter((f) => f.endsWith('.js'));
  assert.deepEqual(js.sort(), ['api.js', 'doctor.js', 'i18n.js', 'main.js', 'market.js', 'util.js', 'views.js', 'weather.js']);
  for (const f of js) { const r = spawnSync(process.execPath, ['--check', join(WEB, 'assets/js', f)], { encoding: 'utf8' }); assert.equal(r.status, 0, `${f}: ${r.stderr}`); }
  const index = readFileSync(join(WEB, 'index.html'), 'utf8');
  for (const m of index.matchAll(/(?:href|src)="(\/[^"]+)"/g)) assert.ok(existsSync(join(WEB, m[1] === '/favicon.svg' ? 'assets/favicon.svg' : m[1])), m[1]);
  const css = readFileSync(join(WEB, 'assets/css/app.css'), 'utf8');
  for (const m of css.matchAll(/url\(\.\.\/([^)]+)\)/g)) assert.ok(existsSync(join(WEB, 'assets', m[1])), m[1]);
  assert.ok(!/glow|drop-shadow\(|0 0 \d+px (rgba|#)/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no glow effects (user preference)');
});
test('UI files: only real photos, each with a credit; only the approved isiZulu strings; no secrets in the web folder', () => {
  const photos = readdirSync(join(WEB, 'assets/photos'));
  const credits = readFileSync(new URL('../docs/UI.md', import.meta.url), 'utf8');
  for (const p of photos) assert.ok(credits.includes(p), `credit missing for ${p} in docs/UI.md`);
  assert.ok(photos.every((p) => /\.jpg$/.test(p)), 'photos only (no illustrations / svg art)');
  const i18n = readFileSync(join(WEB, 'assets/js/i18n.js'), 'utf8');
  const zuBlock = /const zu = \{([\s\S]*?)\n\};/.exec(i18n)[1];
  assert.ok(zuBlock.includes("'Sawubona, {name}'") && zuBlock.includes("'Qinisekisa isinqumo sakho.'"));
  assert.equal([...zuBlock.matchAll(/^\s+(\w+):/gm)].length, 3, 'zu table holds only the approved plain strings; the number-carrying approved sentences are functions');
  for (const s of ['Chelela isiqephu sombila', 'Umhlabathi womile. Umswakama ungu-', 'Akuvunyelwe. Imvula iyana manje.', 'Linda kuze kuyeke imvula.']) assert.ok(i18n.includes(s), s);
  assert.ok(!/NEEDS NATIVE REVIEW/i.test(readdirSync(join(WEB, 'assets/js')).map((f) => readFileSync(join(WEB, 'assets/js', f), 'utf8').replace(/\/\/.*$/gm, '')).join('') + readFileSync(join(WEB, 'index.html'), 'utf8')), 'the review note must not be in anything shown to farmers');
  const all = [];
  const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(js|html|css|svg)$/.test(f.name)) all.push(readFileSync(p, 'utf8')); } };
  walk(WEB);
  assert.ok(!all.some((s) => /AIza[0-9A-Za-z_-]{20,}|cfm_[0-9a-f]{12,}|Bearer [A-Za-z0-9]{16,}/.test(s)), 'no keys or tokens in the web files');
});
