// In-memory stand-in for the OpenEdge database (same tables as openedge/schema/002-farm-ops.df). EXAMPLE DATA ONLY.
import { readFileSync } from 'node:fs';
import { parseIso } from './time.js';
import { loadWeatherSeed } from './weather.js';
import { loadDoctorSeed } from './doctor.js';

const SEED_PATH = new URL('../openedge/data/seed.json', import.meta.url);
const COOP_SEED_PATH = new URL('../openedge/data/coop-seed.json', import.meta.url);
const MARKET_SEED_PATH = new URL('../openedge/data/market-seed.json', import.meta.url);

export function createStore(seedPath = SEED_PATH, coopSeedPath = COOP_SEED_PATH, marketSeedPath = MARKET_SEED_PATH) {
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  const store = {
    farms: seed.farms.map((f) => ({ ...f })),
    plots: seed.plots.map((p) => ({ ...p })),
    readings: [], suggestions: [], audit: [],
    // co-op tables (openedge/schema/003-coop.df); money is kept as integer cents, quantities as whole kg
    members: [], credits: [], lots: [], contracts: [], allocations: [], payouts: [],
    // harvest-day market tables (openedge/schema/004-market.df)
    retailPrices: [], marketEvents: [], marketItems: [], reservations: [],
    seq: { reading: 1000, suggestion: 0, audit: 0, member: 0, credit: 0, lot: 0, contract: 0, allocation: 0, payout: 0, marketEvent: 0, marketItem: 0, reservation: 0 },
    latestReading(plotId) {
      let best = null;
      for (const r of this.readings) if (r.plotId === plotId && (!best || r.readAt > best.readAt)) best = r;
      return best;
    },
  };
  for (const r of seed.readings) {
    store.readings.push({ readingId: ++store.seq.reading, plotId: r.plotId, deviceId: r.deviceId, readAt: parseIso(r.timestamp),
      soilMoisturePct: r.soilMoisturePct, temperatureC: r.temperatureC, humidityPct: r.humidityPct, raining: !!r.raining });
  }
  for (const s of seed.suggestions) {
    store.suggestions.push({ suggestionId: ++store.seq.suggestion, plotId: s.plotId, createdAt: parseIso(s.createdAt), decidedAt: parseIso(s.decidedAt),
      action: s.action, litres: s.litres, reason: s.reason, provider: s.provider, status: s.status, verdict: s.verdict, rejectReasons: [], requestId: 'seed' });
  }
  loadCoopSeed(store, coopSeedPath);
  loadMarketSeed(store, marketSeedPath);
  loadWeatherSeed(store);   // weather alerts (feature 17): forecast is FICTIONAL EXAMPLE DATA
  loadDoctorSeed(store);    // plant doctor (feature 1): no-doses word list (feature 2)
  return store;
}

const toCents = (x) => Math.round(x * 100);
function loadCoopSeed(store, path) {
  const seed = JSON.parse(readFileSync(path, 'utf8'));
  for (const m of seed.members) store.members.push({ memberId: ++store.seq.member, memberName: m.memberName, location: m.location, preferredLang: m.preferredLang, creditLimitCents: toCents(m.creditLimit) });
  for (const c of seed.credits) {
    store.credits.push({ creditId: ++store.seq.credit, memberId: c.memberId, item: c.item, amountCents: toCents(c.amount), repaidCents: toCents(c.repaidAmount), status: c.status,
      verdict: 'approved_by_rules', rejectReasons: [], createdAt: parseIso(c.createdAt), decidedAt: parseIso(c.decidedAt), requestId: 'seed' });
  }
  for (const l of seed.lots) {
    const contributions = l.contributions.map((x) => ({ memberId: x.memberId, kg: x.kg })).sort((a, b) => a.memberId - b.memberId);
    store.lots.push({ lotId: ++store.seq.lot, lotCode: l.lotCode, crop: l.crop, contributions, quantityKg: contributions.reduce((a, x) => a + x.kg, 0) });
  }
  for (const c of seed.contracts) store.contracts.push({ contractId: ++store.seq.contract, contractCode: c.contractCode, buyerName: c.buyerName, crop: c.crop, quantityKg: c.quantityKg, priceCents: toCents(c.pricePerKg), status: c.status });
}

function loadMarketSeed(store, path) {
  const seed = JSON.parse(readFileSync(path, 'utf8'));
  for (const p of seed.retailPrices) store.retailPrices.push({ crop: p.crop, priceCents: toCents(p.pricePerKg), source: p.source });
  for (const e of seed.events) {
    const ev = { eventId: ++store.seq.marketEvent, farmId: 1, eventName: e.eventName, venue: e.venue, area: e.area, notes: e.notes, startsAt: parseIso(e.startsAt), endsAt: parseIso(e.endsAt),
      status: e.status, verdict: 'approved_by_rules', rejectReasons: [], createdAt: parseIso(e.createdAt), decidedAt: parseIso(e.decidedAt), requestId: 'seed' };
    store.marketEvents.push(ev);
    e.items.forEach((it, i) => store.marketItems.push({ itemId: ++store.seq.marketItem, eventId: ev.eventId, itemOrder: i + 1, crop: it.crop, itemLabel: it.label,
      quantityKg: it.quantityKg, priceCents: toCents(it.pricePerKg), lotId: it.lotId || 0 }));
  }
  for (const r of seed.reservations) {
    const item = store.marketItems.filter((x) => x.eventId === r.eventIndex)[r.itemIndex - 1];
    store.reservations.push({ reservationId: ++store.seq.reservation, eventId: item.eventId, itemId: item.itemId, buyerName: r.buyerName, quantityKg: r.quantityKg, status: 'confirmed',
      verdict: 'approved_by_rules', rejectReasons: [], createdAt: parseIso(r.createdAt), decidedAt: null, requestId: 'seed' });
  }
}
