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

// ---------------- real forecast: Open-Meteo (fetch is mocked; no network in tests)
import { parseOpenMeteo, fetchOpenMeteo, openMeteoUrl, ForecastError } from '../apps/api/src/weather/open-meteo.js';
const omDaily = (over = {}) => ({ daily: { time: ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'],
  temperature_2m_max: [27.44, 29.1, 34.2, 24.3, 22.8, 26, 28.6], temperature_2m_min: [14.2, 15, 16.8, 12.1, 9.9, 11.3, 13.7], precipitation_sum: [0, 0, 2.4, 12.6, 0.3, 0, 0], ...over } });
const okFetch = (data) => async () => ({ ok: true, status: 200, json: async () => data });

test('open-meteo: URL asks for the 7-day daily max/min/rain in Africa/Johannesburg for the province town, no key', () => {
  const u = new URL(openMeteoUrl('KwaZulu-Natal'));
  assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(u.searchParams.get('daily'), 'temperature_2m_max,temperature_2m_min,precipitation_sum');
  assert.equal(u.searchParams.get('timezone'), 'Africa/Johannesburg');
  assert.equal(u.searchParams.get('forecast_days'), '7');
  assert.ok(!/key/i.test(u.search));
  assert.throws(() => openMeteoUrl('Atlantis'), ForecastError);
});

test('open-meteo: the daily block becomes 7 import days rounded to 0.1; missing values are refused', () => {
  const b = parseOpenMeteo('Limpopo', omDaily());
  assert.equal(b.baseDate, '2026-10-24'); assert.equal(b.source, 'open-meteo'); assert.equal(b.days.length, 7);
  assert.deepEqual(b.days[0], { dayNo: 1, tempMaxC: 27.4, tempMinC: 14.2, rainMm: 0 });
  assert.throws(() => parseOpenMeteo('Limpopo', omDaily({ precipitation_sum: [0, null, 0, 0, 0, 0, 0] })), /missing/);
  assert.throws(() => parseOpenMeteo('Limpopo', { error: true }), /daily/);
});

test('open-meteo: timeout, HTTP error and bad JSON become typed errors', async () => {
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(fetchOpenMeteo('Gauteng', { fetchImpl: hang, timeoutMs: 50 }), (e) => e.kind === 'timeout');
  await assert.rejects(fetchOpenMeteo('Gauteng', { fetchImpl: async () => ({ ok: false, status: 503 }) }), (e) => e.kind === 'http');
  await assert.rejects(fetchOpenMeteo('Gauteng', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('x'); } }) }), (e) => e.kind === 'invalid');
  await assert.rejects(fetchOpenMeteo('Gauteng', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), (e) => e.kind === 'network');
});

function makeWx(fetchImpl, extra = {}) {
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-wx-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'wx-device-token-fixture-1' }]), ...extra });
  return buildApp({ config, oe: createOeClient(config, { clock: () => NOW }), provider: createMockProvider({}), clock: () => NOW, weatherFetch: fetchImpl });
}

test('API forecast refresh: Open-Meteo data is stored through OpenEdge and the forecast is labelled open-meteo', async () => {
  const app = makeWx(okFetch(omDaily()));
  assert.equal((await api(app, 'GET', '/api/v1/forecast?province=KwaZulu-Natal')).body.source, 'example');
  const r = await api(app, 'POST', '/api/v1/forecast/refresh', { province: 'KwaZulu-Natal' });
  assert.equal(r.status, 200); assert.equal(r.body.source, 'open-meteo'); assert.equal(r.body.fallback, false);
  const fc = await api(app, 'GET', '/api/v1/forecast?province=KwaZulu-Natal');
  assert.equal(fc.body.isSynthetic, false); assert.equal(fc.body.source, 'open-meteo'); assert.equal(fc.body.days[2].tempMaxC, 34.2);
  const al = await api(app, 'POST', '/api/v1/farms/1/alerts/refresh', {});
  assert.ok(al.body.alerts.some((a) => a.message === 'Heat Day 3, 34.2 C'));   // OpenEdge rules run on the real numbers
});

test('API forecast refresh: a failed fetch changes nothing and says fallback; WEATHER_SOURCE=example never fetches', async () => {
  const app = makeWx(async () => ({ ok: false, status: 500 }));
  const r = await api(app, 'POST', '/api/v1/forecast/refresh', { province: 'KwaZulu-Natal' });
  assert.equal(r.status, 200); assert.equal(r.body.fallback, true); assert.equal(r.body.reason, 'http');
  assert.equal((await api(app, 'GET', '/api/v1/forecast?province=KwaZulu-Natal')).body.source, 'example');
  let called = false;
  const off = makeWx(async () => { called = true; return { ok: true, json: async () => omDaily() }; }, { WEATHER_SOURCE: 'example' });
  const s = await api(off, 'POST', '/api/v1/forecast/refresh', { province: 'KwaZulu-Natal' });
  assert.equal(s.body.skipped, true); assert.equal(called, false);
  assert.equal((await api(app, 'POST', '/api/v1/forecast/refresh', { province: 'Atlantis' })).status, 400);
});
