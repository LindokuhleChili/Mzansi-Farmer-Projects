'use strict';
// ============================================================================
// API CONTRACT  (single place to edit on the sim side; firmware twin:
// firmware/esp32/lib/feedcore/feedcore.h)
//
// POST {API_BASE_URL}/api/v1/readings
// Header  X-Device-Token: <DEVICE_TOKEN>
// Body    {"deviceId":"esp32-01","plotId":1,"timestamp":"2026-10-24T08:00:00Z",
//          "soilMoisturePct":0-100,"temperatureC":n,"humidityPct":0-100}
// Replies 201 {id} | 400 {error,field} | 401 | 409 duplicate (deviceId+timestamp)
// ============================================================================
const CONTRACT = Object.freeze({
  path: '/api/v1/readings',
  authHeader: 'X-Device-Token',
  fields: Object.freeze({
    deviceId: 'deviceId',
    plotId: 'plotId', // INTEGER
    timestamp: 'timestamp', // ISO-8601 UTC, trailing Z, no milliseconds
    soil: 'soilMoisturePct',
    temp: 'temperatureC',
    humidity: 'humidityPct',
  }),
  limits: Object.freeze({
    pct: [0, 100],
    tempC: [-40, 80],
  }),
});
// ============================================================================

const F = CONTRACT.fields;

/** Round half away from zero to `dp` decimals; never returns -0. */
function round(v, dp = 1) {
  const s = 10 ** dp;
  const r = Math.sign(v) * Math.round(Math.abs(v) * s) / s;
  return r === 0 ? 0 : r;
}

/** Date | epoch ms | ISO string -> "YYYY-MM-DDTHH:MM:SSZ" (UTC, no millis). */
function toIsoUtc(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new TypeError(`invalid date: ${input}`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Build the JSON object for one reading. Values are rounded to 1 dp.
 * NaN/non-finite values THROW (the firmware likewise refuses to send them).
 * It does NOT clamp: the `invalid` scenario relies on out-of-range values
 * passing through so the server's 400 can be exercised.
 */
function buildPayload({ deviceId, plotId, timestamp, soilMoisturePct, temperatureC, humidityPct }) {
  if (typeof deviceId !== 'string' || deviceId === '') throw new TypeError('deviceId must be a non-empty string');
  if (!Number.isInteger(plotId)) throw new TypeError('plotId must be an integer');
  for (const [k, v] of Object.entries({ soilMoisturePct, temperatureC, humidityPct })) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${k} must be a finite number (got ${v})`);
  }
  return {
    [F.deviceId]: deviceId,
    [F.plotId]: plotId,
    [F.timestamp]: toIsoUtc(timestamp),
    [F.soil]: round(soilMoisturePct, 1),
    [F.temp]: round(temperatureC, 1),
    [F.humidity]: round(humidityPct, 1),
  };
}

/**
 * Contract validation (shared by the mock server and tests).
 * Returns null if valid, otherwise {error, field} - the shape of a 400 body.
 */
function validatePayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object', field: 'body' };
  const id = body[F.deviceId];
  if (typeof id !== 'string' || id.trim() === '') return { error: 'must be a non-empty string', field: F.deviceId };
  if (!Number.isInteger(body[F.plotId])) return { error: 'must be an integer', field: F.plotId };
  const ts = body[F.timestamp];
  if (typeof ts !== 'string' || !ISO_RE.test(ts) || Number.isNaN(Date.parse(ts)) || toIsoUtc(ts) !== ts) {
    return { error: 'must be ISO-8601 UTC like 2026-10-24T08:00:00Z', field: F.timestamp };
  }
  const [pMin, pMax] = CONTRACT.limits.pct;
  for (const f of [F.soil, F.humidity]) {
    const v = body[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < pMin || v > pMax) return { error: `must be a number ${pMin}-${pMax}`, field: f };
  }
  const [tMin, tMax] = CONTRACT.limits.tempC;
  const t = body[F.temp];
  if (typeof t !== 'number' || !Number.isFinite(t) || t < tMin || t > tMax) return { error: `must be a number ${tMin}..${tMax}`, field: F.temp };
  return null;
}

module.exports = { CONTRACT, round, toIsoUtc, buildPayload, validatePayload, ISO_RE };
