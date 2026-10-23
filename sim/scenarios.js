'use strict';
// Scenario generators. Each returns {soilMoisturePct, temperatureC, humidityPct}
// for step `i` (0-based). Deterministic given a seed.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Small seedable PRNG (mulberry32) -> [0,1). */
function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const jitter = (rng, amp) => (rng() * 2 - 1) * amp;

function normal(i, rng) {
  const wave = Math.sin(i / 20); // slow drift, ~2 h cycle at 30 s steps
  return {
    soilMoisturePct: clamp(45 + 6 * wave + jitter(rng, 1.5), 25, 70),
    temperatureC: clamp(23 + 3 * Math.sin(i / 30) + jitter(rng, 0.4), 15, 32),
    humidityPct: clamp(60 - 5 * Math.sin(i / 30) + jitter(rng, 1.5), 40, 85),
  };
}

/** Soil decays exponentially from ~40% to ~8%; hot and dry air. */
function drought(i, rng, { steps = 40 } = {}) {
  const tau = steps / 3; // ~95% of the way to the floor after `steps`
  const floor = 8;
  const start = 40;
  return {
    soilMoisturePct: clamp(floor + (start - floor) * Math.exp(-i / tau) + jitter(rng, 0.4), 0, 100),
    temperatureC: clamp(34 + Math.min(i, steps) * 0.06 + jitter(rng, 0.5), 30, 42),
    humidityPct: clamp(25 - Math.min(i, steps) * 0.2 + jitter(rng, 1), 10, 30),
  };
}

/** Normal-looking values; staleness is handled by the sender (see esp32-sim.js). */
const stale = normal;

/** Soil moisture 150 (out of range) so the API answers 400 {field:"soilMoisturePct"}. */
function invalid(i, rng) {
  return { ...normal(i, rng), soilMoisturePct: 150 };
}

const SCENARIOS = Object.freeze({ normal, drought, stale, invalid });
const SCENARIO_NAMES = Object.freeze(Object.keys(SCENARIOS));

module.exports = { SCENARIOS, SCENARIO_NAMES, makeRng, normal, drought, stale, invalid };
