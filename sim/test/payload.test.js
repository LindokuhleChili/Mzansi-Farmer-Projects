'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CONTRACT, round, toIsoUtc, buildPayload, validatePayload } = require('../payload');

const base = { deviceId: 'esp32-01', plotId: 1, timestamp: new Date('2026-10-24T08:00:00.789Z'), soilMoisturePct: 42.34, temperatureC: 23.46, humidityPct: 61.04 };

test('contract constants', () => {
  assert.equal(CONTRACT.path, '/api/v1/readings');
  assert.equal(CONTRACT.authHeader, 'X-Device-Token');
});

test('exact field names, order and rounding to 1 dp', () => {
  const p = buildPayload(base);
  assert.deepEqual(Object.keys(p), ['deviceId', 'plotId', 'timestamp', 'soilMoisturePct', 'temperatureC', 'humidityPct']);
  assert.equal(JSON.stringify(p), '{"deviceId":"esp32-01","plotId":1,"timestamp":"2026-10-24T08:00:00Z","soilMoisturePct":42.3,"temperatureC":23.5,"humidityPct":61}');
});

test('plotId is an integer, not a string', () => {
  assert.equal(typeof buildPayload(base).plotId, 'number');
  assert.throws(() => buildPayload({ ...base, plotId: '1' }), TypeError);
  assert.throws(() => buildPayload({ ...base, plotId: 1.5 }), TypeError);
});

test('timestamp is ISO-8601 UTC with trailing Z and no milliseconds', () => {
  const p = buildPayload(base);
  assert.match(p.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(p.timestamp, '2026-10-24T08:00:00Z');
  assert.equal(toIsoUtc(1792828800000), '2026-10-24T08:00:00Z');
  assert.equal(toIsoUtc('2026-10-24T10:00:00+02:00'), '2026-10-24T08:00:00Z');
  assert.throws(() => toIsoUtc('nonsense'), TypeError);
});

test('NaN / Infinity / non-numbers are refused', () => {
  for (const k of ['soilMoisturePct', 'temperatureC', 'humidityPct']) {
    for (const bad of [NaN, Infinity, -Infinity, '12', null, undefined]) {
      assert.throws(() => buildPayload({ ...base, [k]: bad }), TypeError, `${k}=${bad}`);
    }
  }
});

test('rounding: half away from zero, never -0', () => {
  assert.equal(round(2.45), 2.5);
  assert.equal(round(-2.45), -2.5);
  assert.equal(Object.is(round(-0.04), 0), true);
  assert.equal(Object.is(buildPayload({ ...base, temperatureC: -0.04 }).temperatureC, 0), true);
});

test('builder does not clamp (so the invalid scenario can reach the API)', () => {
  assert.equal(buildPayload({ ...base, soilMoisturePct: 150 }).soilMoisturePct, 150);
});

test('validatePayload accepts good payloads and reports the bad field', () => {
  assert.equal(validatePayload(buildPayload(base)), null);
  const cases = [
    [{ soilMoisturePct: 150 }, 'soilMoisturePct'],
    [{ soilMoisturePct: -1 }, 'soilMoisturePct'],
    [{ humidityPct: 100.5 }, 'humidityPct'],
    [{ temperatureC: 200 }, 'temperatureC'],
    [{ plotId: '1' }, 'plotId'],
    [{ deviceId: '' }, 'deviceId'],
    [{ timestamp: '2026-10-24T08:00:00.000Z' }, 'timestamp'],
    [{ timestamp: '2026-10-24 08:00:00' }, 'timestamp'],
    [{ timestamp: '2026-13-45T08:00:00Z' }, 'timestamp'],
  ];
  for (const [patch, field] of cases) {
    const r = validatePayload({ ...buildPayload(base), ...patch });
    assert.equal(r?.field, field, JSON.stringify(patch));
    assert.ok(r.error);
  }
  assert.equal(validatePayload(null).field, 'body');
  assert.equal(validatePayload([]).field, 'body');
});
