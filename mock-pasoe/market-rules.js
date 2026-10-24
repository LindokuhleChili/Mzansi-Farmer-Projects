// Harvest-day market rules: the same rules as openedge/src/market.i (included by farm-api.p). See docs/MARKET.md.
// Money is integer cents, quantities are whole kg. Every check returns { verdict, rejectReasons: [{ code, message, item?, suggested* }] }.
// "Active" events (their items hold lot kg): pending_approval and published.
import { RESERVE_CAP_KG, RESERVE_SHARE_PCT } from './constants.js';
import { lotAllocatedKg } from './coop-rules.js';

export const ACTIVE_EVENT = ['pending_approval', 'published'];
const money = (cents) => `R${(cents / 100).toFixed(2)}`;
const verdictOf = (reasons) => (reasons.length === 0 ? 'approved_by_rules' : 'rejected_by_rules');

export const findEvent = (s, id) => s.marketEvents.find((e) => e.eventId === id);
export const findItem = (s, id) => s.marketItems.find((i) => i.itemId === id);
export const eventItems = (s, eventId) => s.marketItems.filter((i) => i.eventId === eventId).sort((a, b) => a.itemOrder - b.itemOrder || a.itemId - b.itemId);
export const retailPrice = (s, crop) => s.retailPrices.find((p) => p.crop === crop) || null;
export const reservedKg = (s, itemId, excl = 0) => s.reservations.filter((r) => r.itemId === itemId && r.status === 'confirmed' && r.reservationId !== excl).reduce((a, r) => a + r.quantityKg, 0);
export const reserveLimitKg = (qty) => Math.trunc((qty * RESERVE_SHARE_PCT) / 100);
export const reservableKg = (s, item) => Math.max(0, reserveLimitKg(item.quantityKg) - reservedKg(s, item.itemId));

// kg of a harvest lot already listed on active market events (other than excludeEventId)
export function lotListedKg(s, lotId, excludeEventId = 0) {
  let t = 0;
  for (const it of s.marketItems) {
    if (it.lotId !== lotId || it.eventId === excludeEventId) continue;
    const ev = findEvent(s, it.eventId);
    if (ev && ACTIVE_EVENT.includes(ev.status)) t += it.quantityKg;
  }
  return t;
}
// what a market event may still list from a lot: lot kg - kg allocated to buyer contracts - kg already listed on other active events
export const lotMarketAvailableKg = (s, lot, excludeEventId = 0) => Math.max(0, lot.quantityKg - lotAllocatedKg(s, lot.lotId) - lotListedKg(s, lot.lotId, excludeEventId));

/** ev: { startsAt: Date, items: [{ crop, quantityKg, priceCents, lotId }] }, asOf: Date, excludeEventId: the event being edited or approved */
export function checkEvent(s, ev, asOf, excludeEventId = 0) {
  const reasons = [];
  if (ev.startsAt.getTime() <= asOf.getTime()) {
    reasons.push({ code: 'EVENT_NOT_IN_FUTURE', message: 'The harvest day must start after now. Pick a later date.' });
  }
  const usedFromLot = new Map();   // lot kg taken by earlier items of this same event
  ev.items.forEach((it, i) => {
    const n = i + 1;
    const ref = retailPrice(s, it.crop);
    if (!ref) reasons.push({ code: 'NO_REFERENCE_PRICE', message: `Item ${n}: there is no retail-buyer reference price for ${it.crop}, so the price cannot be checked.`, item: n });
    else if (it.priceCents >= ref.priceCents) {
      reasons.push({ code: 'PRICE_NOT_BELOW_RETAIL', message: `Item ${n}: ${money(it.priceCents)} per kg is not below the retail-buyer price of ${money(ref.priceCents)} per kg for ${it.crop}. Use ${money(ref.priceCents - 1)} or less.`,
        item: n, suggestedPricePerKg: (ref.priceCents - 1) / 100 });
    }
    if (it.lotId) {
      const lot = s.lots.find((l) => l.lotId === it.lotId);
      if (lot.crop !== it.crop) reasons.push({ code: 'LOT_CROP_MISMATCH', message: `Item ${n}: harvest lot ${lot.lotCode} is ${lot.crop}, not ${it.crop}.`, item: n });
      else {
        const avail = Math.max(0, lotMarketAvailableKg(s, lot, excludeEventId) - (usedFromLot.get(lot.lotId) || 0));
        if (it.quantityKg > avail) {
          reasons.push({ code: 'LOT_STOCK_EXCEEDED', message: `Item ${n}: ${it.quantityKg} kg is more than the ${avail} kg of harvest lot ${lot.lotCode} that is not allocated or listed. Reduce to ${avail} kg.`,
            item: n, suggestedKg: avail });
        }
        usedFromLot.set(lot.lotId, (usedFromLot.get(lot.lotId) || 0) + it.quantityKg);
      }
    }
  });
  return { verdict: verdictOf(reasons), rejectReasons: reasons };
}

/** r: { itemId, quantityKg }, asOf: Date */
export function checkReservation(s, r, asOf) {
  const reasons = [];
  const item = findItem(s, r.itemId), ev = findEvent(s, item.eventId);
  if (ev.status !== 'published') reasons.push({ code: 'EVENT_NOT_OPEN', message: `This harvest day is ${ev.status}, not published, so it cannot take reservations.` });
  else if (asOf.getTime() >= ev.startsAt.getTime()) reasons.push({ code: 'RESERVATIONS_CLOSED', message: 'Reservations close when the harvest day starts. Walk up on the day instead.' });
  const left = reservableKg(s, item);
  if (r.quantityKg > RESERVE_CAP_KG) {
    reasons.push({ code: 'RESERVE_CAP_EXCEEDED', message: `One reservation can hold at most ${RESERVE_CAP_KG} kg. Reduce to ${Math.min(RESERVE_CAP_KG, left)} kg.`, suggestedKg: Math.min(RESERVE_CAP_KG, left) });
  } else if (r.quantityKg > left) {
    reasons.push({ code: 'RESERVE_STOCK_EXCEEDED', message: `Only ${left} kg of ${item.itemLabel} can still be reserved. The rest is kept for walk-up buyers.`, suggestedKg: left });
  }
  return { verdict: verdictOf(reasons), rejectReasons: reasons };
}
