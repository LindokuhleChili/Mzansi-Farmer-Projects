// Unit / resilience tests for the three QA bugs (run by `npm test`, or alone: node --test eval/).
//  BUG-1  hold/notify must not carry litres (AI schema) and must not count against the water budget (rules: eval/oe-contract-cases.json BUD*)
//  BUG-2  an OpenEdge outage must not make a request wait twice (no audit write to the dead server)
//  BUG-3  real calendar validation of timestamps (leap years included)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, AUDIT_TIMEOUT_MS } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { proposeAction } from '../apps/api/src/ai/advise.js';
import { buildApp } from '../apps/api/src/app.js';
import { isValidIsoTimestamp } from '../apps/api/src/iso.js';
import { parseIso } from '../mock-pasoe/time.js';

const ctx = {
  plot: { plotId: 2, plotName: 'Beans Plot B (example)', maxIrrigationLitres: 300, dryThresholdPct: 40, weeklyWaterBudgetL: 900, areaHa: 1 },
  latest: { soilMoisturePct: 62, temperatureC: 25, humidityPct: 50, raining: false },
  facts: { usedLast7DaysL: 0, staleLimitMinutes: 15, readingAgeMinutes: 3, soilMoisturePct: 62, dryThresholdPct: 40 },
  insight: { trendPctPerHour: 0, hoursToDryThreshold: null },
};
const fake = (obj) => ({ name: 'fake', propose: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });

// ---------------- BUG-1
test('BUG-1: hold with litres 500 fails the schema and falls back to a proposal with 0 litres', async () => {
  const { proposal, ai } = await proposeAction(fake({ action: 'hold', litres: 500, reason: 'Hold for now.' }), ctx, 'en');
  assert.equal(ai.usedFallback, true);
  assert.match(ai.fallbackReason, /^schema:/);
  assert.equal(proposal.litres, 0);
});
test('BUG-1: notify with litres 1 also fails the schema', async () => {
  const { ai } = await proposeAction(fake({ action: 'notify', litres: 1, reason: 'Check sensor.' }), ctx, 'en');
  assert.equal(ai.usedFallback, true);
});
test('BUG-1: hold / notify with litres 0 or litres left out are accepted, and litres is normalised to 0', async () => {
  for (const p of [{ action: 'hold', litres: 0, reason: 'Hold.' }, { action: 'hold', reason: 'Hold.' }, { action: 'notify', reason: 'Check sensor.' }]) {
    const { proposal, ai } = await proposeAction(fake(p), ctx, 'en');
    assert.equal(ai.usedFallback, false, JSON.stringify(p));
    assert.equal(proposal.litres, 0);
    assert.equal(proposal.action, p.action);
  }
});
test('BUG-1: irrigate still needs litres', async () => {
  const miss = await proposeAction(fake({ action: 'irrigate', reason: 'Dry.' }), ctx, 'en');
  assert.equal(miss.ai.usedFallback, true);
  const ok = await proposeAction(fake({ action: 'irrigate', litres: 120, reason: 'Irrigate 120 L.' }), ctx, 'en');
  assert.equal(ok.ai.usedFallback, false);
  assert.equal(ok.proposal.litres, 120);
});

// ---------------- BUG-2
function hungServer({ hangOnlyAudit = false } = {}) {
  const seen = [];
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (!hangOnlyAudit || req.url.includes('/farm/audit')) return; // never answer
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ plots: [] }));
  });
  srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const close = () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, seen, close, url: `http://127.0.0.1:${srv.address().port}/web` })));
}
function appFor(oeUrl, oeTimeoutMs) {
  const logDir = mkdtempSync(join(tmpdir(), 'mfo-fix-'));
  const config = loadConfig({ OE_MODE: 'pasoe', OE_BASE_URL: oeUrl, OE_TIMEOUT_MS: String(oeTimeoutMs), APP_TOKEN: 'fix-app-token-fixture', AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: logDir,
    DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'fix-device-token-fixture' }]) });
  return { app: buildApp({ config, oe: createOeClient(config), provider: createMockProvider() }), logDir };
}
const authz = { authorization: 'Bearer fix-app-token-fixture' };

test('BUG-2: OpenEdge never answers: 504 OE_TIMEOUT after about one timeout (not two), and no audit write is sent to the dead server', async () => {
  const s = await hungServer();
  const { app, logDir } = appFor(s.url, 400);
  const t0 = Date.now();
  const res = await app.inject({ method: 'POST', url: '/api/v1/plots/1/advise', headers: authz, payload: {} });
  const ms = Date.now() - t0;
  assert.equal(res.statusCode, 504);
  assert.equal(res.json().error, 'OE_TIMEOUT');
  assert.ok(ms >= 350 && ms < 700, `took ${ms} ms, expected about 400 ms (it was about 2x before the fix)`);
  assert.equal(s.seen.filter((x) => x.includes('/farm/audit')).length, 0, `audit calls reached the dead server: ${s.seen.join(', ')}`);
  const rec = JSON.parse(readFileSync(join(logDir, 'tool-calls.jsonl'), 'utf8').trim().split('\n').pop());
  assert.equal(rec.ok, false);
  assert.equal(rec.auditSkipped, 'openedge_unavailable'); // logged locally instead
  await app.close(); await s.close();
});
test('BUG-2: OpenEdge refuses connections: 502 OE_UNAVAILABLE straight away', async () => {
  const s = await hungServer(); const url = s.url; await s.close(); // port is now closed
  const { app } = appFor(url, 400);
  const t0 = Date.now();
  const res = await app.inject({ method: 'GET', url: '/api/v1/plots', headers: authz });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'OE_UNAVAILABLE');
  assert.ok(Date.now() - t0 < 300);
  await app.close();
});
test('BUG-2: only the audit endpoint is slow: the request waits at most AUDIT_TIMEOUT_MS extra and still succeeds', async () => {
  const s = await hungServer({ hangOnlyAudit: true });
  const { app } = appFor(s.url, 4000);
  const t0 = Date.now();
  const res = await app.inject({ method: 'GET', url: '/api/v1/plots', headers: authz });
  const ms = Date.now() - t0;
  assert.equal(res.statusCode, 200);
  assert.ok(ms >= AUDIT_TIMEOUT_MS - 100 && ms < AUDIT_TIMEOUT_MS + 700, `took ${ms} ms`);
  await app.close(); await s.close();
});

// ---------------- BUG-3
const valid = ['2026-10-23T08:20:00Z', '2024-02-29T08:20:00Z', '2000-02-29T00:00:00Z', '2026-02-28T23:59:59Z', '2026-12-31T23:59:59.999Z', '2026-04-30T08:20:00+02:00', '2026-01-31T08:20:00-05:30'];
const invalid = ['2026-02-31T08:20:00Z', '2026-02-29T08:20:00Z', '2100-02-29T08:20:00Z', '1900-02-29T08:20:00Z', '2024-02-30T08:20:00Z', '2026-04-31T08:20:00Z', '2026-06-31T08:20:00Z',
  '2026-09-31T08:20:00Z', '2026-11-31T08:20:00Z', '2026-00-10T08:20:00Z', '2026-13-10T08:20:00Z', '2026-10-00T08:20:00Z', '2026-10-32T08:20:00Z', '2026-10-23T24:00:00Z',
  '2026-10-23T08:60:00Z', '2026-10-23T08:20:60Z', '2026-10-23T08:20:00+25:00', '2026-10-23T08:20:00+02:61', '2026-10-23', 'yesterday', '', null, 20261023];
test('BUG-3: API timestamp validator accepts real dates (leap years too) and refuses impossible ones', () => {
  for (const s of valid) assert.equal(isValidIsoTimestamp(s), true, s);
  for (const s of invalid) assert.equal(isValidIsoTimestamp(s), false, String(s));
});
test('BUG-3: mock-pasoe parser (same rule as iso.i) agrees with the API validator and never rolls a date over', () => {
  for (const s of valid) assert.ok(parseIso(s), s);
  for (const s of invalid) assert.equal(parseIso(s), null, String(s));
  assert.equal(parseIso('2024-02-29T08:20:00Z').toISOString(), '2024-02-29T08:20:00.000Z');
});
test('BUG-3: over the API, 2026-02-31 is a 400 on the timestamp field and nothing is stored', async () => {
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: 'fix-app-token-fixture', AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-fix-')),
    DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'fix-device-token-fixture' }]) });
  const app = buildApp({ config, oe: createOeClient(config), provider: createMockProvider(), clock: () => new Date('2026-10-23T08:10:00Z') });
  const body = { deviceId: 'esp32-01', plotId: 1, timestamp: '2026-02-31T08:20:00Z', soilMoisturePct: 17, temperatureC: 29, humidityPct: 41 };
  const res = await app.inject({ method: 'POST', url: '/api/v1/readings', headers: { 'x-device-token': 'fix-device-token-fixture' }, payload: body });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().field, 'timestamp');
  const rd = await app.inject({ method: 'GET', url: '/api/v1/plots/1/readings?limit=500', headers: authz });
  assert.ok(rd.json().readings.every((r) => !r.readAt.startsWith('2026-03-0')));
  await app.close();
});
