// Similar past plant-doctor cases. Offline: mock AI (no key) matches crop + condition.
// A stub provider stands in for the description embedding so cosine ranking is tested without a network call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';
import { cosine, formatVector, parseVector, rankCases, similarLabel, visualLineFromModel } from '../apps/api/src/ai/similar.js';

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]).toString('base64');
const META = { crop: 'Tomato', plantPart: 'leaf', growthStage: 'fruiting', province: 'KwaZulu-Natal' };
const APP = 'sim-app-token-fixture-123';
const baseEnv = { OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'sim-device-token-fixture-1' }]) };

function mkApp(extra = {}, provider = createMockProvider(), clock) {
  const config = loadConfig({ ...baseEnv, LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-sim-')), ...extra });
  return buildApp({ config, oe: createOeClient(config, clock ? { clock } : {}), provider, ...(clock ? { clock } : {}) });
}
const api = async (app, method, url, payload, token = APP) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const diag = (app, extra = {}) => api(app, 'POST', '/api/v1/doctor/diagnoses', { ...META, photos: [{ mimeType: 'image/jpeg', dataBase64: JPG }], ...extra });
const vec = (hot) => Array.from({ length: 32 }, (_, i) => (i === hot ? 1 : 0));

test('cosine, vector format, and the farmer-facing label', () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  const stored = formatVector(vec(0));
  assert.ok(stored.startsWith('[1.000000,'));
  assert.equal(parseVector(stored).length, 32);
  assert.equal(parseVector('not-json'), null);
  assert.equal(parseVector(JSON.stringify(Array(4).fill(0.1))), null);
  assert.match(similarLabel({ condition: 'Early blight (likely)', province: 'KwaZulu-Natal', createdAt: '2026-10-25T08:00:00.000Z' }, new Date('2026-10-28T08:00:00.000Z')), /^Early blight, KwaZulu-Natal, 3 days ago$/);
  const line = visualLineFromModel('{"cropSeen":"tomato","part":"leaf","colours":"brown","pattern":"rings","symptoms":"spots"}');
  assert.match(line, /pattern: rings/);
  assert.equal(visualLineFromModel('not json'), null);
});

test('rankCases uses cosine of the description embedding, else crop and condition', () => {
  const now = new Date('2026-10-28T12:00:00.000Z');
  const rows = [
    { diagnosisId: 1, crop: 'Tomato', condition: 'Early blight (likely)', province: 'KwaZulu-Natal', plantPart: 'leaf', createdAt: '2026-10-25T12:00:00.000Z', embedModel: 'gemini-embedding-001', embedVector: formatVector(vec(0)) },
    { diagnosisId: 2, crop: 'Tomato', condition: 'Leaf spot (likely)', province: 'Limpopo', plantPart: 'leaf', createdAt: '2026-10-27T12:00:00.000Z', embedModel: 'gemini-embedding-001', embedVector: formatVector(vec(1)) },
    { diagnosisId: 3, crop: 'Maize', condition: 'Streak (likely)', province: 'Gauteng', plantPart: 'leaf', createdAt: '2026-10-27T12:00:00.000Z', embedModel: 'gemini-embedding-001', embedVector: formatVector(vec(1)) },
  ];
  const hit = rankCases({ crop: 'Tomato', condition: 'Early blight (likely)', embedModel: 'gemini-embedding-001', embedVector: formatVector(vec(0)), excludeDiagnosisId: 9 }, rows, { now });
  assert.equal(hit.method, 'description_embedding');
  assert.equal(hit.compared, 'visual_description_text');
  assert.equal(hit.cases[0].diagnosisId, 1);
  assert.equal(hit.cases[0].label, 'Early blight, KwaZulu-Natal, 3 days ago');
  assert.ok(hit.cases[0].score > 0.9);
  const none = rankCases({ crop: 'Maize', condition: 'Streak (likely)', plantPart: 'leaf' }, rows.map((r) => ({ ...r, embedVector: '', embedModel: '' })), { now });
  assert.equal(none.method, 'crop_condition');
  assert.equal(none.compared, 'crop_and_condition');
  assert.deepEqual(none.cases.map((c) => c.diagnosisId), [3]);
});

test('API with no AI key: crop and condition, label, and a second run does not crash', async () => {
  let t = Date.parse('2026-10-25T08:00:00.000Z');
  const app = mkApp({}, createMockProvider(), () => new Date(t));
  const first = await diag(app);
  assert.equal(first.status, 201);
  assert.equal(first.body.similarMethod, 'crop_condition');
  assert.deepEqual(first.body.similarCases, []);
  assert.equal(first.body.diagnosis.hasDescriptionEmbedding, false);
  t += 3 * 86400000;
  const second = await diag(app);
  assert.equal(second.status, 201);
  assert.equal(second.body.similarMethod, 'crop_condition');
  assert.equal(second.body.similarCompared, 'crop_and_condition');
  assert.equal(second.body.similarCases[0].label, 'Early blight, KwaZulu-Natal, 3 days ago');
  assert.notEqual(second.body.similarCases[0].diagnosisId, second.body.diagnosis.diagnosisId);
  const listed = await api(app, 'POST', '/api/v1/doctor/similar', { crop: 'Tomato', condition: 'Early blight (likely)' });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.similarCases.length >= 1);
  await app.close();
});

test('API description embedding: cosine match, and a different crop falls back', async () => {
  const provider = createMockProvider();
  provider.describePhotos = async (meta) => (meta.crop === 'Maize'
    ? 'crop: maize; part: leaf; colours: yellow; pattern: streaks; symptoms: long stripes'
    : 'crop: tomato; part: leaf; colours: brown; pattern: rings; symptoms: spots on older leaves');
  provider.embedText = async (text) => ({ model: 'gemini-embedding-001', vector: vec(String(text).includes('rings') ? 0 : 1) });
  const app = mkApp({}, provider);
  const a = await diag(app);
  assert.equal(a.body.diagnosis.hasDescriptionEmbedding, true);
  assert.equal(a.body.diagnosis.embedModel, 'gemini-embedding-001');
  const b = await diag(app);
  assert.equal(b.body.similarMethod, 'description_embedding');
  assert.equal(b.body.similarCompared, 'visual_description_text');
  assert.equal(b.body.similarCases[0].diagnosisId, a.body.diagnosis.diagnosisId);
  assert.ok(b.body.similarCases[0].score > 0.99);
  const maize = await diag(app, { crop: 'Maize' });
  assert.equal(maize.status, 201);
  assert.equal(maize.body.similarMethod, 'crop_condition');
  assert.equal(maize.body.similarCases.length, 0);
  await app.close();
});

test('SIMILAR_CASES=off does not call the model and still stores the diagnosis', async () => {
  let called = 0;
  const provider = createMockProvider();
  provider.describePhotos = async () => { called++; return 'crop: tomato; part: leaf; colours: brown; pattern: rings; symptoms: spots'; };
  provider.embedText = async () => { called++; return { model: 'gemini-embedding-001', vector: vec(0) }; };
  const app = mkApp({ SIMILAR_CASES: 'off' }, provider);
  const r = await diag(app);
  assert.equal(r.status, 201);
  assert.equal(called, 0);
  assert.equal(r.body.similarMethod, 'disabled');
  assert.deepEqual(r.body.similarCases, []);
  await app.close();
});

test('a failing description embedding does not fail the diagnosis', async () => {
  const provider = createMockProvider();
  provider.describePhotos = async () => { throw Object.assign(new Error('down'), { kind: 'network' }); };
  provider.embedText = async () => { throw new Error('should not be called'); };
  const app = mkApp({}, provider);
  const r = await diag(app);
  assert.equal(r.status, 201);
  assert.equal(r.body.usedFallback, false);
  assert.equal(r.body.similarMethod, 'crop_condition');
  await app.close();
});
