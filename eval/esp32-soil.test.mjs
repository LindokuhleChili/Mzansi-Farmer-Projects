// Soil from the analog ESP32 sketch (firmware/esp32/MzansiFarmSensors) on the existing readings path.
// Water level is local-only: a tank table would be a new OpenEdge .df and a database stop, so it is not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';
import { metricsBlock, plotState, readingsTable } from '../apps/web/public/assets/js/views.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sketch = readFileSync(join(root, 'firmware/esp32/MzansiFarmSensors/MzansiFarmSensors.ino'), 'utf8');
const example = readFileSync(join(root, 'firmware/esp32/MzansiFarmSensors/secrets.example.h'), 'utf8');
const envExample = readFileSync(join(root, '.env.example'), 'utf8');
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');

const TOKEN = 'esp32-soil-device-token-fixture';
const APP = 'esp32-soil-app-token-fixture';
const NOW = new Date('2026-10-23T08:55:00Z');
const authz = { authorization: 'Bearer ' + APP };

function makeApp() {
  const config = loadConfig({
    OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent',
    LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-soil-')),
    DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: TOKEN }]),
  });
  return buildApp({ config, oe: createOeClient(config, { clock: () => NOW }), provider: createMockProvider(), clock: () => NOW });
}

const sketchBody = {
  deviceId: 'esp32-01',
  plotId: 1,
  timestamp: '2026-10-23T08:50:00Z',
  soilMoisturePct: 19,
  temperatureC: 22.0,
  humidityPct: 55,
  raining: false,
  waterLevelPct: 46,
};

test('sketch posts the readings schema and serves a station-mode dashboard', () => {
  assert.match(sketch, /X-Device-Token/);
  assert.match(sketch, /\/api\/v1\/readings/);
  for (const field of ['deviceId', 'plotId', 'timestamp', 'soilMoisturePct', 'temperatureC', 'humidityPct', 'raining']) {
    assert.match(sketch, new RegExp(field));
  }
  assert.match(sketch, /WIFI_STA/);
  assert.doesNotMatch(sketch, /WIFI_AP_STA/);
  assert.doesNotMatch(sketch, /WaterLevel-ESP32/);
  assert.doesNotMatch(sketch, /Water1234/);
  assert.doesNotMatch(sketch, /192,\s*168,\s*4,\s*1/);
  assert.doesNotMatch(sketch, /DESKTOP-U7LDMSC/);
  assert.doesNotMatch(sketch, /#define\s+WIFI_SSID/);
  assert.doesNotMatch(sketch, /#define\s+WIFI_PASSWORD/);
  assert.match(sketch, /mzansi-farm/);
  assert.match(sketch, /secrets\.h/);
  assert.match(sketch, /Access-Control-Allow-Origin/);
  assert.match(sketch, /Access-Control-Allow-Private-Network/);
  assert.match(sketch, /\/history/);
  assert.match(sketch, /rssi/);
  assert.match(sketch, /WATER_PIN = 34/);
  assert.match(sketch, /SOIL_PIN = 35/);
  assert.match(sketch, /SEND_INTERVAL_MS = 10000/);
  assert.match(sketch, /CLIMATE_VALUES_ARE_REAL/);
  assert.match(sketch, /ENABLE_CLOUD_UPLOAD/);
  assert.match(sketch, /\/api\/v1\/tank-readings/);
  for (const field of ['waterLevelRaw', 'waterLevelPct', 'calibrated']) assert.match(sketch, new RegExp(field));
  assert.doesNotMatch(sketch, /PASTE_DEVICE_TOKEN_HERE/);
});

test('secrets.example.h is a placeholder and secrets.h is gitignored', () => {
  assert.match(example, /PASTE_WIFI_NAME_HERE/);
  assert.match(example, /PASTE_WIFI_PASSWORD_HERE/);
  assert.match(example, /PASTE_DEVICE_TOKEN_HERE/);
  assert.match(example, /"esp32-01"/);
  assert.match(example, /CLIMATE_VALUES_ARE_REAL 0/);
  assert.match(example, /mzansi-farm\.local/);
  assert.match(envExample, /mzansi-farm\.local/);
  assert.doesNotMatch(example, /[0-9a-f]{32,}/i);
  assert.match(gitignore, /firmware\/esp32\/MzansiFarmSensors\/secrets\.h/);
  assert.match(envExample, /DEVICE_REGISTRY=\[\{"deviceId":"esp32-01","plotId":1,"token":"replace-with-random-device-token"\}\]/);
  assert.match(envExample, /randomBytes\(32\)/);
  assert.match(envExample, /Get-Random -Max 256/);
});

test('a replace- device token is reported as an invalid DEVICE_REGISTRY entry', () => {
  const config = loadConfig({
    OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-soil-')),
    DEVICE_REGISTRY: '[{"deviceId":"esp32-01","plotId":1,"token":"replace-with-random-device-token"}]',
  });
  assert.ok(config.problems.some((p) => p.includes('DEVICE_REGISTRY')));
});

test('sketch-shaped POST is stored as soil moisture and waterLevelPct is not kept', async () => {
  const app = makeApp();
  const posted = await app.inject({
    method: 'POST', url: '/api/v1/readings',
    headers: { 'content-type': 'application/json', 'x-device-token': TOKEN },
    payload: sketchBody,
  });
  assert.equal(posted.statusCode, 201, posted.body);
  assert.equal(typeof posted.json().id, 'number');

  const again = await app.inject({
    method: 'POST', url: '/api/v1/readings',
    headers: { 'content-type': 'application/json', 'x-device-token': TOKEN },
    payload: sketchBody,
  });
  assert.equal(again.statusCode, 409);

  const got = await app.inject({ method: 'GET', url: '/api/v1/plots/1/readings?limit=1', headers: authz });
  assert.equal(got.statusCode, 200);
  const latest = got.json().readings[0];
  assert.equal(latest.deviceId, 'esp32-01');
  assert.equal(latest.soilMoisturePct, 19);
  assert.equal(latest.temperatureC, 22);
  assert.equal(latest.humidityPct, 55);
  assert.equal(latest.raining, false);
  assert.equal(latest.waterLevelPct, undefined);
  assert.equal(Date.parse(latest.readAt), Date.parse('2026-10-23T08:50:00Z'));

  const adv = await app.inject({ method: 'POST', url: '/api/v1/plots/1/advise', headers: authz, payload: { lang: 'en' } });
  assert.equal(adv.statusCode, 200, adv.body);
  assert.equal(adv.json().facts.soilMoisturePct, 19);
  await app.close();
});

test('soil below 0 is rejected, and a bearer app token cannot post a reading', async () => {
  const app = makeApp();
  const bad = await app.inject({
    method: 'POST', url: '/api/v1/readings',
    headers: { 'content-type': 'application/json', 'x-device-token': TOKEN },
    payload: { ...sketchBody, timestamp: '2026-10-23T08:51:00Z', soilMoisturePct: -1, waterLevelPct: undefined },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().field, 'soilMoisturePct');
  const bearer = await app.inject({
    method: 'POST', url: '/api/v1/readings',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + APP },
    payload: { ...sketchBody, timestamp: '2026-10-23T08:52:00Z' },
  });
  assert.equal(bearer.statusCode, 401);
  await app.close();
});

test('plot metrics show the latest soil percentage beside the tank level', () => {
  const plot = { plotId: 1, dryThresholdPct: 35, plotName: 'Maize Plot A (example)', crop: 'Maize', areaHa: 1.2, maxIrrigationLitres: 500, weeklyWaterBudgetL: 1500 };
  const readings = [{ soilMoisturePct: 19, temperatureC: 22, humidityPct: 55, raining: false, deviceId: 'esp32-01', readAt: '2026-10-23T08:50:00Z' }];
  const tank = { waterLevelPct: 46, waterLevelRaw: 1834, calibrated: true, deviceId: 'esp32-01', readAt: '2026-10-23T08:50:00Z' };
  const now = Date.parse('2026-10-23T08:55:00Z');
  const tiles = String(metricsBlock(plot, plotState(plot, readings, now), tank));
  assert.match(tiles, /Soil moisture/);
  assert.match(tiles, /Water level/);
  assert.match(tiles, />19</);
  assert.match(tiles, />46</);
  const bare = String(metricsBlock(plot, plotState(plot, readings, now), { ...tank, calibrated: false, waterLevelPct: null }));
  assert.match(bare, /Not calibrated/);
  const table = String(readingsTable(readings, 8));
  assert.match(table, /esp32-01/);
  assert.match(table, /19%/);
});

test('tank POST is stored and read back; raw, percent and calibration are checked', async () => {
  const app = makeApp();
  const body = { deviceId: 'esp32-01', plotId: 1, timestamp: '2026-10-23T08:50:10Z', waterLevelRaw: 1834, waterLevelPct: 46, calibrated: true };
  const posted = await app.inject({
    method: 'POST', url: '/api/v1/tank-readings',
    headers: { 'content-type': 'application/json', 'x-device-token': TOKEN },
    payload: body,
  });
  assert.equal(posted.statusCode, 201, posted.body);
  const again = await app.inject({
    method: 'POST', url: '/api/v1/tank-readings',
    headers: { 'content-type': 'application/json', 'x-device-token': TOKEN },
    payload: body,
  });
  assert.equal(again.statusCode, 409);
  const open = await app.inject({
    method: 'POST', url: '/api/v1/tank-readings',
    headers: { 'content-type': 'application/json', 'x-device-token': TOKEN },
    payload: { ...body, timestamp: '2026-10-23T08:50:20Z', waterLevelPct: null, calibrated: false },
  });
  assert.equal(open.statusCode, 201, open.body);
  const got = await app.inject({ method: 'GET', url: '/api/v1/plots/1/tank-readings?limit=2', headers: authz });
  assert.equal(got.statusCode, 200);
  const rows = got.json().readings;
  assert.equal(rows[0].calibrated, false);
  assert.equal(rows[0].waterLevelPct, null);
  assert.equal(rows[0].waterLevelRaw, 1834);
  assert.equal(rows[1].waterLevelPct, 46);
  assert.equal(rows[1].calibrated, true);
  const raw = await app.inject({
    method: 'POST', url: '/api/v1/tank-readings',
    headers: { 'content-type': 'application/json', 'x-device-token': TOKEN },
    payload: { ...body, timestamp: '2026-10-23T08:50:30Z', waterLevelRaw: 5000 },
  });
  assert.equal(raw.statusCode, 400);
  assert.equal(raw.json().field, 'waterLevelRaw');
  const lie = await app.inject({
    method: 'POST', url: '/api/v1/tank-readings',
    headers: { 'content-type': 'application/json', 'x-device-token': TOKEN },
    payload: { ...body, timestamp: '2026-10-23T08:50:40Z', waterLevelPct: null, calibrated: true },
  });
  assert.equal(lie.statusCode, 400);
  assert.equal(lie.json().field, 'waterLevelPct');
  const bearer = await app.inject({
    method: 'POST', url: '/api/v1/tank-readings',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + APP },
    payload: { ...body, timestamp: '2026-10-23T08:50:50Z' },
  });
  assert.equal(bearer.statusCode, 401);
  const proxied = await app.inject({
    method: 'POST', url: '/ui/api/v1/tank-readings',
    headers: { host: 'localhost:3000', 'content-type': 'application/json', 'x-requested-with': 'mzansi-ui' },
    payload: body,
    remoteAddress: '127.0.0.1',
  });
  assert.equal(proxied.statusCode, 404);
  await app.close();
});

test('schema load action and tank table file are present', () => {
  const ps1 = readFileSync(join(root, 'scripts/oe-run.ps1'), 'utf8');
  const df = readFileSync(join(root, 'openedge/schema/010-tank.df'), 'utf8');
  assert.match(ps1, /'load-tank'/);
  assert.match(ps1, /010-tank\.df/);
  assert.match(df, /ADD TABLE "TankReading"/);
  assert.match(df, /ADD FIELD "LevelPct"/);
  assert.match(df, /ADD FIELD "LevelRaw"/);
  assert.match(df, /ADD FIELD "Calibrated"/);
});
