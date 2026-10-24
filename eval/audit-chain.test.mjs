// Audit hash chain (feature 21) on mock-pasoe and through the API. The same checks run on real ABL in
// openedge/src/audit-tamper-test.p (oe-run.ps1 -Action scratch-test, scratch database only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../mock-pasoe/store.js';
import { handle } from '../mock-pasoe/handler.js';
import { sha256Hex, auditHash, verifyAudit } from '../mock-pasoe/audit-chain.js';

const post = (s, event, detail) => handle(s, 'POST', '/farm/audit', { requestId: 'r', actor: 'api', event, detail });
const verify = (s) => handle(s, 'GET', '/farm/audit/verify', {}).body;

test('chain: parity constant shared with ABL (audit-tamper-test.p AUD-T1)', () => {
  assert.equal(sha256Hex('|1|2026-10-24T19:00:00.000Z|req_x|api|tool_call|{"a":1}'), 'aeb50db958b482f63c424fc2823bcb07b867309f206ecf17e251ce2505923eb2');
});
test('chain: each row links to the previous one and the list shows both hashes', () => {
  const s = createStore();
  for (let i = 0; i < 5; i++) post(s, 'tool_call', { i });
  const rows = handle(s, 'GET', '/farm/audit?limit=5', {}).body.events.reverse();
  assert.equal(rows[0].prevHash, '');
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prevHash, rows[i - 1].rowHash);
  assert.deepEqual({ ok: verify(s).ok, checked: verify(s).checked }, { ok: true, checked: 5 });
  assert.equal(verify(s).headHash, rows[4].rowHash);
});
test('chain: editing a detail, actor, event or time is caught at that row (ROW_HASH_MISMATCH)', () => {
  for (const field of ['detail', 'actor', 'event', 'at']) {
    const s = createStore();
    for (let i = 0; i < 4; i++) post(s, 'tool_call', { i });
    const r = s.audit[2];
    if (field === 'at') r.at = new Date(r.at.getTime() + 1000); else r[field] = r[field] + 'x';
    assert.deepEqual([verify(s).ok, verify(s).firstBadId, verify(s).reason], [false, r.auditId, 'ROW_HASH_MISMATCH'], field);
  }
});
test('chain: re-hashing an edited row still breaks the link to the next row (PREV_HASH_MISMATCH); deleting a row too', () => {
  const s = createStore();
  for (let i = 0; i < 4; i++) post(s, 'tool_call', { i });
  const r = s.audit[1]; r.detail = 'forged'; r.rowHash = auditHash(r.prevHash, r);
  assert.deepEqual([verify(s).firstBadId, verify(s).reason], [s.audit[2].auditId, 'PREV_HASH_MISMATCH']);
  const s2 = createStore();
  for (let i = 0; i < 4; i++) post(s2, 'tool_call', { i });
  s2.audit.splice(1, 1);
  assert.equal(verify(s2).reason, 'PREV_HASH_MISMATCH');
});
test('chain: rows written before the chain (empty hash) are counted as legacy, the chain starts after them', () => {
  const s = createStore();
  s.audit.push({ auditId: ++s.seq.audit, at: new Date(), requestId: '', actor: 'api', event: 'old', detail: '' });
  post(s, 'tool_call', {}); post(s, 'tool_call', {});
  assert.deepEqual([verify(s).ok, verify(s).legacy, verify(s).checked], [true, 1, 2]);
  assert.equal(verifyAudit(createStore()).ok, true);
});
test('API: GET /api/v1/audit/verify passes the chain result through (token required)', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { loadConfig } = await import('../apps/api/src/config.js'); const { createOeClient } = await import('../apps/api/src/oe/client.js');
  const { createMockProvider } = await import('../apps/api/src/ai/provider.js'); const { buildApp } = await import('../apps/api/src/app.js');
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: 'audit-app-token-fixture-1', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-au-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'd', plotId: 1, token: 'audit-device-token-fixture' }]) });
  const app = buildApp({ config, oe: createOeClient(config), provider: createMockProvider() });
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/audit/verify' })).statusCode, 401);
  await app.inject({ method: 'GET', url: '/api/v1/plots', headers: { authorization: 'Bearer audit-app-token-fixture-1' } });   // writes a tool_call audit row
  const r = await app.inject({ method: 'GET', url: '/api/v1/audit/verify', headers: { authorization: 'Bearer audit-app-token-fixture-1' } });
  assert.equal(r.statusCode, 200); assert.equal(r.json().ok, true); assert.ok(r.json().checked >= 1); assert.match(r.json().headHash, /^[0-9a-f]{64}$/);
});
