// Co-op rule unit tests (run by `npm test`, or alone: node --test eval/coop.test.mjs). Offline, no network.
// The end-to-end co-op cases (CO01 to CO76) are in eval/oe-contract-cases.json and run against mock-pasoe AND the real ABL.
// These tests cover what a JSON case cannot: rounding and tie-breaking of the pro rata maths, caps, property checks over many inputs,
// "approve re-runs the rules", and "every co-op action writes an audit row".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from '../mock-pasoe/store.js';
import { createMockServer } from '../mock-pasoe/server.js';
import { handle } from '../mock-pasoe/handler.js';
import { distribute, planFairAllocation, checkCredit, checkAllocation } from '../mock-pasoe/coop-rules.js';
import { loadCases, isCoopCase } from './compare-oe.mjs';

const T0 = '2026-10-23T08:10:00Z';
const call = (store, method, path, body = {}) => { const r = handle(store, method, path, body); return { status: r.status, body: JSON.parse(JSON.stringify(r.body)) }; };
const auditEvents = (store) => store.audit.map((a) => a.event);
const items = (...w) => w.map((weight, i) => ({ id: i + 1, weight }));
const total = (m) => [...m.values()].reduce((a, x) => a + x, 0);

// ---------------- distribute (pro rata, largest remainder)
test('pro rata: exact split needs no rounding', () => {
  assert.deepEqual([...distribute(2400, items(2000, 1000))], [[1, 1600], [2, 800]]);
});
test('pro rata: 1000 kg over demands 2000 and 1000 gives 667 + 333 (the larger remainder gets the extra kg)', () => {
  assert.deepEqual([...distribute(1000, items(2000, 1000))], [[1, 667], [2, 333]]);
});
test('pro rata: 450 kg over 500 and 300 gives 281 + 169 and always sums to the total', () => {
  const m = distribute(450, items(500, 300));
  assert.deepEqual([...m], [[1, 281], [2, 169]]);
  assert.equal(total(m), 450);
});
test('pro rata: equal remainders are broken deterministically by lowest id (10 kg over three equal weights = 4, 3, 3)', () => {
  assert.deepEqual([...distribute(10, items(1, 1, 1))], [[1, 4], [2, 3], [3, 3]]);
});
test('pro rata: input order does not matter', () => {
  const a = distribute(10, [{ id: 3, weight: 1 }, { id: 1, weight: 1 }, { id: 2, weight: 1 }]);
  assert.deepEqual([...a], [[1, 4], [2, 3], [3, 3]]);
});
test('pro rata: a zero weight gets nothing, zero total or all-zero weights give all zeros', () => {
  assert.deepEqual([...distribute(100, items(0, 50, 50))], [[1, 0], [2, 50], [3, 50]]);
  assert.deepEqual([...distribute(0, items(5, 5))], [[1, 0], [2, 0]]);
  assert.deepEqual([...distribute(7, items(0, 0))], [[1, 0], [2, 0]]);
});
test('pro rata: one kg over three contracts goes to the biggest remainder, never split', () => {
  assert.deepEqual([...distribute(1, items(5, 3, 2))], [[1, 1], [2, 0], [3, 0]]);
});
test('pro rata: money in cents (R19 600.00 over 1200/800/400 kg) is 9800.00 + 6533.33 + 3266.67', () => {
  assert.deepEqual([...distribute(1960000, items(1200, 800, 400))], [[1, 980000], [2, 653333], [3, 326667]]);
});
test('pro rata: large numbers stay exact (BigInt): 10 000 000 kg x R9 999 999.99 in cents', () => {
  const m = distribute(10_000_000 * 999_999_999, items(1, 1, 1));
  assert.equal(total(m), 10_000_000 * 999_999_999);
});
test('pro rata property: for 2 000 pseudo-random cases the parts sum to the total, none is above ceil(ideal) or below floor(ideal)', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let k = 0; k < 2000; k++) {
    const n = 1 + rnd(6);
    const w = Array.from({ length: n }, () => rnd(5000));
    const sumW = w.reduce((a, x) => a + x, 0);
    const tot = rnd(20000);
    const m = distribute(tot, w.map((weight, i) => ({ id: i + 1, weight })));
    assert.equal(total(m), sumW === 0 ? 0 : tot, `case ${k}`);
    if (sumW > 0) w.forEach((x, i) => { const ideal = (tot * x) / sumW; const got = m.get(i + 1); assert.ok(got >= Math.floor(ideal) && got <= Math.ceil(ideal), `case ${k} item ${i}`); });
  }
});

// ---------------- fair allocation plan on the seed data
test('fair allocation plan: short stock is split pro rata, enough stock fills each open contract up to its remaining kg and never above it', () => {
  const s = createStore();
  const plan = planFairAllocation(s, s.lots[0]);             // HL-0042: 2 400 kg maize; BC-0101 2 000 + BC-0102 1 000 open, BC-0104 closed
  assert.equal(plan.method, 'pro_rata');                      // 2 400 < 3 000: pro rata 1 600 / 800
  assert.deepEqual(plan.allocations.map((a) => [a.contractId, a.kg]), [[1, 1600], [2, 800]]);
  assert.equal(plan.unallocatedKg, 0);
  const big = createStore(); big.lots[0].quantityKg = 5000; big.lots[0].contributions = [{ memberId: 1, kg: 5000 }];
  const full = planFairAllocation(big, big.lots[0]);
  assert.equal(full.method, 'full');
  assert.deepEqual(full.allocations.map((a) => [a.contractId, a.kg]), [[1, 2000], [2, 1000]]);   // never above the contract quantity
  assert.equal(full.unallocatedKg, 2000);
});
test('fair allocation plan: ignores closed contracts and other crops, and a lot with no stock gets an empty plan', () => {
  const s = createStore();
  const beans = planFairAllocation(s, s.lots[2]);
  assert.deepEqual(beans.allocations.map((a) => a.contractId), [3, 5]);
  s.allocations.push({ allocationId: 99, lotId: 3, contractId: 3, kg: 450, priceCents: 2200, status: 'approved', verdict: 'approved_by_rules', rejectReasons: [] });
  const empty = planFairAllocation(s, s.lots[2]);
  assert.equal(empty.method, 'none'); assert.deepEqual(empty.allocations, []); assert.equal(empty.availableKg, 0);
});
test('fair allocation plan does not change any data and writes no audit row; commit writes them', () => {
  const s = createStore();
  call(s, 'POST', '/farm/lots/3/fair-allocation', {});
  assert.equal(s.allocations.length, 0); assert.equal(s.audit.length, 0);
  const r = call(s, 'POST', '/farm/lots/3/fair-allocation', { commit: true, requestId: 'u1', asOf: T0 });
  assert.equal(r.status, 201); assert.equal(s.allocations.length, 2);
  assert.deepEqual(auditEvents(s), ['allocation_rule_check', 'allocation_rule_check', 'fair_allocation_committed']);
});
test('committed pro rata allocations never exceed any contract remaining kg or the lot, whatever the lot size (1 to 900 kg)', () => {
  for (let kg = 1; kg <= 900; kg += 7) {
    const s = createStore(); s.lots[2].quantityKg = kg; s.lots[2].contributions = [{ memberId: 2, kg }];
    const r = call(s, 'POST', '/farm/lots/3/fair-allocation', { commit: true, asOf: T0 });
    assert.equal(r.status, 201);
    assert.ok(r.body.created.every((a) => a.status === 'pending_approval'), `lot ${kg} kg: the rules accept every planned allocation`);
    const placed = r.body.created.reduce((a, x) => a + x.kg, 0);
    assert.equal(placed, Math.min(kg, 800), `lot ${kg} kg`);
  }
});

// ---------------- rule boundaries and approval re-check
test('credit rule: exactly the limit passes, one cent more fails with the exact headroom as the suggestion', () => {
  const s = createStore();
  assert.equal(checkCredit(s, { memberId: 1, amountCents: 115000 }).verdict, 'approved_by_rules');
  const over = checkCredit(s, { memberId: 1, amountCents: 115001 });
  assert.equal(over.verdict, 'rejected_by_rules');
  assert.equal(over.rejectReasons[0].code, 'CREDIT_LIMIT_EXCEEDED');
  assert.equal(over.rejectReasons[0].suggestedAmount, 1150);
});
test('allocation rule: exactly the remaining kg passes, one more fails; all failing reasons are reported', () => {
  const s = createStore();
  assert.equal(checkAllocation(s, { lotId: 1, contractId: 1, kg: 2000 }).verdict, 'approved_by_rules');
  assert.deepEqual(checkAllocation(s, { lotId: 1, contractId: 1, kg: 2001 }).rejectReasons.map((r) => r.code), ['LOT_EXCEEDS_CONTRACT']);
  assert.deepEqual(checkAllocation(s, { lotId: 3, contractId: 4, kg: 5000 }).rejectReasons.map((r) => r.code), ['CROP_MISMATCH', 'CONTRACT_CLOSED', 'LOT_EXCEEDS_CONTRACT', 'LOT_STOCK_EXCEEDED']);
});
test('approve re-runs the credit rule: if the member limit was lowered meanwhile, approval is blocked (409), the order becomes rejected and the block is audited', () => {
  const s = createStore();
  const c = call(s, 'POST', '/farm/credits', { memberId: 1, amount: 1000, asOf: T0 });
  assert.equal(c.body.status, 'pending_approval');
  s.members[0].creditLimitCents = 400000;                    // limit lowered to R4 000; R3 850 already committed
  const d = call(s, 'POST', `/farm/credits/${c.body.creditId}/decision`, { decision: 'approve', asOf: T0 });
  assert.equal(d.status, 409); assert.equal(d.body.error, 'NOT_APPROVABLE'); assert.equal(d.body.status, 'rejected');
  assert.equal(d.body.rejectReasons[0].suggestedAmount, 150);
  assert.ok(auditEvents(s).includes('credit_approve_blocked_by_rules'));
});
test('approve re-runs the allocation rule: if the contract was reduced meanwhile, approval is blocked and audited', () => {
  const s = createStore();
  const a = call(s, 'POST', '/farm/allocations', { lotId: 1, contractId: 1, kg: 2000, asOf: T0 });
  s.contracts[0].quantityKg = 1500;
  const d = call(s, 'POST', `/farm/allocations/${a.body.allocationId}/decision`, { decision: 'approve', asOf: T0 });
  assert.equal(d.status, 409); assert.equal(d.body.rejectReasons[0].code, 'LOT_EXCEEDS_CONTRACT'); assert.equal(d.body.rejectReasons[0].suggestedKg, 1500);
  assert.ok(auditEvents(s).includes('allocation_approve_blocked_by_rules'));
});
test('approve re-runs the payout rule: a payout approved after the allocation was removed from delivered is blocked', () => {
  const s = createStore();
  const a = call(s, 'POST', '/farm/allocations', { lotId: 1, contractId: 1, kg: 2000, asOf: T0 });
  call(s, 'POST', `/farm/allocations/${a.body.allocationId}/decision`, { decision: 'approve', asOf: T0 });
  call(s, 'POST', `/farm/allocations/${a.body.allocationId}/decision`, { decision: 'deliver', asOf: T0 });
  const p = call(s, 'POST', '/farm/payouts', { lotId: 1, memberId: 2, asOf: T0 });
  assert.equal(p.body.status, 'pending_approval');
  s.allocations[0].status = 'cancelled_for_test';
  const d = call(s, 'POST', `/farm/payouts/${p.body.payoutId}/decision`, { decision: 'approve', asOf: T0 });
  assert.equal(d.status, 409); assert.equal(d.body.rejectReasons[0].code, 'PAYOUT_NOT_DELIVERED');
  assert.ok(auditEvents(s).includes('payout_approve_blocked_by_rules'));
});

// ---------------- payout money rules
test('payouts: the sum of the member shares of a lot equals the delivered value to the cent', () => {
  const s = createStore();
  const a = call(s, 'POST', '/farm/allocations', { lotId: 1, contractId: 1, kg: 777, asOf: T0 });          // 777 kg x R9.80 = R7 614.60
  call(s, 'POST', `/farm/allocations/${a.body.allocationId}/decision`, { decision: 'approve', asOf: T0 });
  call(s, 'POST', `/farm/allocations/${a.body.allocationId}/decision`, { decision: 'deliver', asOf: T0 });
  const lot = call(s, 'GET', '/farm/lots/1').body;
  assert.equal(lot.deliveredValue, 7614.6);
  const sumCents = lot.contributions.reduce((x, c) => x + Math.round(c.share * 100), 0);
  assert.equal(sumCents, 761460);
});
test('payouts: gross + credit rules together: gross never above the share, net = gross - credit, credit repaid exactly once', () => {
  const s = createStore();
  const a = call(s, 'POST', '/farm/allocations', { lotId: 1, contractId: 1, kg: 2000, asOf: T0 });
  call(s, 'POST', `/farm/allocations/${a.body.allocationId}/decision`, { decision: 'approve', asOf: T0 });
  call(s, 'POST', `/farm/allocations/${a.body.allocationId}/decision`, { decision: 'deliver', asOf: T0 });
  const p1 = call(s, 'POST', '/farm/payouts', { lotId: 1, memberId: 1, grossAmount: 5000, asOf: T0 });     // half the share; credit R3 850 deducted
  assert.equal(p1.body.status, 'pending_approval'); assert.equal(p1.body.creditDeducted, 3850); assert.equal(p1.body.netAmount, 1150);
  const p2 = call(s, 'POST', '/farm/payouts', { lotId: 1, memberId: 1, asOf: T0 });                         // the rest: R4 800, no credit left to deduct
  assert.equal(p2.body.grossAmount, 4800); assert.equal(p2.body.creditDeducted, 0); assert.equal(p2.body.netAmount, 4800);
  call(s, 'POST', `/farm/payouts/${p1.body.payoutId}/decision`, { decision: 'approve', asOf: T0 });
  call(s, 'POST', `/farm/payouts/${p2.body.payoutId}/decision`, { decision: 'approve', asOf: T0 });
  const m = call(s, 'GET', '/farm/members/1').body;
  assert.equal(m.outstandingCredit, 0);
  const repaid = s.credits.filter((c) => c.memberId === 1).reduce((x, c) => x + c.repaidCents, 0);
  assert.equal(repaid, 385000);
  const p3 = call(s, 'POST', '/farm/payouts', { lotId: 1, memberId: 1, grossAmount: 0.01, asOf: T0 });
  assert.equal(p3.body.rejectReasons[0].code, 'PAYOUT_EXCEEDS_SHARE');
});
test('payouts: two pending payouts cannot both deduct the same credit', () => {
  const s = createStore();
  const a = call(s, 'POST', '/farm/allocations', { lotId: 1, contractId: 1, kg: 2000, asOf: T0 });
  call(s, 'POST', `/farm/allocations/${a.body.allocationId}/decision`, { decision: 'approve', asOf: T0 });
  call(s, 'POST', `/farm/allocations/${a.body.allocationId}/decision`, { decision: 'deliver', asOf: T0 });
  const p1 = call(s, 'POST', '/farm/payouts', { lotId: 1, memberId: 1, grossAmount: 1000, asOf: T0 });
  const p2 = call(s, 'POST', '/farm/payouts', { lotId: 1, memberId: 1, grossAmount: 1000, creditDeducted: 1000, asOf: T0 });
  assert.equal(p1.body.creditDeducted, 1000);
  assert.equal(p2.body.status, 'pending_approval');          // 1000 + 1000 of the 3850 open credit: still fine
  const p3 = call(s, 'POST', '/farm/payouts', { lotId: 1, memberId: 1, grossAmount: 5000, creditDeducted: 3000, asOf: T0 });
  assert.equal(p3.body.rejectReasons[0].code, 'CREDIT_DEDUCTION_INVALID');   // only 1 850 is still free to deduct
  assert.equal(p3.body.rejectReasons[0].suggestedCreditDeducted, 1850);
});

// ---------------- audit: every co-op action writes a row
test('every co-op write action writes at least one AuditLog row (credit, allocation, payout, plan commit)', () => {
  const s = createStore();
  const steps = [
    () => call(s, 'POST', '/farm/credits', { memberId: 1, amount: 100, asOf: T0 }),
    () => call(s, 'POST', '/farm/credits/4/decision', { decision: 'approve', asOf: T0 }),
    () => call(s, 'POST', '/farm/credits', { memberId: 1, amount: 99999, asOf: T0 }),
    () => call(s, 'POST', '/farm/credits/5/decision', { decision: 'approve', asOf: T0 }),   // 409 NOT_APPROVABLE: no change, no row needed
    () => call(s, 'POST', '/farm/credits', { memberId: 2, amount: 100, asOf: T0 }),
    () => call(s, 'POST', '/farm/credits/6/decision', { decision: 'reject', asOf: T0 }),
    () => call(s, 'POST', '/farm/allocations', { lotId: 1, contractId: 1, kg: 10, asOf: T0 }),
    () => call(s, 'POST', '/farm/allocations/1/decision', { decision: 'approve', asOf: T0 }),
    () => call(s, 'POST', '/farm/allocations/1/decision', { decision: 'deliver', asOf: T0 }),
    () => call(s, 'POST', '/farm/allocations', { lotId: 1, contractId: 2, kg: 10, asOf: T0 }),
    () => call(s, 'POST', '/farm/allocations/2/decision', { decision: 'reject', asOf: T0 }),
    () => call(s, 'POST', '/farm/payouts', { lotId: 1, memberId: 1, asOf: T0 }),
    () => call(s, 'POST', '/farm/payouts/1/decision', { decision: 'approve', asOf: T0 }),
    () => call(s, 'POST', '/farm/payouts', { lotId: 1, memberId: 2, asOf: T0 }),
    () => call(s, 'POST', '/farm/payouts/2/decision', { decision: 'reject', asOf: T0 }),
    () => call(s, 'POST', '/farm/lots/3/fair-allocation', { commit: true, asOf: T0 }),
  ];
  let prev = 0; const wrote = [];
  for (const [i, fn] of steps.entries()) { const r = fn(); wrote.push([i, r.status, s.audit.length - prev]); prev = s.audit.length; }
  for (const [i, status, rows] of wrote) {
    if (status >= 400) assert.equal(rows, 0, `step ${i}: a refused request changes nothing`);
    else assert.ok(rows >= 1, `step ${i} (status ${status}) wrote ${rows} audit rows`);
  }
  const ev = new Set(auditEvents(s));
  for (const e of ['credit_rule_check', 'credit_approved', 'credit_declined', 'allocation_rule_check', 'allocation_approved', 'allocation_delivered', 'allocation_declined', 'payout_rule_check', 'payout_approved', 'payout_declined', 'fair_allocation_committed']) assert.ok(ev.has(e), `missing audit event ${e}`);
});
test('audit rows are append-only in the co-op code: ids only grow and old rows are never changed', () => {
  const s = createStore();
  call(s, 'POST', '/farm/credits', { memberId: 1, amount: 100, asOf: T0 });
  const first = JSON.stringify(s.audit[0]);
  call(s, 'POST', '/farm/credits/4/decision', { decision: 'approve', asOf: T0 });
  assert.equal(JSON.stringify(s.audit[0]), first);
  assert.deepEqual(s.audit.map((a) => a.auditId), [1, 2]);
});

// ---------------- ABL source and the OpenEdge compare harness (no OpenEdge required)
const readRepo = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const compareScript = fileURLToPath(new URL('./compare-oe.mjs', import.meta.url));

function writeResults(cases, file) {
  const store = createStore();
  const results = [];
  for (const c of cases) {
    const r = handle(store, c.request.method, c.request.path, c.request.body ?? {});
    results.push({ id: c.id, status: r.status, body: JSON.parse(JSON.stringify(r.body)) });
  }
  writeFileSync(file, JSON.stringify({ target: 'mock', results }));
  return file;
}

test('ABL co-op source has the rule codes, audit events, routes, limits and OpenEdge run steps', () => {
  const api = readRepo('../openedge/src/farm-api.p');
  const coop = readRepo('../openedge/src/coop.i');
  const seed = readRepo('../openedge/src/seed.p');
  const run = readRepo('../openedge/src/run-contract.p');
  const ps1 = readRepo('../scripts/oe-run.ps1');
  const handlers = readRepo('../openedge/pasoe/ROOT.handlers');
  const doc = readRepo('../docs/COOP.md');
  for (const code of ['CREDIT_LIMIT_EXCEEDED', 'CROP_MISMATCH', 'CONTRACT_CLOSED', 'LOT_EXCEEDS_CONTRACT', 'LOT_STOCK_EXCEEDED', 'MEMBER_NOT_IN_LOT', 'PAYOUT_NOT_DELIVERED', 'PAYOUT_NOTHING_DUE', 'PAYOUT_EXCEEDS_SHARE', 'CREDIT_DEDUCTION_INVALID', 'CREDIT_NOT_DEDUCTED']) {
    assert.ok(coop.includes(`"${code}"`), code);
  }
  for (const ev of ['credit_rule_check', 'credit_approved', 'credit_declined', 'credit_approve_blocked_by_rules', 'allocation_rule_check', 'allocation_approved', 'allocation_delivered', 'allocation_declined', 'allocation_approve_blocked_by_rules', 'payout_rule_check', 'payout_approved', 'payout_declined', 'payout_approve_blocked_by_rules', 'credit_repaid_by_payout', 'fair_allocation_committed']) {
    assert.ok(coop.includes(`"${ev}"`), ev);
  }
  assert.match(api, /&SCOPED-DEFINE MAX_AMOUNT_RAND 10000000/);
  assert.match(api, /&SCOPED-DEFINE MAX_KG 10000000/);
  assert.match(api, /\{coop\.i\}/);
  assert.equal(coop.includes('&1'), false);
  assert.match(coop, /FUNCTION fPlain/);
  assert.doesNotMatch(coop, /STRING\(piKg\)|STRING\(iNew\)|STRING\(iWhole\)/);
  for (const route of ['h-coop-credit-create', 'h-coop-credit-decide', 'h-coop-alloc-create', 'h-coop-alloc-decide', 'h-coop-fair', 'h-coop-payout-create', 'h-coop-payout-decide']) {
    assert.ok(api.includes(`RUN ${route}`), route);
  }
  assert.match(seed, /coop-seed\.json/);
  assert.match(seed, /CURRENT-VALUE\(MemberSeq\) = 0/);
  assert.match(seed, /CURRENT-VALUE\(CreditSeq\) = 0/);
  assert.match(run, /cPrefix/);
  for (const action of ['load-coop', 'test-coop', 'test-http', 'test-http-coop', '003-coop.df']) assert.ok(ps1.includes(action), action);
  assert.ok(handlers.includes('/farm/{*}'));
  assert.ok(handlers.includes('web.FarmHandler'));
  assert.match(doc, /^## 5\. Payout rules/m);
  assert.equal(loadCases().filter(isCoopCase).length, 76);
});

test('compare-oe batch mode agrees with mock-pasoe for the full file and for CO01-CO76 only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coop-cmp-'));
  const all = loadCases();
  const full = writeResults(all, join(dir, 'full.json'));
  const coopOnly = writeResults(all.filter(isCoopCase), join(dir, 'coop.json'));
  const fullRun = spawnSync(process.execPath, [compareScript, full], { encoding: 'utf8' });
  assert.equal(fullRun.status, 0, fullRun.stdout + fullRun.stderr);
  assert.match(fullRun.stdout, /co-op cases CO01-CO76: 76 passed, 0 failed/);
  const coopRun = spawnSync(process.execPath, [compareScript, coopOnly, '--coop'], { encoding: 'utf8' });
  assert.equal(coopRun.status, 0, coopRun.stdout + coopRun.stderr);
  assert.match(coopRun.stdout, /76 passed, 0 failed/);
});

test('compare-oe exits 1 when a co-op result is wrong and exits 2 with no arguments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coop-bad-'));
  const file = writeResults(loadCases().filter(isCoopCase), join(dir, 'coop.json'));
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  parsed.results[0].status = 500;
  writeFileSync(file, JSON.stringify(parsed));
  const bad = spawnSync(process.execPath, [compareScript, file, '--coop'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL\s+CO01/);
  const usage = spawnSync(process.execPath, [compareScript], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});

function runCompare(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [compareScript, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withFreshMock(fn) {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/web`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('compare-oe --http matches mock-pasoe for every contract case and for --coop alone', async () => {
  // The child must run while this process can still serve HTTP, so this is spawn, not spawnSync.
  await withFreshMock(async (base) => {
    const coop = await runCompare(['--http', base, '--coop']);
    assert.equal(coop.status, 0, coop.stdout + coop.stderr);
    assert.match(coop.stdout, /76 passed, 0 failed/);
  });
  await withFreshMock(async (base) => {
    const full = await runCompare(['--http', base]);
    assert.equal(full.status, 0, full.stdout + full.stderr);
    assert.match(full.stdout, /co-op cases CO01-CO76: 76 passed, 0 failed/);
  });
});
