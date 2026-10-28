// Farm watch. The schedule is off unless FARM_WATCH_INTERVAL_MIN is set. The manual route is what the demo calls.
// Proposals go through propose_action. A stale sensor becomes a notify card that stays pending until the farmer approves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';
import { detectWatchIssues, forecastHasRain, watchBlocked } from '../apps/api/src/assistant/watch.js';

const APP = 'fw-app-token-fixture-123';
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]).toString('base64');

function mkApp() {
  const dir = mkdtempSync(join(tmpdir(), 'mfo-fw-'));
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: dir, DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'fw-device-token-fixture-1' }]) });
  const app = buildApp({ config, oe: createOeClient(config), provider: createMockProvider() });
  app.logDir = dir;
  return app;
}
const api = async (app, method, url, payload, token = APP) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

test('schedule defaults off; detector: dry soil only when the reading is fresh and the forecast is dry', () => {
  const env = { OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', DEVICE_REGISTRY: '[{"deviceId":"esp32-01","plotId":1,"token":"fw-device-token-fixture-1"}]' };
  assert.equal(loadConfig(env).farmWatchIntervalMin, 0);
  assert.equal(loadConfig({ ...env, FARM_WATCH_INTERVAL_MIN: '30' }).farmWatchIntervalMin, 30);
  assert.equal(loadConfig({ ...env, FARM_WATCH_DEDUPE_HOURS: '6' }).farmWatchDedupeHours, 6);
  const plots = [{ plotId: 1, farmId: 1, plotName: 'Maize A', crop: 'Maize', dryThresholdPct: 35 }];
  const freshDry = { 1: { soilMoisturePct: 10, raining: false, ageMinutes: 5 } };
  assert.equal(forecastHasRain([{ rainMm: 0.2 }, { rainMm: 4 }]), true);
  assert.equal(detectWatchIssues({ plots, readings: freshDry, forecastDays: [{ rainMm: 4 }] }).some((i) => i.reason === 'dry_soil_no_rain'), false);
  const dry = detectWatchIssues({ plots, readings: freshDry, forecastDays: [{ rainMm: 0 }] });
  assert.equal(dry.some((i) => i.reason === 'dry_soil_no_rain'), true);
  assert.equal(dry.some((i) => i.reason === 'stale_sensor'), false);
  const stale = detectWatchIssues({ plots, readings: { 1: { soilMoisturePct: 10, raining: false, ageMinutes: 800 } }, forecastDays: [{ rainMm: 0 }] });
  assert.equal(stale.some((i) => i.reason === 'stale_sensor'), true);
  assert.equal(stale.some((i) => i.reason === 'dry_soil_no_rain'), false);
  const disease = detectWatchIssues({ plots, readings: freshDry, forecastDays: [{ rainMm: 0 }], diagnoses: [{ crop: 'Maize', condition: 'Streak (likely)' }] });
  assert.ok(disease.some((i) => i.reason === 'disease_nearby'));
  const now = new Date('2026-10-28T12:00:00.000Z');
  const open = { plotId: 1, problemType: 'dry_soil', status: 'open', title: 'Farm watch: check sensor · Maize A', createdAt: '2026-10-20T12:00:00.000Z' };
  assert.equal(watchBlocked([open], stale.find((i) => i.reason === 'stale_sensor'), now, 24), true);
  const closed = { ...open, status: 'resolved', createdAt: '2026-10-28T10:00:00.000Z' };
  assert.equal(watchBlocked([closed], stale.find((i) => i.reason === 'stale_sensor'), now, 24), true);
  assert.equal(watchBlocked([{ ...closed, createdAt: '2026-10-26T10:00:00.000Z' }], stale.find((i) => i.reason === 'stale_sensor'), now, 24), false);
});

test('manual watch opens one pending notify case, logs the run, and does not open a duplicate', async () => {
  const app = mkApp();
  assert.equal((await api(app, 'POST', '/api/v1/assistant/watch/run', {}, null)).status, 401);
  const run = await api(app, 'POST', '/api/v1/assistant/watch/run', {});
  assert.equal(run.status, 200);
  assert.equal(run.body.ok, true);
  assert.equal(run.body.opened.length, 1);
  assert.equal(run.body.opened[0].reason, 'stale_sensor');
  assert.ok(run.body.checked.some((s) => s.tool === 'get_sensor_readings'));
  assert.ok(run.body.checked.some((s) => s.tool === 'get_forecast'));
  assert.ok(run.body.checked.some((s) => s.tool === 'get_nearby_reports'));
  assert.ok(run.body.checked.some((s) => s.tool === 'find_similar_cases'));
  assert.ok(run.body.checked.some((s) => s.tool === 'search_guides'));
  const id = run.body.opened[0].caseId;
  const c = await api(app, 'GET', `/api/v1/assistant/cases/${id}`);
  assert.equal(c.status, 200);
  assert.ok(c.body.provider.startsWith('farm-watch'));
  assert.match(c.body.title, /^Farm watch: check sensor/);
  const notify = c.body.actions.find((a) => a.kind === 'notify');
  assert.ok(notify, 'notify card');
  assert.equal(notify.status, 'pending_approval');
  assert.notEqual(notify.status, 'approved');
  assert.ok(notify.suggestionId > 0);
  const again = await api(app, 'POST', '/api/v1/assistant/watch/run', {});
  assert.equal(again.body.opened.length, 0);
  assert.ok(again.body.skipped.some((s) => s.reason === 'stale_sensor' && s.why === 'deduped'));
  const log = readFileSync(join(app.logDir, 'tool-calls.jsonl'), 'utf8');
  assert.match(log, /"tool":"assistant\.watch"/);
  const photo = await api(app, 'POST', '/api/v1/doctor/diagnoses', { crop: 'Tomato', plantPart: 'leaf', growthStage: 'fruiting', province: 'KwaZulu-Natal', photos: [{ mimeType: 'image/jpeg', dataBase64: JPG }] });
  assert.equal(photo.status, 201);
  const third = await api(app, 'POST', '/api/v1/assistant/watch/run', {});
  assert.ok(third.body.opened.some((o) => o.reason === 'disease_nearby'));
  assert.ok(third.body.skipped.some((s) => s.reason === 'stale_sensor' && s.why === 'deduped'));
  const sick = await api(app, 'GET', `/api/v1/assistant/cases/${third.body.opened.find((o) => o.reason === 'disease_nearby').caseId}`);
  assert.equal(sick.body.problemType, 'sick_plant');
  assert.ok(sick.body.actions.every((a) => a.status === 'proposed' && a.status !== 'approved'));
  assert.ok(sick.body.evidence.some((e) => e.kind === 'find_similar_cases' || e.kind === 'search_guides'));
  const list = await api(app, 'GET', '/api/v1/assistant/cases?limit=10');
  assert.ok(list.body.cases.some((x) => String(x.provider).startsWith('farm-watch') && x.status === 'open'));
  await app.close();
});
