// Harvest-day market routes of the OpenEdge REST contract (docs/OE-CONTRACT.md, docs/MARKET.md). Called from handler.js for paths that start
// with /market; returns null otherwise. Same behaviour as openedge/src/market.i (included by farm-api.p).
import { appendAudit } from './audit-chain.js';
import { MAX_AMOUNT_RAND, MAX_KG, MARKET_MAX_ITEMS } from './constants.js';
import { parseIso, iso } from './time.js';
import { checkEvent, checkReservation, findEvent, findItem, eventItems, retailPrice, reservedKg, reservableKg, ACTIVE_EVENT } from './market-rules.js';

const err = (status, error, message, field) => ({ status, body: { error, message, ...(field ? { field } : {}) } });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toCents = (x) => Math.round(x * 100);
const isMoney = (x) => isNum(x) && Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
const posInt = (v, max) => isNum(v) && Number.isInteger(v) && v >= 1 && v <= max;
const idOf = (s) => (/^-?\d+$/.test(s) ? parseInt(s, 10) : NaN);
const okVerdict = 'approved_by_rules';
const strOk = (v, min, max) => isStr(v) && v.length >= min && v.length <= max;

// ---- JSON shapes
function itemJson(s, it) {
  const ref = retailPrice(s, it.crop), res = reservedKg(s, it.itemId);
  return { itemId: it.itemId, crop: it.crop, label: it.itemLabel, quantityKg: it.quantityKg, pricePerKg: it.priceCents / 100,
    retailBuyerPricePerKg: ref ? ref.priceCents / 100 : null, lotId: it.lotId || null, reservedKg: res, reservableKg: reservableKg(s, it), walkUpKg: it.quantityKg - res };
}
function eventJson(s, e) {
  const items = eventItems(s, e.eventId).map((it) => itemJson(s, it));
  return { eventId: e.eventId, farmId: e.farmId, eventName: e.eventName, venue: e.venue, area: e.area, notes: e.notes, startsAt: iso(e.startsAt), endsAt: iso(e.endsAt),
    status: e.status, verdict: e.verdict, rejectReasons: e.rejectReasons, createdAt: iso(e.createdAt), decidedAt: iso(e.decidedAt), requestId: e.requestId,
    items, totalKg: items.reduce((a, x) => a + x.quantityKg, 0), reservedKg: items.reduce((a, x) => a + x.reservedKg, 0) };
}
const resJson = (r) => ({ reservationId: r.reservationId, eventId: r.eventId, itemId: r.itemId, buyerName: r.buyerName, quantityKg: r.quantityKg, status: r.status,
  verdict: r.verdict, rejectReasons: r.rejectReasons, createdAt: iso(r.createdAt), decidedAt: iso(r.decidedAt), requestId: r.requestId });

const addAudit = (store, requestId, actor, event, detail, at) => appendAudit(store, requestId, actor, event, detail, at);   // hash chain: audit-chain.js
function common(body, clock) {
  const requestId = isStr(body.requestId) ? body.requestId : '';
  const actor = isStr(body.actor) ? body.actor : 'farmer';
  if (body.asOf === undefined) return { asOf: clock(), requestId, actor };
  const d = isStr(body.asOf) ? parseIso(body.asOf) : null;
  return d ? { asOf: d, requestId, actor } : { error: err(400, 'VALIDATION_ERROR', 'asOf must be ISO 8601 UTC.', 'asOf') };
}

export function handleMarket(store, method, segs, q, body, clock) {
  if (segs[0] !== 'market') return null;
  const n = segs.length, root = segs[1];
  const id = n >= 3 ? idOf(segs[2]) : NaN;
  if (method === 'GET') {
    const intQ = (k) => { const v = q.get(k); return v === null ? null : idOf(v); };
    if (root === 'prices' && n === 2) {
      return { status: 200, body: { prices: [...store.retailPrices].sort((a, b) => (a.crop < b.crop ? -1 : a.crop > b.crop ? 1 : 0)).map((p) => ({ crop: p.crop, retailBuyerPricePerKg: p.priceCents / 100, source: p.source })) } };
    }
    if (root === 'events' && n === 2) {
      const st = q.get('status');
      const rows = store.marketEvents.filter((e) => !st || e.status === st).sort((a, b) => a.startsAt - b.startsAt || a.eventId - b.eventId).map((e) => eventJson(store, e));
      return { status: 200, body: { events: rows } };
    }
    if (root === 'events' && n === 3) { const e = findEvent(store, id); return e ? { status: 200, body: eventJson(store, e) } : err(404, 'EVENT_NOT_FOUND', `No market event with id ${id}.`); }
    if (root === 'reservations' && n === 2) {
      const eid = intQ('eventId'), iid = intQ('itemId'), st = q.get('status');
      const rows = store.reservations.filter((r) => (eid === null || r.eventId === eid) && (iid === null || r.itemId === iid) && (!st || r.status === st)).sort((a, b) => a.reservationId - b.reservationId).map(resJson);
      return { status: 200, body: { reservations: rows } };
    }
    return err(404, 'NOT_FOUND', 'Unknown route.');
  }
  if (method === 'POST') {
    if (root === 'events' && n === 2) return saveEvent(store, null, body, clock);
    if (root === 'events' && n === 3) return saveEvent(store, id, body, clock);
    if (root === 'events' && n === 4 && segs[3] === 'decision') return decideEvent(store, id, body, clock);
    if (root === 'reservations' && n === 2) return createReservation(store, body, clock);
    if (root === 'reservations' && n === 4 && segs[3] === 'decision') return decideReservation(store, id, body, clock);
    return err(404, 'NOT_FOUND', 'Unknown route.');
  }
  return err(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
}

// ---- body of a create or edit: returns { error } or { ev }
function parseEvent(b) {
  const bad = (field, message) => ({ error: err(400, 'VALIDATION_ERROR', message, field) });
  if (!strOk(b.eventName, 1, 80)) return bad('eventName', 'eventName must be a string of 1 to 80 characters.');
  if (!strOk(b.venue, 1, 120)) return bad('venue', 'venue must be a string of 1 to 120 characters.');
  if (b.area !== undefined && !strOk(b.area, 0, 80)) return bad('area', 'area must be a string of at most 80 characters.');
  if (b.notes !== undefined && !strOk(b.notes, 0, 500)) return bad('notes', 'notes must be a string of at most 500 characters.');
  const startsAt = isStr(b.startsAt) ? parseIso(b.startsAt) : null;
  if (!startsAt) return bad('startsAt', 'startsAt must be ISO 8601 UTC, e.g. 2026-10-31T06:00:00Z.');
  const endsAt = isStr(b.endsAt) ? parseIso(b.endsAt) : null;
  if (!endsAt || endsAt.getTime() <= startsAt.getTime()) return bad('endsAt', 'endsAt must be ISO 8601 UTC and later than startsAt.');
  if (b.farmId !== undefined && !posInt(b.farmId, 2147483647)) return bad('farmId', 'farmId must be an integer.');
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > MARKET_MAX_ITEMS) return bad('items', `items must be a list of 1 to ${MARKET_MAX_ITEMS} items.`);
  const items = [];
  for (let i = 0; i < b.items.length; i++) {
    const x = b.items[i], f = `items[${i}]`;
    if (!isObj(x)) return bad(f, `${f} must be an object.`);
    if (!strOk(x.crop, 1, 40)) return bad(`${f}.crop`, `${f}.crop must be a string of 1 to 40 characters.`);
    if (x.label !== undefined && !strOk(x.label, 0, 80)) return bad(`${f}.label`, `${f}.label must be a string of at most 80 characters.`);
    if (!posInt(x.quantityKg, MAX_KG)) return bad(`${f}.quantityKg`, `${f}.quantityKg must be a whole number of kg from 1 to ${MAX_KG}.`);
    if (!isMoney(x.pricePerKg) || x.pricePerKg <= 0 || x.pricePerKg > MAX_AMOUNT_RAND) return bad(`${f}.pricePerKg`, `${f}.pricePerKg must be a positive number in Rand with at most 2 decimals.`);
    if (x.lotId !== undefined && x.lotId !== null && !posInt(x.lotId, 2147483647)) return bad(`${f}.lotId`, `${f}.lotId must be an integer.`);
    items.push({ crop: x.crop, label: x.label ? x.label : x.crop, quantityKg: x.quantityKg, priceCents: toCents(x.pricePerKg), lotId: x.lotId || 0 });
  }
  return { ev: { eventName: b.eventName, venue: b.venue, area: b.area ?? '', notes: b.notes ?? '', startsAt, endsAt, farmId: b.farmId ?? 1, items } };
}

// create (eventId null) or edit (replace the event fields and all its items; the rules run again)
function saveEvent(store, eventId, b, clock) {
  const p = parseEvent(b); if (p.error) return p.error;
  const c = common(b, clock); if (c.error) return c.error;
  const ev = p.ev;
  let row = null;
  if (eventId !== null) {
    row = findEvent(store, eventId);
    if (!row) return err(404, 'EVENT_NOT_FOUND', `No market event with id ${eventId}.`);
    if (row.status === 'cancelled') return err(409, 'ALREADY_DECIDED', 'Event is already cancelled.');
    if (store.reservations.some((r) => r.eventId === eventId && r.status === 'confirmed')) {
      return err(409, 'HAS_RESERVATIONS', 'This event already has reservations. Cancel it and create a new one instead.');
    }
  }
  if (!store.farms.some((f) => f.farmId === ev.farmId)) return err(404, 'FARM_NOT_FOUND', `No farm with id ${ev.farmId}.`);
  for (const it of ev.items) if (it.lotId && !store.lots.some((l) => l.lotId === it.lotId)) return err(404, 'LOT_NOT_FOUND', `No harvest lot with id ${it.lotId}.`);
  const res = checkEvent(store, ev, c.asOf, eventId ?? 0);
  const ok = res.verdict === okVerdict;
  if (row === null) {
    row = { eventId: ++store.seq.marketEvent, createdAt: c.asOf };
    store.marketEvents.push(row);
  } else {
    store.marketItems = store.marketItems.filter((it) => it.eventId !== row.eventId);
  }
  Object.assign(row, { farmId: ev.farmId, eventName: ev.eventName, venue: ev.venue, area: ev.area, notes: ev.notes, startsAt: ev.startsAt, endsAt: ev.endsAt,
    status: ok ? 'pending_approval' : 'rejected', verdict: res.verdict, rejectReasons: res.rejectReasons, decidedAt: null, requestId: c.requestId });
  ev.items.forEach((it, i) => store.marketItems.push({ itemId: ++store.seq.marketItem, eventId: row.eventId, itemOrder: i + 1, crop: it.crop, itemLabel: it.label,
    quantityKg: it.quantityKg, priceCents: it.priceCents, lotId: it.lotId }));
  if (eventId !== null) addAudit(store, c.requestId, c.actor, 'market_event_edited', `event ${row.eventId}`, c.asOf);
  addAudit(store, c.requestId, 'abl-rules', 'market_rule_check', `event ${row.eventId} ${ev.items.length} item(s) => ${res.verdict}`, c.asOf);
  return { status: eventId === null ? 201 : 200, body: eventJson(store, row) };
}

function decideEvent(store, id, b, clock) {
  if (!isStr(b.decision) || !['approve', 'reject', 'cancel'].includes(b.decision)) return err(400, 'VALIDATION_ERROR', 'decision must be approve, reject or cancel.', 'decision');
  const c = common(b, clock); if (c.error) return c.error;
  const row = findEvent(store, id);
  if (!row) return err(404, 'EVENT_NOT_FOUND', `No market event with id ${id}.`);
  if (b.decision === 'approve') {
    if (row.status === 'rejected') return err(409, 'NOT_APPROVABLE', 'This event was rejected by the rules and cannot be published. Edit it first.');
    if (row.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Event is already ${row.status}.`);
    const items = eventItems(store, id).map((it) => ({ crop: it.crop, quantityKg: it.quantityKg, priceCents: it.priceCents, lotId: it.lotId }));
    const res = checkEvent(store, { startsAt: row.startsAt, items }, c.asOf, id);
    if (res.verdict !== okVerdict) {
      Object.assign(row, { status: 'rejected', verdict: res.verdict, rejectReasons: res.rejectReasons, decidedAt: c.asOf });
      addAudit(store, c.requestId, c.actor, 'market_publish_blocked_by_rules', `event ${id}`, c.asOf);
      return { status: 409, body: { ...eventJson(store, row), error: 'NOT_APPROVABLE' } };
    }
    Object.assign(row, { status: 'published', decidedAt: c.asOf });
    addAudit(store, c.requestId, c.actor, 'market_event_published', `event ${id}`, c.asOf);
    return { status: 200, body: eventJson(store, row) };
  }
  if (b.decision === 'reject') {
    if (row.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Event is already ${row.status}.`);
    Object.assign(row, { status: 'declined', decidedAt: c.asOf });
    addAudit(store, c.requestId, c.actor, 'market_event_declined', `event ${id}`, c.asOf);
    return { status: 200, body: eventJson(store, row) };
  }
  if (row.status === 'cancelled') return err(409, 'ALREADY_DECIDED', 'Event is already cancelled.');
  if (!ACTIVE_EVENT.includes(row.status)) return err(409, 'NOT_CANCELLABLE', `Only a pending or published event can be cancelled (this one is ${row.status}).`);
  let k = 0;
  for (const r of store.reservations) if (r.eventId === id && r.status === 'confirmed') { Object.assign(r, { status: 'cancelled', decidedAt: c.asOf }); k++; }
  Object.assign(row, { status: 'cancelled', decidedAt: c.asOf });
  addAudit(store, c.requestId, c.actor, 'market_event_cancelled', `event ${id}: ${k} reservation(s) cancelled`, c.asOf);
  return { status: 200, body: eventJson(store, row) };
}

function createReservation(store, b, clock) {
  if (!posInt(b.itemId, 2147483647)) return err(400, 'VALIDATION_ERROR', 'itemId must be an integer.', 'itemId');
  if (!strOk(b.buyerName, 1, 80)) return err(400, 'VALIDATION_ERROR', 'buyerName must be a string of 1 to 80 characters.', 'buyerName');
  if (!posInt(b.quantityKg, MAX_KG)) return err(400, 'VALIDATION_ERROR', `quantityKg must be a whole number of kg from 1 to ${MAX_KG}.`, 'quantityKg');
  const c = common(b, clock); if (c.error) return c.error;
  const item = findItem(store, b.itemId);
  if (!item) return err(404, 'ITEM_NOT_FOUND', `No market item with id ${b.itemId}.`);
  const res = checkReservation(store, { itemId: b.itemId, quantityKg: b.quantityKg }, c.asOf);
  const ok = res.verdict === okVerdict;
  const row = { reservationId: ++store.seq.reservation, eventId: item.eventId, itemId: item.itemId, buyerName: b.buyerName, quantityKg: b.quantityKg, status: ok ? 'confirmed' : 'rejected',
    verdict: res.verdict, rejectReasons: res.rejectReasons, createdAt: c.asOf, decidedAt: null, requestId: c.requestId };
  store.reservations.push(row);
  addAudit(store, c.requestId, 'abl-rules', 'reservation_rule_check', `reservation ${row.reservationId} item ${item.itemId} ${b.quantityKg} kg => ${res.verdict}`, c.asOf);
  return { status: 201, body: resJson(row) };
}

function decideReservation(store, id, b, clock) {
  if (b.decision !== 'cancel') return err(400, 'VALIDATION_ERROR', 'decision must be cancel.', 'decision');
  const c = common(b, clock); if (c.error) return c.error;
  const row = store.reservations.find((r) => r.reservationId === id);
  if (!row) return err(404, 'RESERVATION_NOT_FOUND', `No reservation with id ${id}.`);
  if (row.status !== 'confirmed') return err(409, 'ALREADY_DECIDED', `Reservation is already ${row.status}.`);
  Object.assign(row, { status: 'cancelled', decidedAt: c.asOf });
  addAudit(store, c.requestId, c.actor, 'reservation_cancelled', `reservation ${id}`, c.asOf);
  return { status: 200, body: resJson(row) };
}
