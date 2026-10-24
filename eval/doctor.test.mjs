// Plant doctor tests (run by `npm test`, or alone: node --test eval/doctor.test.mjs). Offline: mock AI, mock OpenEdge, tiny fake photos.
// The ABL rule cases DR01 to DR31 are in eval/oe-contract-cases.json and run against mock-pasoe AND the real ABL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';
import { checkPhotos, checkDoctorAnswer, fallbackAnswer, mockDoctorAnswer, MAX_PHOTO_BYTES } from '../apps/api/src/ai/doctor.js';

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(60, 1)]).toString('base64');
const META = { crop: 'Tomato', plantPart: 'leaf', growthStage: 'fruiting', province: 'KwaZulu-Natal' };
const APP = 'dr-app-token-fixture-123';

function mkApp(behaviour) {
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-dr-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'dr-device-token-fixture-1' }]) });
  return buildApp({ config, oe: createOeClient(config), provider: createMockProvider({ behaviour }) });
}
const api = async (app, method, url, payload, token = APP) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const diag = (app, extra = {}) => api(app, 'POST', '/api/v1/doctor/diagnoses', { ...META, photos: [{ mimeType: 'image/jpeg', dataBase64: JPG }], ...extra });

test('photos: 1 to 3, JPEG/PNG/WebP only, content must match the type, 3 MB each', () => {
  assert.equal(checkPhotos([{ mimeType: 'image/jpeg', dataBase64: JPG }, { mimeType: 'image/png', dataBase64: PNG }]).ok, true);
  assert.equal(checkPhotos([]).code, 'VALIDATION_ERROR');
  assert.equal(checkPhotos(Array(4).fill({ mimeType: 'image/jpeg', dataBase64: JPG })).code, 'VALIDATION_ERROR');
  const gif = checkPhotos([{ mimeType: 'image/gif', dataBase64: JPG }]); assert.equal(gif.status, 415); assert.equal(gif.code, 'PHOTO_TYPE_NOT_ALLOWED');
  const fake = checkPhotos([{ mimeType: 'image/png', dataBase64: JPG }]); assert.equal(fake.status, 415);   // a JPEG claiming to be PNG
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_PHOTO_BYTES)]).toString('base64');
  const r = checkPhotos([{ mimeType: 'image/jpeg', dataBase64: big }]); assert.equal(r.status, 413); assert.equal(r.code, 'PHOTO_TOO_LARGE');
  assert.equal(checkPhotos([{ mimeType: 'image/jpeg', dataBase64: 'not base64!' }]).code, 'VALIDATION_ERROR');
});

test('server check: dose-quantity steps are removed, steps sorted cheapest first; too few left means fallback', () => {
  const r = checkDoctorAnswer(JSON.stringify(mockDoctorAnswer(META, 'dose')));
  assert.equal(r.ok, true); assert.equal(r.removedSteps, 1);
  assert.ok(r.result.steps.every((s) => !/ml/.test(s.text)));
  const order = ['free', 'low', 'medium', 'high'];
  assert.deepEqual(r.result.steps.map((s) => s.cost), [...r.result.steps.map((s) => s.cost)].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  const all = checkDoctorAnswer(mockDoctorAnswer(META, 'dose-all'));
  assert.equal(all.ok, false); assert.equal(all.reason, 'dose_removed');
  assert.equal(checkDoctorAnswer('```json\n' + JSON.stringify(mockDoctorAnswer(META)) + '\n```').ok, true);
  assert.equal(checkDoctorAnswer('looks like blight').reason, 'invalid_json');
  assert.equal(checkDoctorAnswer(mockDoctorAnswer(META, 'injection')).ok, false);
});

test('fallback answer: passes the server check and names no chemical', () => {
  const r = checkDoctorAnswer(fallbackAnswer());
  assert.equal(r.ok, true); assert.equal(r.removedSteps, 0);
  assert.doesNotMatch(JSON.stringify(fallbackAnswer()), /spray|fungicide|pesticide|copper|sulphur|dose/i);
});

test('API: normal answer is stored pending the farmer; save then a second decision is 409; list and get', async () => {
  const app = mkApp();
  const r = await diag(app);
  assert.equal(r.status, 201); assert.equal(r.body.usedFallback, false);
  assert.equal(r.body.diagnosis.status, 'pending_review'); assert.equal(r.body.diagnosis.photoCount, 1);
  const id = r.body.diagnosis.diagnosisId;
  assert.equal((await api(app, 'POST', `/api/v1/doctor/diagnoses/${id}/save`, {})).body.status, 'saved');
  assert.equal((await api(app, 'POST', `/api/v1/doctor/diagnoses/${id}/dismiss`, {})).status, 409);
  assert.equal((await api(app, 'GET', `/api/v1/doctor/diagnoses/${id}`)).body.diagnosisId, id);
  assert.equal((await api(app, 'GET', '/api/v1/doctor/diagnoses')).body.diagnoses.length, 1);
  await app.close();
});

test('API: needs the app token; bad metadata 400; GIF 415', async () => {
  const app = mkApp();
  assert.equal((await api(app, 'POST', '/api/v1/doctor/diagnoses', { ...META, photos: [] }, null)).status, 401);
  const m = await diag(app, { province: 'Atlantis' }); assert.equal(m.status, 400); assert.equal(m.body.field, 'province');
  assert.equal((await diag(app, { photos: [{ mimeType: 'image/gif', dataBase64: JPG }] })).status, 415);
  await app.close();
});

test('API: a dose step is stripped by the server and the rest is stored', async () => {
  const app = mkApp('dose');
  const r = await diag(app);
  assert.equal(r.status, 201); assert.equal(r.body.usedFallback, false); assert.equal(r.body.removedSteps, 1);
  assert.ok(r.body.diagnosis.steps.every((s) => !/fungicide/.test(s.text)));
  await app.close();
});

test('API: a hidden dose the server misses is caught by OpenEdge DOSE_BLOCKED; the safe fallback is stored instead', async () => {
  const app = mkApp('dose-hidden');
  const r = await diag(app);
  assert.equal(r.status, 201); assert.equal(r.body.usedFallback, true); assert.equal(r.body.fallbackReason, 'dose_blocked');
  assert.ok(r.body.blocked.some((b) => b.field === 'callExpert'));
  assert.equal(r.body.diagnosis.condition, fallbackAnswer().condition);
  await app.close();
});

for (const [b, reason] of [['timeout', /timeout|ai/], ['bad-json', /invalid_json/], ['dose-all', /dose_removed/]]) {
  test(`API: AI ${b} gives the safe fallback, never an error`, async () => {
    const app = mkApp(b);
    const r = await diag(app);
    assert.equal(r.status, 201); assert.equal(r.body.usedFallback, true); assert.match(r.body.fallbackReason, reason);
    await app.close();
  });
}

test('API: admin word list: add, duplicate 409, switch off', async () => {
  const app = mkApp();
  const a = await api(app, 'POST', '/api/v1/doctor/blocked-terms', { term: 'neem oil', kind: 'chemical' });
  assert.equal(a.status, 201);
  assert.equal((await api(app, 'POST', '/api/v1/doctor/blocked-terms', { term: 'neem oil', kind: 'chemical' })).status, 409);
  assert.equal((await api(app, 'POST', `/api/v1/doctor/blocked-terms/${a.body.termId}`, { active: false })).body.active, false);
  assert.ok((await api(app, 'GET', '/api/v1/doctor/blocked-terms')).body.terms.length >= 33);
  await app.close();
});
