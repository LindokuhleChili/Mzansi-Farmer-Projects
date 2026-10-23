'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCENARIOS, SCENARIO_NAMES, makeRng } = require('../scenarios');
const { validatePayload, buildPayload } = require('../payload');

const run = (name, n, seed = 1, opts) => {
  const rng = makeRng(seed);
  return Array.from({ length: n }, (_, i) => SCENARIOS[name](i, rng, opts));
};

test('scenario list', () => assert.deepEqual([...SCENARIO_NAMES].sort(), ['drought', 'invalid', 'normal', 'stale']));

test('normal / drought / stale stay in valid ranges for 500 steps', () => {
  for (const name of ['normal', 'drought', 'stale']) {
    run(name, 500).forEach((v, i) => {
      const p = buildPayload({ deviceId: 'esp32-01', plotId: 1, timestamp: new Date(1792828800000 + i * 30000), ...v });
      assert.equal(validatePayload(p), null, `${name} step ${i}: ${JSON.stringify(p)}`);
    });
  }
});

test('normal: plausible fluctuation (moderate, not constant)', () => {
  const vs = run('normal', 200);
  const soil = vs.map((v) => v.soilMoisturePct);
  assert.ok(Math.min(...soil) >= 25 && Math.max(...soil) <= 70);
  assert.ok(Math.max(...soil) - Math.min(...soil) > 2, 'should vary');
  assert.ok(vs.every((v) => v.temperatureC >= 15 && v.temperatureC <= 32));
});

test('drought: soil decays to a low value; hot; low humidity', () => {
  const vs = run('drought', 60, 1, { steps: 40 });
  assert.ok(vs[0].soilMoisturePct > 30, 'starts moist');
  assert.ok(vs[59].soilMoisturePct < 15, 'ends dry');
  const avg = (k, a) => a.reduce((s, v) => s + v[k], 0) / a.length;
  assert.ok(avg('soilMoisturePct', vs.slice(-10)) < avg('soilMoisturePct', vs.slice(0, 10)));
  assert.ok(vs.every((v) => v.temperatureC >= 30), 'hot');
  assert.ok(vs.every((v) => v.humidityPct <= 30), 'dry air');
});

test('invalid: soilMoisturePct is 150 and the server would reject that field', () => {
  for (const v of run('invalid', 5)) {
    assert.equal(v.soilMoisturePct, 150);
    const p = buildPayload({ deviceId: 'esp32-01', plotId: 1, timestamp: new Date(), ...v });
    assert.equal(validatePayload(p).field, 'soilMoisturePct');
  }
});

test('deterministic for a given seed, different across seeds', () => {
  assert.deepEqual(run('normal', 20, 7), run('normal', 20, 7));
  assert.notDeepEqual(run('normal', 20, 7), run('normal', 20, 8));
});
