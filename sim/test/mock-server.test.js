'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../mock-server');
const { buildPayload } = require('../payload');
const { main } = require('../esp32-sim');

const TOKEN = 'test-token';
const good = (ts = '2026-10-24T08:00:00Z') => buildPayload({ deviceId: 'esp32-01', plotId: 1, timestamp: ts, soilMoisturePct: 40, temperatureC: 22, humidityPct: 55 });

async function withServer(fn) {
  const server = createServer({ token: TOKEN, log: () => {} });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, server); } finally { await new Promise((r) => server.close(r)); }
}
const post = (base, body, headers = { 'X-Device-Token': TOKEN }) =>
  fetch(base + '/api/v1/readings', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('201 {id} for a valid reading', () => withServer(async (base, s) => {
  const r = await post(base, good());
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { id: 1 });
  assert.equal(s.stored.length, 1);
}));

test('401 on missing or bad token, and Authorization: Bearer is not accepted', () => withServer(async (base) => {
  assert.equal((await post(base, good(), {})).status, 401);
  assert.equal((await post(base, good(), { 'X-Device-Token': 'nope' })).status, 401);
  assert.equal((await post(base, good(), { Authorization: `Bearer ${TOKEN}` })).status, 401);
}));

test('400 {error, field} for an invalid field and for malformed JSON', () => withServer(async (base) => {
  const r = await post(base, { ...good(), soilMoisturePct: 150 });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.field, 'soilMoisturePct');
  assert.ok(j.error);
  const m = await post(base, '{not json');
  assert.equal(m.status, 400);
  assert.equal((await m.json()).field, 'body');
  const p = await post(base, { ...good(), plotId: '1' });
  assert.equal((await p.json()).field, 'plotId');
}));

test('409 on duplicate deviceId+timestamp; a new timestamp is accepted', () => withServer(async (base) => {
  assert.equal((await post(base, good())).status, 201);
  assert.equal((await post(base, good())).status, 409);
  assert.equal((await post(base, good('2026-10-24T08:00:30Z'))).status, 201);
  assert.equal((await post(base, { ...good(), deviceId: 'esp32-02' })).status, 201);
}));

test('end-to-end: sim -> mock (normal) stores every reading with no 409s', () => withServer(async (base, s) => {
  const code = await main(['--scenario', 'normal', '--count', '5', '--interval', '0', '--url', base], { DEVICE_TOKEN: TOKEN });
  assert.equal(code, 0);
  assert.equal(s.stored.length, 5);
  assert.equal(new Set(s.stored.map((x) => x.timestamp)).size, 5);
}));

test('end-to-end: sim invalid scenario is rejected with 400 and nothing stored', () => withServer(async (base, s) => {
  await main(['--scenario', 'invalid', '--count', '2', '--interval', '0', '--url', base], { DEVICE_TOKEN: TOKEN });
  assert.equal(s.stored.length, 0);
}));

test('end-to-end: wrong token -> exit code 1, nothing stored', () => withServer(async (base, s) => {
  const code = await main(['--count', '1', '--interval', '0', '--url', base], { DEVICE_TOKEN: 'wrong' });
  assert.equal(code, 1);
  assert.equal(s.stored.length, 0);
}));

test('sim: missing DEVICE_TOKEN is an error unless --dry-run', async () => {
  assert.equal(await main(['--count', '1'], {}), 2);
  assert.equal(await main(['--count', '1', '--dry-run'], {}), 0);
});
