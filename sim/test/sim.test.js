'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCli, makeTimestampSource, generateReadings, classify, send } = require('../esp32-sim');

const opts = (argv = []) => parseCli(argv);
const collect = (o, now) => [...generateReadings(o, makeTimestampSource(o, now))];

test('parseCli defaults and validation', () => {
  const o = opts();
  assert.equal(o.scenario, 'normal');
  assert.equal(o.intervalS, 30);
  assert.equal(o.url, 'http://localhost:3000');
  assert.equal(o.plotId, 1);
  assert.throws(() => opts(['--scenario', 'nope']), /scenario/);
  assert.throws(() => opts(['--plot-id', 'abc']), /integer/);
  assert.throws(() => opts(['--count', '-1']), /count/);
  assert.equal(opts(['--url', 'http://x:3000/']).url, 'http://x:3000');
});

test('every reading gets a unique, strictly increasing timestamp even with a frozen clock', () => {
  const rs = collect(opts(['--count', '50']), () => 1792828800000);
  const ts = rs.map((r) => r.timestamp);
  assert.equal(new Set(ts).size, 50);
  assert.deepEqual([...ts].sort(), ts);
  ts.forEach((t) => assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/));
});

test('stale (stop): sends --stale-after readings then stops', () => {
  const rs = collect(opts(['--scenario', 'stale', '--count', '10', '--stale-after', '3']));
  assert.equal(rs.length, 3);
});

test('stale (old): keeps sending but with old, unique timestamps', () => {
  const now = () => Date.parse('2026-10-24T08:00:00Z');
  const rs = collect(opts(['--scenario', 'stale', '--stale-mode', 'old', '--stale-after', '2', '--count', '6']), now);
  assert.equal(rs.length, 6);
  const fresh = rs.slice(0, 2).map((r) => Date.parse(r.timestamp));
  const old = rs.slice(2).map((r) => Date.parse(r.timestamp));
  assert.ok(old.every((t) => now() - t >= 3600 * 1000), 'at least an hour old');
  assert.ok(fresh.every((t) => now() - t < 3600 * 1000));
  assert.equal(new Set(rs.map((r) => r.timestamp)).size, 6);
});

test('invalid scenario emits soilMoisturePct 150', () => {
  for (const r of collect(opts(['--scenario', 'invalid', '--count', '3']))) assert.equal(r.soilMoisturePct, 150);
});

test('classify matches the firmware policy', () => {
  assert.equal(classify(201), 'success');
  assert.equal(classify(409), 'duplicate');
  assert.equal(classify(400), 'bad');
  assert.equal(classify(401), 'auth');
  assert.equal(classify(500), 'retry');
  assert.equal(classify(503), 'retry');
  assert.equal(classify(0), 'retry');
});

const fakeFetch = (statuses) => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const s = statuses.shift();
    if (s === 'throw') throw new Error('ECONNREFUSED');
    return { status: s, text: async () => (s === 400 ? '{"error":"bad","field":"soilMoisturePct"}' : '{}') };
  };
  f.calls = calls;
  return f;
};
const sendWith = (statuses, extra = {}) => {
  const fetchImpl = fakeFetch(statuses);
  const logs = [];
  const p = send({ a: 1 }, { url: 'http://h:3000', token: 'tok', maxAttempts: 4, backoffBaseMs: 1, backoffMaxMs: 2, log: (m) => logs.push(m), fetchImpl, ...extra });
  return p.then((result) => ({ result, fetchImpl, logs }));
};

test('send: uses path and X-Device-Token header (not Authorization)', async () => {
  const { fetchImpl } = await sendWith([201]);
  const c = fetchImpl.calls[0];
  assert.equal(c.url, 'http://h:3000/api/v1/readings');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['X-Device-Token'], 'tok');
  assert.equal(c.init.headers.Authorization, undefined);
});

test('send: 201 success, 409 treated as success (no retry)', async () => {
  assert.equal((await sendWith([201])).result, 'success');
  const d = await sendWith([409]);
  assert.equal(d.result, 'duplicate');
  assert.equal(d.fetchImpl.calls.length, 1);
});

test('send: 400 is not retried and logs the field; 401 is not retried', async () => {
  const b = await sendWith([400]);
  assert.equal(b.result, 'bad');
  assert.equal(b.fetchImpl.calls.length, 1);
  assert.match(b.logs.join('\n'), /soilMoisturePct/);
  const a = await sendWith([401]);
  assert.equal(a.result, 'auth');
  assert.equal(a.fetchImpl.calls.length, 1);
});

test('send: retries 5xx and network errors, then succeeds', async () => {
  const r = await sendWith([503, 'throw', 201]);
  assert.equal(r.result, 'success');
  assert.equal(r.fetchImpl.calls.length, 3);
});

test('send: gives up after maxAttempts', async () => {
  const r = await sendWith([500, 500, 500, 500, 500]);
  assert.equal(r.result, 'failed');
  assert.equal(r.fetchImpl.calls.length, 4);
});
