// Co-op rules: the same rules as openedge/src/coop.i (included by farm-api.p). See docs/COOP.md.
// Money is integer cents, quantities are whole kg. Every check returns { reasons: [{code, message, suggested*}], facts }.
// "Committed" statuses (they reserve credit or kg): credit pending_approval + approved; allocation pending_approval + approved + delivered.

export const ACTIVE_ALLOC = ['pending_approval', 'approved', 'delivered'];
const money = (cents) => `R${(cents / 100).toFixed(2)}`;
const rand = (cents) => cents / 100;
const byId = (a, b) => a.id - b.id;

// ---- pro rata with the largest-remainder method (exact integer maths). items: [{ id, weight }] (weight >= 0).
// Each item gets floor(total * weight / sumWeight); the leftover units go one each to the items with the biggest remainder
// (remainder = total * weight mod sumWeight); ties go to the lowest id. Result is a Map id -> amount, and always sums to total.
export function distribute(total, items) {
  const out = new Map();
  const list = [...items].sort(byId);
  const sumW = list.reduce((a, x) => a + BigInt(x.weight), 0n);
  const T = BigInt(total);
  if (sumW === 0n || T <= 0n) { for (const x of list) out.set(x.id, 0); return out; }
  const rows = list.map((x) => { const p = T * BigInt(x.weight); return { id: x.id, base: p / sumW, frac: p % sumW }; });
  let left = T - rows.reduce((a, r) => a + r.base, 0n);
  const order = [...rows].sort((a, b) => (a.frac === b.frac ? a.id - b.id : a.frac > b.frac ? -1 : 1));
  for (const r of order) { if (left <= 0n) break; r.base += 1n; left -= 1n; }
  for (const r of rows) out.set(r.id, Number(r.base));
  return out;
}

// ---- lookups and sums
export const findMember = (s, id) => s.members.find((m) => m.memberId === id);
export const findLot = (s, id) => s.lots.find((l) => l.lotId === id);
export const findContract = (s, id) => s.contracts.find((c) => c.contractId === id);

// credit already committed by a member: approved (not yet repaid) + pending requests
export function outstandingCents(s, memberId, excludeCreditId = 0) {
  let t = 0;
  for (const c of s.credits) {
    if (c.memberId !== memberId || c.creditId === excludeCreditId) continue;
    if (c.status === 'approved') t += c.amountCents - c.repaidCents;
    else if (c.status === 'pending_approval') t += c.amountCents;
  }
  return t;
}
// approved credit not yet repaid, minus what pending payouts already plan to deduct: what a payout may still deduct
export function deductibleCents(s, memberId, excludePayoutId = 0) {
  let t = 0;
  for (const c of s.credits) if (c.memberId === memberId && c.status === 'approved') t += c.amountCents - c.repaidCents;
  for (const p of s.payouts) if (p.memberId === memberId && p.status === 'pending_approval' && p.payoutId !== excludePayoutId) t -= p.creditDeductedCents;
  return Math.max(0, t);
}
export const lotAllocatedKg = (s, lotId, excl = 0) => s.allocations.filter((a) => a.lotId === lotId && a.allocationId !== excl && ACTIVE_ALLOC.includes(a.status)).reduce((x, a) => x + a.kg, 0);
export const contractAllocatedKg = (s, cid, excl = 0) => s.allocations.filter((a) => a.contractId === cid && a.allocationId !== excl && ACTIVE_ALLOC.includes(a.status)).reduce((x, a) => x + a.kg, 0);
export function delivered(s, lotId) {
  let kg = 0, value = 0;
  for (const a of s.allocations) if (a.lotId === lotId && a.status === 'delivered') { kg += a.kg; value += a.kg * a.priceCents; }
  return { kg, valueCents: value };
}
export function memberShareCents(s, lot, memberId) {
  const d = delivered(s, lot.lotId);
  return distribute(d.valueCents, lot.contributions.map((c) => ({ id: c.memberId, weight: c.kg }))).get(memberId) ?? 0;
}
export const committedGrossCents = (s, lotId, memberId, excl = 0) =>
  s.payouts.filter((p) => p.lotId === lotId && p.memberId === memberId && p.payoutId !== excl && ['pending_approval', 'approved'].includes(p.status)).reduce((x, p) => x + p.grossCents, 0);

// ---- rules
// CREDIT_LIMIT_EXCEEDED: requested + already committed credit must be at most the member's limit (equal is allowed).
export function checkCredit(s, { memberId, amountCents, excludeCreditId = 0 }) {
  const m = findMember(s, memberId);
  const outstanding = outstandingCents(s, memberId, excludeCreditId);
  const headroom = Math.max(0, m.creditLimitCents - outstanding);
  const facts = { memberId, memberName: m.memberName, creditLimit: rand(m.creditLimitCents), outstandingCredit: rand(outstanding), availableCredit: rand(headroom), requestedAmount: rand(amountCents) };
  const reasons = [];
  if (outstanding + amountCents > m.creditLimitCents) {
    reasons.push({ code: 'CREDIT_LIMIT_EXCEEDED', suggestedAmount: rand(headroom),
      message: `Credit of ${money(amountCents)} plus ${money(outstanding)} already committed is above the member limit of ${money(m.creditLimitCents)}. Reduce to ${money(headroom)}.` });
  }
  return { verdict: reasons.length === 0 ? 'approved_by_rules' : 'rejected_by_rules', rejectReasons: reasons, facts };
}

// CROP_MISMATCH, CONTRACT_CLOSED, LOT_EXCEEDS_CONTRACT (kg > contract remaining), LOT_STOCK_EXCEEDED (kg > lot kg not yet allocated).
export function checkAllocation(s, { lotId, contractId, kg, excludeAllocationId = 0 }) {
  const lot = findLot(s, lotId), con = findContract(s, contractId);
  const lotAlloc = lotAllocatedKg(s, lotId, excludeAllocationId), conAlloc = contractAllocatedKg(s, contractId, excludeAllocationId);
  const lotAvail = Math.max(0, lot.quantityKg - lotAlloc), conRemain = Math.max(0, con.quantityKg - conAlloc);
  const suggestedKg = Math.min(lotAvail, conRemain);
  const facts = { lotCode: lot.lotCode, contractCode: con.contractCode, crop: lot.crop, lotQuantityKg: lot.quantityKg, lotAllocatedKg: lotAlloc, lotAvailableKg: lotAvail,
    contractQuantityKg: con.quantityKg, contractAllocatedKg: conAlloc, contractRemainingKg: conRemain, requestedKg: kg };
  const reasons = [];
  if (lot.crop.toLowerCase() !== con.crop.toLowerCase()) reasons.push({ code: 'CROP_MISMATCH', message: `Lot ${lot.lotCode} is ${lot.crop} but contract ${con.contractCode} is for ${con.crop}.` });
  if (con.status !== 'open') reasons.push({ code: 'CONTRACT_CLOSED', message: `Contract ${con.contractCode} is ${con.status}.` });
  if (kg > conRemain) reasons.push({ code: 'LOT_EXCEEDS_CONTRACT', suggestedKg, message: `${kg} kg is above the ${conRemain} kg still open on contract ${con.contractCode}. Allocate ${suggestedKg} kg.` });
  if (kg > lotAvail) reasons.push({ code: 'LOT_STOCK_EXCEEDED', suggestedKg, message: `${kg} kg is above the ${lotAvail} kg of lot ${lot.lotCode} not yet allocated. Allocate ${suggestedKg} kg.` });
  return { verdict: reasons.length === 0 ? 'approved_by_rules' : 'rejected_by_rules', rejectReasons: reasons, facts };
}

// Payout rules (see docs/COOP.md section 5). Money in cents.
// MEMBER_NOT_IN_LOT, PAYOUT_NOT_DELIVERED (no delivered allocation on the lot), PAYOUT_NOTHING_DUE, PAYOUT_EXCEEDS_SHARE
// (gross > the member's pro rata share of the delivered value minus gross already committed), CREDIT_DEDUCTION_INVALID (deduction above
// the member's open credit or above gross), CREDIT_NOT_DEDUCTED (deduction below min(open credit, gross)).
export function checkPayout(s, { lotId, memberId, grossCents, creditDeductedCents, excludePayoutId = 0 }) {
  const lot = findLot(s, lotId);
  const contrib = lot.contributions.find((c) => c.memberId === memberId);
  const d = delivered(s, lotId);
  const share = contrib ? memberShareCents(s, lot, memberId) : 0;
  const committed = committedGrossCents(s, lotId, memberId, excludePayoutId);
  const remaining = Math.max(0, share - committed);
  const open = deductibleCents(s, memberId, excludePayoutId);
  const required = Math.min(open, grossCents);
  const facts = { lotCode: lot.lotCode, memberId, contributedKg: contrib ? contrib.kg : 0, deliveredKg: d.kg, deliveredValue: rand(d.valueCents), memberShare: rand(share),
    alreadyCommitted: rand(committed), remainingShare: rand(remaining), openCredit: rand(open), requestedGross: rand(grossCents), creditDeducted: rand(creditDeductedCents), net: rand(grossCents - creditDeductedCents) };
  const reasons = [];
  if (!contrib) reasons.push({ code: 'MEMBER_NOT_IN_LOT', message: `Member ${memberId} did not contribute to lot ${lot.lotCode}.` });
  if (d.kg === 0) reasons.push({ code: 'PAYOUT_NOT_DELIVERED', message: `Lot ${lot.lotCode} has no delivered allocation yet; nothing can be paid out.` });
  else if (contrib && grossCents === 0) reasons.push({ code: 'PAYOUT_NOTHING_DUE', message: `The member's share of lot ${lot.lotCode} has already been paid or is waiting for approval.` });
  if (contrib && grossCents > remaining) reasons.push({ code: 'PAYOUT_EXCEEDS_SHARE', suggestedGrossAmount: rand(remaining), message: `Gross ${money(grossCents)} is above the member's remaining share of ${money(remaining)} (share ${money(share)} of delivered value ${money(d.valueCents)}).` });
  if (creditDeductedCents > open || creditDeductedCents > grossCents) reasons.push({ code: 'CREDIT_DEDUCTION_INVALID', suggestedCreditDeducted: rand(required), message: `Credit deducted ${money(creditDeductedCents)} must not be above the open credit ${money(open)} or the gross ${money(grossCents)}. Deduct ${money(required)}.` });
  else if (creditDeductedCents < required) reasons.push({ code: 'CREDIT_NOT_DEDUCTED', suggestedCreditDeducted: rand(required), message: `The member has ${money(open)} open credit; ${money(required)} must be deducted from this payout, not ${money(creditDeductedCents)}.` });
  return { verdict: reasons.length === 0 ? 'approved_by_rules' : 'rejected_by_rules', rejectReasons: reasons, facts };
}

// Fair allocation of a lot to open contracts of the same crop.
// available = lot kg not yet allocated; each eligible contract wants its remaining kg. Enough stock: everyone gets their remaining kg (the rest is
// unallocated, e.g. for the open market). Not enough: pro rata by remaining kg, largest remainder, never above a contract's remaining kg.
export function planFairAllocation(s, lot) {
  const available = Math.max(0, lot.quantityKg - lotAllocatedKg(s, lot.lotId));
  const eligible = s.contracts.filter((c) => c.crop.toLowerCase() === lot.crop.toLowerCase() && c.status === 'open')
    .map((c) => ({ c, remaining: Math.max(0, c.quantityKg - contractAllocatedKg(s, c.contractId)) })).filter((x) => x.remaining > 0).sort((a, b) => a.c.contractId - b.c.contractId);
  const demand = eligible.reduce((a, x) => a + x.remaining, 0);
  let method = 'none', shares = new Map();
  if (available > 0 && demand > 0) {
    if (available >= demand) { method = 'full'; for (const x of eligible) shares.set(x.c.contractId, x.remaining); }
    else { method = 'pro_rata'; shares = distribute(available, eligible.map((x) => ({ id: x.c.contractId, weight: x.remaining }))); }
  }
  const allocations = eligible.filter((x) => (shares.get(x.c.contractId) ?? 0) > 0)
    .map((x) => ({ contractId: x.c.contractId, contractCode: x.c.contractCode, remainingKg: x.remaining, kg: shares.get(x.c.contractId) }));
  const planned = allocations.reduce((a, x) => a + x.kg, 0);
  return { lotId: lot.lotId, lotCode: lot.lotCode, crop: lot.crop, availableKg: available, demandKg: demand, method, allocations, unallocatedKg: available - planned };
}
