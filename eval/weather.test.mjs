// Weather alert tests (run by `npm test`, or alone: node --test eval/weather.test.mjs). Offline, no network, no AI.
// The end-to-end cases WX01 to WX28 are in eval/oe-contract-cases.json and run against mock-pasoe AND the real ABL.
// These cover the seed labelling, the rule edges and the /api/v1 weather routes plus the local UI proxy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../mock-pasoe/store.js';
import { handle } from '../mock-pasoe/handler.js';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';

const call = (store, method, path, body = {}) => { const r = handle(store, method, path, body); return { status: r.status, body: JSON.parse(JSON.stringify(r.body)) }; };

test('weather: the forecast seed is labelled synthetic example data, 7 days per province', () => {
  const seed = JSON.parse(readFileSync(new URL('../openedge/data/weather-seed.json', import.meta.url), 'utf8'));
  assert.match(seed.source, /example/i);
  const byProv = {};
  for (const d of seed.forecast) byProv[d.province] = (byProv[d.province] || 0) + 1;
  for (const n of Object.values(byProv)) assert.equal(n, 7);
  assert.ok(seed.farms.some((f) => /EXAMPLE DATA/.test(f.farmName)));
});

test('weather: a severe rain level wins over the warning level for the same day', () => {
  const s = createStore();
  assert.equal(call(s, 'POST', '/farm/alert-thresholds/2', { value: 11 }).status, 200);   // severe rain 11 mm
  const r = call(s, 'POST', '/farm/alerts/refresh', { farmId: 1 });
  const rain = r.body.alerts.filter((a) => a.alertType === 'rain');
  assert.equal(rain.length, 1);
  assert.equal(rain[0].level, 'severe');
});

test('weather: an inactive threshold makes no alerts', () => {
  const s = createStore();
  assert.equal(call(s, 'POST', '/farm/alert-thresholds/3', { active: false }).status, 200);
  const r = call(s, 'POST', '/farm/alerts/refresh', { farmId: 1 });
  assert.equal(r.body.alerts.filter((a) => a.alertType === 'heat').length, 0);
});

test('weather: an unknown farm is 404', () => {
  const s = createStore();
  assert.equal(call(s, 'POST', '/farm/alerts/refresh', { farmId: 99 }).status, 404);
});

const APP = 'wx-app-token-fixture-123';
const NOW = new Date('2026-10-24T09:00:00Z');
function make(extra = {}) {
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-wx-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'wx-device-token-fixture-1' }]), ...extra });
  return buildApp({ config, oe: createOeClient(config, { clock: () => NOW }), provider: createMockProvider({}), clock: () => NOW });
}
const api = async (app, method, url, payload, token = APP) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } });
  return { status: r.statusCode, body: r.json() };
};

test('API weather: refresh, list, acknowledge once, thresholds validated by OpenEdge', async () => {
  const app = make();
  assert.equal((await api(app, 'GET', '/api/v1/forecast?province=KwaZulu-Natal', undefined, '')).status, 401);
  const farm = await api(app, 'GET', '/api/v1/farms/1');
  assert.equal(farm.body.province, 'KwaZulu-Natal');
  const fc = await api(app, 'GET', '/api/v1/forecast?province=KwaZulu-Natal');
  assert.equal(fc.body.days.length, 7); assert.equal(fc.body.isSynthetic, true);
  const r = await api(app, 'POST', '/api/v1/farms/1/alerts/refresh', {});
  assert.equal(r.status, 200); assert.equal(r.body.created, 4);
  const list = await api(app, 'GET', '/api/v1/farms/1/alerts?status=open');
  assert.equal(list.body.alerts.length, 4);
  const id = list.body.alerts[0].alertId;
  assert.equal((await api(app, 'POST', `/api/v1/alerts/${id}/acknowledge`, {})).body.status, 'acknowledged');
  assert.equal((await api(app, 'POST', `/api/v1/alerts/${id}/acknowledge`, {})).status, 409);
  assert.equal((await api(app, 'POST', '/api/v1/alerts/x/acknowledge', {})).status, 400);
  const bad = await api(app, 'POST', '/api/v1/alert-thresholds/4', { value: 40 });
  assert.equal(bad.status, 400); assert.equal(bad.body.error, 'ALERT_THRESHOLD_INVALID'); assert.ok(bad.body.requestId);
  assert.equal((await api(app, 'GET', '/api/v1/alert-thresholds')).body.thresholds.length, 4);
});

test('API weather: the local UI proxy forwards the weather routes', async () => {
  const app = make({ UI_ENABLED: 'true' });
  const h = { host: 'localhost:3000', 'x-requested-with': 'mzansi-ui' };
  for (const u of ['/ui/api/v1/farms/1', '/ui/api/v1/forecast?province=Gauteng', '/ui/api/v1/farms/1/alerts', '/ui/api/v1/alert-thresholds']) {
    const r = await app.inject({ method: 'GET', url: u, headers: h });
    assert.equal(r.statusCode, 200, u);
  }
});
