// Co-op routes of the OpenEdge REST contract (docs/OE-CONTRACT.md, docs/COOP.md). Called from handler.js; returns null when the path is not a co-op route.
// Same behaviour as openedge/src/coop.i (included by farm-api.p).
import { appendAudit } from './audit-chain.js';
import { MAX_AMOUNT_RAND, MAX_KG } from './constants.js';
import { parseIso, iso } from './time.js';
import {
  checkCredit, checkAllocation, checkPayout, planFairAllocation, outstandingCents, lotAllocatedKg, contractAllocatedKg, delivered, memberShareCents,
  deductibleCents, committedGrossCents, findMember, findLot, findContract,
} from './coop-rules.js';

const err = (status, error, message, field) => ({ status, body: { error, message, ...(field ? { field } : {}) } });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const rand = (c) => c / 100;
const toCents = (x) => Math.round(x * 100);
const isMoney = (x) => isNum(x) && Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
const idOf = (s) => (/^-?\d+$/.test(s) ? parseInt(s, 10) : NaN);
const okVerdict = 'approved_by_rules';

// ---- JSON shapes
const memberJson = (s, m) => { const o = outstandingCents(s, m.memberId); return { memberId: m.memberId, memberName: m.memberName, location: m.location, preferredLang: m.preferredLang,
  creditLimit: rand(m.creditLimitCents), outstandingCredit: rand(o), availableCredit: rand(Math.max(0, m.creditLimitCents - o)) }; };
const creditJson = (c) => ({ creditId: c.creditId, memberId: c.memberId, item: c.item, amount: rand(c.amountCents), repaidAmount: rand(c.repaidCents), status: c.status,
  verdict: c.verdict, rejectReasons: c.rejectReasons, createdAt: iso(c.createdAt), decidedAt: iso(c.decidedAt), requestId: c.requestId });
function lotJson(s, l) {
  const alloc = lotAllocatedKg(s, l.lotId), d = delivered(s, l.lotId);
  return { lotId: l.lotId, lotCode: l.lotCode, crop: l.crop, quantityKg: l.quantityKg, allocatedKg: alloc, availableKg: Math.max(0, l.quantityKg - alloc), deliveredKg: d.kg, deliveredValue: rand(d.valueCents),
    contributions: l.contributions.map((c) => ({ memberId: c.memberId, kg: c.kg, share: rand(memberShareCents(s, l, c.memberId)) })) };
}
function contractJson(s, c) {
  const a = contractAllocatedKg(s, c.contractId);
  return { contractId: c.contractId, contractCode: c.contractCode, buyerName: c.buyerName, crop: c.crop, quantityKg: c.quantityKg, pricePerKg: rand(c.priceCents), status: c.status,
    allocatedKg: a, remainingKg: Math.max(0, c.quantityKg - a) };
}
const allocJson = (a) => ({ allocationId: a.allocationId, lotId: a.lotId, contractId: a.contractId, kg: a.kg, pricePerKg: rand(a.priceCents), value: rand(a.kg * a.priceCents), status: a.status,
  verdict: a.verdict, rejectReasons: a.rejectReasons, createdAt: iso(a.createdAt), decidedAt: iso(a.decidedAt), deliveredAt: iso(a.deliveredAt), requestId: a.requestId });
const payoutJson = (p) => ({ payoutId: p.payoutId, lotId: p.lotId, memberId: p.memberId, grossAmount: rand(p.grossCents), creditDeducted: rand(p.creditDeductedCents), netAmount: rand(p.grossCents - p.creditDeductedCents),
  status: p.status, verdict: p.verdict, rejectReasons: p.rejectReasons, createdAt: iso(p.createdAt), decidedAt: iso(p.decidedAt), requestId: p.requestId });

const addAudit = (store, requestId, actor, event, detail, at) => appendAudit(store, requestId, actor, event, detail, at);   // hash chain: audit-chain.js
const money = (c) => `R${(c / 100).toFixed(2)}`;
function common(body, clock) {
  const requestId = isStr(body.requestId) ? body.requestId : '';
  const actor = isStr(body.actor) ? body.actor : 'farmer';
  if (body.asOf === undefined) return { asOf: clock(), requestId, actor };
  const d = isStr(body.asOf) ? parseIso(body.asOf) : null;
  return d ? { asOf: d, requestId, actor } : { error: err(400, 'VALIDATION_ERROR', 'asOf must be ISO 8601 UTC.', 'asOf') };
}
const posInt = (v, max) => isNum(v) && Number.isInteger(v) && v >= 1 && v <= max;

export function handleCoop(store, method, segs, q, body, clock) {
  const n = segs.length, root = segs[0];
  if (!['members', 'credits', 'lots', 'contracts', 'allocations', 'payouts'].includes(root)) return null;
  const id = n >= 2 ? idOf(segs[1]) : NaN;

  if (method === 'GET') {
    const statusF = q.get('status');
    const intQ = (k) => { const v = q.get(k); return v === null ? null : idOf(v); };
    if (root === 'members' && n === 1) return { status: 200, body: { members: [...store.members].sort((a, b) => a.memberId - b.memberId).map((m) => memberJson(store, m)) } };
    if (root === 'members' && n === 2) { const m = findMember(store, id); return m ? { status: 200, body: memberJson(store, m) } : err(404, 'MEMBER_NOT_FOUND', `No member with id ${id}.`); }
    if (root === 'credits' && n === 1) {
      const mid = intQ('memberId');
      const rows = store.credits.filter((c) => (mid === null || c.memberId === mid) && (!statusF || c.status === statusF)).sort((a, b) => a.creditId - b.creditId).map(creditJson);
      return { status: 200, body: { credits: rows } };
    }
    if (root === 'credits' && n === 2) { const c = store.credits.find((x) => x.creditId === id); return c ? { status: 200, body: creditJson(c) } : err(404, 'CREDIT_NOT_FOUND', `No credit order with id ${id}.`); }
    if (root === 'lots' && n === 1) return { status: 200, body: { lots: [...store.lots].sort((a, b) => a.lotId - b.lotId).map((l) => lotJson(store, l)) } };
    if (root === 'lots' && n === 2) { const l = findLot(store, id); return l ? { status: 200, body: lotJson(store, l) } : err(404, 'LOT_NOT_FOUND', `No harvest lot with id ${id}.`); }
    if (root === 'contracts' && n === 1) return { status: 200, body: { contracts: [...store.contracts].sort((a, b) => a.contractId - b.contractId).map((c) => contractJson(store, c)) } };
    if (root === 'contracts' && n === 2) { const c = findContract(store, id); return c ? { status: 200, body: contractJson(store, c) } : err(404, 'CONTRACT_NOT_FOUND', `No contract with id ${id}.`); }
    if (root === 'allocations' && n === 1) {
      const lid = intQ('lotId'), cid = intQ('contractId');
      const rows = store.allocations.filter((a) => (lid === null || a.lotId === lid) && (cid === null || a.contractId === cid) && (!statusF || a.status === statusF)).sort((a, b) => a.allocationId - b.allocationId).map(allocJson);
      return { status: 200, body: { allocations: rows } };
    }
    if (root === 'allocations' && n === 2) { const a = store.allocations.find((x) => x.allocationId === id); return a ? { status: 200, body: allocJson(a) } : err(404, 'ALLOCATION_NOT_FOUND', `No allocation with id ${id}.`); }
    if (root === 'payouts' && n === 1) {
      const lid = intQ('lotId'), mid = intQ('memberId');
      const rows = store.payouts.filter((p) => (lid === null || p.lotId === lid) && (mid === null || p.memberId === mid) && (!statusF || p.status === statusF)).sort((a, b) => a.payoutId - b.payoutId).map(payoutJson);
      return { status: 200, body: { payouts: rows } };
    }
    if (root === 'payouts' && n === 2) { const p = store.payouts.find((x) => x.payoutId === id); return p ? { status: 200, body: payoutJson(p) } : err(404, 'PAYOUT_NOT_FOUND', `No payout with id ${id}.`); }
    return err(404, 'NOT_FOUND', 'Unknown route.');
  }

  if (method === 'POST') {
    if (root === 'credits' && n === 1) return createCredit(store, body, clock);
    if (root === 'credits' && n === 3 && segs[2] === 'decision') return decideCredit(store, id, body, clock);
    if (root === 'allocations' && n === 1) return createAllocation(store, body, clock);
    if (root === 'allocations' && n === 3 && segs[2] === 'decision') return decideAllocation(store, id, body, clock);
    if (root === 'lots' && n === 3 && segs[2] === 'fair-allocation') return fairAllocation(store, id, body, clock);
    if (root === 'payouts' && n === 1) return createPayout(store, body, clock);
    if (root === 'payouts' && n === 3 && segs[2] === 'decision') return decidePayout(store, id, body, clock);
    return err(404, 'NOT_FOUND', 'Unknown route.');
  }
  return err(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
}

// ---- credit orders
function createCredit(store, b, clock) {
  if (!posInt(b.memberId, 2147483647)) return err(400, 'VALIDATION_ERROR', 'memberId must be an integer.', 'memberId');
  if (!isNum(b.amount) || !isMoney(b.amount) || b.amount <= 0 || b.amount > MAX_AMOUNT_RAND) return err(400, 'VALIDATION_ERROR', `amount must be a positive number in Rand with at most 2 decimals (up to ${MAX_AMOUNT_RAND}).`, 'amount');
  if (b.item !== undefined && !isStr(b.item)) return err(400, 'VALIDATION_ERROR', 'item must be a string.', 'item');
  const c = common(b, clock); if (c.error) return c.error;
  if (!findMember(store, b.memberId)) return err(404, 'MEMBER_NOT_FOUND', `No member with id ${b.memberId}.`);
  const amountCents = toCents(b.amount);
  const res = checkCredit(store, { memberId: b.memberId, amountCents });
  const ok = res.verdict === okVerdict;
  const row = { creditId: ++store.seq.credit, memberId: b.memberId, item: (b.item || '').slice(0, 80), amountCents, repaidCents: 0, status: ok ? 'pending_approval' : 'rejected',
    verdict: res.verdict, rejectReasons: res.rejectReasons, createdAt: c.asOf, decidedAt: null, requestId: c.requestId };
  store.credits.push(row);
  addAudit(store, c.requestId, 'abl-rules', 'credit_rule_check', `credit ${row.creditId} member ${row.memberId} ${money(amountCents)} => ${res.verdict}`, c.asOf);
  return { status: 201, body: { ...creditJson(row), facts: res.facts } };
}
function decideCredit(store, id, b, clock) {
  if (!isStr(b.decision) || !['approve', 'reject'].includes(b.decision)) return err(400, 'VALIDATION_ERROR', 'decision must be approve or reject.', 'decision');
  const c = common(b, clock); if (c.error) return c.error;
  const row = store.credits.find((x) => x.creditId === id);
  if (!row) return err(404, 'CREDIT_NOT_FOUND', `No credit order with id ${id}.`);
  let event;
  if (b.decision === 'approve') {
    if (row.status === 'rejected') return err(409, 'NOT_APPROVABLE', 'This credit order was rejected by the rules and cannot be approved.');
    if (row.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Credit order is already ${row.status}.`);
    const res = checkCredit(store, { memberId: row.memberId, amountCents: row.amountCents, excludeCreditId: row.creditId });
    if (res.verdict !== okVerdict) {
      Object.assign(row, { status: 'rejected', verdict: res.verdict, rejectReasons: res.rejectReasons, decidedAt: c.asOf });
      addAudit(store, c.requestId, c.actor, 'credit_approve_blocked_by_rules', `credit ${id}`, c.asOf);
      return { status: 409, body: { ...creditJson(row), error: 'NOT_APPROVABLE' } };
    }
    Object.assign(row, { status: 'approved', decidedAt: c.asOf }); event = 'credit_approved';
  } else {
    if (row.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Credit order is already ${row.status}.`);
    Object.assign(row, { status: 'declined', decidedAt: c.asOf }); event = 'credit_declined';
  }
  addAudit(store, c.requestId, c.actor, event, `credit ${id}`, c.asOf);
  return { status: 200, body: creditJson(row) };
}

// ---- allocations
function insertAllocation(store, { lotId, contractId, kg }, c) {
  const res = checkAllocation(store, { lotId, contractId, kg });
  const ok = res.verdict === okVerdict;
  const con = findContract(store, contractId);
  const row = { allocationId: ++store.seq.allocation, lotId, contractId, kg, priceCents: con.priceCents, status: ok ? 'pending_approval' : 'rejected', verdict: res.verdict,
    rejectReasons: res.rejectReasons, createdAt: c.asOf, decidedAt: null, deliveredAt: null, requestId: c.requestId };
  store.allocations.push(row);
  addAudit(store, c.requestId, 'abl-rules', 'allocation_rule_check', `allocation ${row.allocationId} lot ${lotId} contract ${contractId} ${kg} kg => ${res.verdict}`, c.asOf);
  return { row, res };
}
function createAllocation(store, b, clock) {
  if (!posInt(b.lotId, 2147483647)) return err(400, 'VALIDATION_ERROR', 'lotId must be an integer.', 'lotId');
  if (!posInt(b.contractId, 2147483647)) return err(400, 'VALIDATION_ERROR', 'contractId must be an integer.', 'contractId');
  if (!posInt(b.kg, MAX_KG)) return err(400, 'VALIDATION_ERROR', `kg must be a whole number between 1 and ${MAX_KG}.`, 'kg');
  const c = common(b, clock); if (c.error) return c.error;
  if (!findLot(store, b.lotId)) return err(404, 'LOT_NOT_FOUND', `No harvest lot with id ${b.lotId}.`);
  if (!findContract(store, b.contractId)) return err(404, 'CONTRACT_NOT_FOUND', `No contract with id ${b.contractId}.`);
  const { row, res } = insertAllocation(store, b, c);
  return { status: 201, body: { ...allocJson(row), facts: res.facts } };
}
function decideAllocation(store, id, b, clock) {
  if (!isStr(b.decision) || !['approve', 'reject', 'deliver'].includes(b.decision)) return err(400, 'VALIDATION_ERROR', 'decision must be approve, reject or deliver.', 'decision');
  const c = common(b, clock); if (c.error) return c.error;
  const row = store.allocations.find((x) => x.allocationId === id);
  if (!row) return err(404, 'ALLOCATION_NOT_FOUND', `No allocation with id ${id}.`);
  let event;
  if (b.decision === 'approve') {
    if (row.status === 'rejected') return err(409, 'NOT_APPROVABLE', 'This allocation was rejected by the rules and cannot be approved.');
    if (row.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Allocation is already ${row.status}.`);
    const res = checkAllocation(store, { lotId: row.lotId, contractId: row.contractId, kg: row.kg, excludeAllocationId: row.allocationId });
    if (res.verdict !== okVerdict) {
      Object.assign(row, { status: 'rejected', verdict: res.verdict, rejectReasons: res.rejectReasons, decidedAt: c.asOf });
      addAudit(store, c.requestId, c.actor, 'allocation_approve_blocked_by_rules', `allocation ${id}`, c.asOf);
      return { status: 409, body: { ...allocJson(row), error: 'NOT_APPROVABLE' } };
    }
    Object.assign(row, { status: 'approved', decidedAt: c.asOf }); event = 'allocation_approved';
  } else if (b.decision === 'reject') {
    if (row.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Allocation is already ${row.status}.`);
    Object.assign(row, { status: 'declined', decidedAt: c.asOf }); event = 'allocation_declined';
  } else {
    if (row.status === 'delivered') return err(409, 'ALREADY_DECIDED', 'Allocation is already delivered.');
    if (row.status !== 'approved') return err(409, 'NOT_DELIVERABLE', `Only an approved allocation can be marked delivered (this one is ${row.status}).`);
    Object.assign(row, { status: 'delivered', deliveredAt: c.asOf }); event = 'allocation_delivered';
  }
  addAudit(store, c.requestId, c.actor, event, `allocation ${id}`, c.asOf);
  return { status: 200, body: allocJson(row) };
}
function fairAllocation(store, lotId, b, clock) {
  const lot = findLot(store, lotId);
  if (b.commit !== undefined && typeof b.commit !== 'boolean') return err(400, 'VALIDATION_ERROR', 'commit must be true or false.', 'commit');
  const c = common(b, clock); if (c.error) return c.error;
  if (!lot) return err(404, 'LOT_NOT_FOUND', `No harvest lot with id ${lotId}.`);
  const plan = planFairAllocation(store, lot);
  if (b.commit !== true) return { status: 200, body: { ...plan, committed: false } };
  const rows = plan.allocations.map((p) => insertAllocation(store, { lotId, contractId: p.contractId, kg: p.kg }, c).row);
  addAudit(store, c.requestId, c.actor, 'fair_allocation_committed', `lot ${lotId}: ${rows.length} allocation(s), ${plan.availableKg - plan.unallocatedKg} kg, method ${plan.method}`, c.asOf);
  return { status: 201, body: { ...plan, committed: true, created: rows.map(allocJson) } };
}

// ---- payouts
function createPayout(store, b, clock) {
  if (!posInt(b.lotId, 2147483647)) return err(400, 'VALIDATION_ERROR', 'lotId must be an integer.', 'lotId');
  if (!posInt(b.memberId, 2147483647)) return err(400, 'VALIDATION_ERROR', 'memberId must be an integer.', 'memberId');
  if (b.grossAmount !== undefined && (!isMoney(b.grossAmount) || b.grossAmount <= 0 || b.grossAmount > MAX_AMOUNT_RAND)) return err(400, 'VALIDATION_ERROR', 'grossAmount must be a positive number in Rand with at most 2 decimals.', 'grossAmount');
  if (b.creditDeducted !== undefined && (!isMoney(b.creditDeducted) || b.creditDeducted < 0 || b.creditDeducted > MAX_AMOUNT_RAND)) return err(400, 'VALIDATION_ERROR', 'creditDeducted must be zero or a positive number in Rand with at most 2 decimals.', 'creditDeducted');
  const c = common(b, clock); if (c.error) return c.error;
  const lot = findLot(store, b.lotId);
  if (!lot) return err(404, 'LOT_NOT_FOUND', `No harvest lot with id ${b.lotId}.`);
  if (!findMember(store, b.memberId)) return err(404, 'MEMBER_NOT_FOUND', `No member with id ${b.memberId}.`);
  // defaults: gross = the member's remaining share; credit deducted = min(open credit, gross)
  const remaining = Math.max(0, memberShareCents(store, lot, b.memberId) - committedGrossCents(store, b.lotId, b.memberId));
  const grossCents = b.grossAmount === undefined ? remaining : toCents(b.grossAmount);
  const creditDeductedCents = b.creditDeducted === undefined ? Math.min(deductibleCents(store, b.memberId), grossCents) : toCents(b.creditDeducted);
  const res = checkPayout(store, { lotId: b.lotId, memberId: b.memberId, grossCents, creditDeductedCents });
  const ok = res.verdict === okVerdict;
  const row = { payoutId: ++store.seq.payout, lotId: b.lotId, memberId: b.memberId, grossCents, creditDeductedCents, status: ok ? 'pending_approval' : 'rejected', verdict: res.verdict,
    rejectReasons: res.rejectReasons, createdAt: c.asOf, decidedAt: null, requestId: c.requestId };
  store.payouts.push(row);
  addAudit(store, c.requestId, 'abl-rules', 'payout_rule_check', `payout ${row.payoutId} lot ${row.lotId} member ${row.memberId} gross ${money(grossCents)} credit ${money(creditDeductedCents)} net ${money(grossCents - creditDeductedCents)} => ${res.verdict}`, c.asOf);
  return { status: 201, body: { ...payoutJson(row), facts: res.facts } };
}
function decidePayout(store, id, b, clock) {
  if (!isStr(b.decision) || !['approve', 'reject'].includes(b.decision)) return err(400, 'VALIDATION_ERROR', 'decision must be approve or reject.', 'decision');
  const c = common(b, clock); if (c.error) return c.error;
  const row = store.payouts.find((x) => x.payoutId === id);
  if (!row) return err(404, 'PAYOUT_NOT_FOUND', `No payout with id ${id}.`);
  let event;
  if (b.decision === 'approve') {
    if (row.status === 'rejected') return err(409, 'NOT_APPROVABLE', 'This payout was rejected by the rules and cannot be approved.');
    if (row.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Payout is already ${row.status}.`);
    const res = checkPayout(store, { lotId: row.lotId, memberId: row.memberId, grossCents: row.grossCents, creditDeductedCents: row.creditDeductedCents, excludePayoutId: row.payoutId });
    if (res.verdict !== okVerdict) {
      Object.assign(row, { status: 'rejected', verdict: res.verdict, rejectReasons: res.rejectReasons, decidedAt: c.asOf });
      addAudit(store, c.requestId, c.actor, 'payout_approve_blocked_by_rules', `payout ${id}`, c.asOf);
      return { status: 409, body: { ...payoutJson(row), error: 'NOT_APPROVABLE' } };
    }
    Object.assign(row, { status: 'approved', decidedAt: c.asOf }); event = 'payout_approved';
    addAudit(store, c.requestId, c.actor, event, `payout ${id}`, c.asOf);
    // repay the member's approved credit, oldest credit first
    let left = row.creditDeductedCents;
    for (const cr of store.credits.filter((x) => x.memberId === row.memberId && x.status === 'approved').sort((a, b2) => a.creditId - b2.creditId)) {
      if (left <= 0) break;
      const take = Math.min(left, cr.amountCents - cr.repaidCents);
      if (take <= 0) continue;
      cr.repaidCents += take; left -= take;
      addAudit(store, c.requestId, c.actor, 'credit_repaid_by_payout', `credit ${cr.creditId} repaid ${money(take)} by payout ${id}`, c.asOf);
    }
    return { status: 200, body: payoutJson(row) };
  }
  if (row.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Payout is already ${row.status}.`);
  Object.assign(row, { status: 'declined', decidedAt: c.asOf });
  addAudit(store, c.requestId, c.actor, 'payout_declined', `payout ${id}`, c.asOf);
  return { status: 200, body: payoutJson(row) };
}
