// Harvest-day market tests (run by `npm test`, or alone: node --test eval/market.test.mjs). Offline, no network.
// The end-to-end market cases (MK01 to MK51) are in eval/oe-contract-cases.json and run against mock-pasoe AND the real ABL.
// These tests cover the rule edges a JSON case does not (reserve share rounding, the cent below retail, lot stock shared
// between events) and the /api/v1/market routes with their two-step publish and cancel confirmation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../mock-pasoe/store.js';
import { handle } from '../mock-pasoe/handler.js';
import { reserveLimitKg, lotMarketAvailableKg } from '../mock-pasoe/market-rules.js';
import { loadCases, isMarketCase } from './compare-oe.mjs';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';

const T0 = '2026-10-24T09:00:00Z';
const call = (store, method, path, body = {}) => { const r = handle(store, method, path, body); return { status: r.status, body: JSON.parse(JSON.stringify(r.body)) }; };
const ev = (items, extra = {}) => ({ eventName: 'Test market day', venue: 'Test hall', startsAt: '2026-11-07T06:00:00Z', endsAt: '2026-11-07T11:00:00Z', items, asOf: T0, ...extra });

test('market: 50% of an item may be reserved, rounded down to whole kg', () => {
  assert.equal(reserveLimitKg(120), 60);
  assert.equal(reserveLimitKg(5), 2);
  assert.equal(reserveLimitKg(1), 0);
});

test('market: a price one cent below the retail buyer price passes; the same price is blocked', () => {
  const s = createStore();
  const ok = call(s, 'POST', '/farm/market/events', ev([{ crop: 'Tomato', quantityKg: 10, pricePerKg: 13.99 }]));
  assert.equal(ok.status, 201); assert.equal(ok.body.status, 'pending_approval');
  const bad = call(s, 'POST', '/farm/market/events', ev([{ crop: 'Tomato', quantityKg: 10, pricePerKg: 14 }]));
  assert.equal(bad.body.status, 'rejected');
  assert.equal(bad.body.rejectReasons[0].code, 'PRICE_NOT_BELOW_RETAIL');
  assert.equal(bad.body.rejectReasons[0].suggestedPricePerKg, 13.99);
});

test('market: a crop with no reference price is blocked (NO_REFERENCE_PRICE), so below-retail is never guessed', () => {
  const s = createStore();
  const r = call(s, 'POST', '/farm/market/events', ev([{ crop: 'Butternut', quantityKg: 10, pricePerKg: 1 }]));
  assert.deepEqual(r.body.rejectReasons.map((x) => x.code), ['NO_REFERENCE_PRICE']);
});

test('market: two items from the same lot in one event share its stock', () => {
  const s = createStore();
  const lot = s.lots.find((l) => l.lotId === 2);
  const avail = lotMarketAvailableKg(s, lot);
  const half = Math.ceil(avail / 2) + 1;
  const r = call(s, 'POST', '/farm/market/events', ev([{ crop: lot.crop, quantityKg: half, pricePerKg: 1, lotId: 2 }, { crop: lot.crop, quantityKg: half, pricePerKg: 1, lotId: 2 }]));
  assert.equal(r.body.status, 'rejected');
  const reason = r.body.rejectReasons.find((x) => x.code === 'LOT_STOCK_EXCEEDED');
  assert.equal(reason.item, 2);
  assert.equal(reason.suggestedKg, avail - half);
});

test('market: kg listed on a cancelled event goes back to the lot', () => {
  const s = createStore();
  const lot = s.lots.find((l) => l.lotId === 2);
  const before = lotMarketAvailableKg(s, lot);
  const c = call(s, 'POST', '/farm/market/events/1/decision', { decision: 'cancel', asOf: T0 });
  assert.equal(c.status, 200);
  assert.equal(lotMarketAvailableKg(s, lot), before + 300);
});

test('market: every MK contract case is in the shared case file, numbered without gaps', () => {
  const ids = loadCases().filter(isMarketCase).map((c) => c.id);
  assert.equal(ids.length, 51);
  ids.forEach((id, i) => assert.equal(id, `MK${String(i + 1).padStart(2, '0')}`));
});

test('market: the seed is example data and every seeded price is per kg in Rand', () => {
  const seed = JSON.parse(readFileSync(new URL('../openedge/data/market-seed.json', import.meta.url), 'utf8'));
  assert.ok(seed.retailPrices.length >= 5);
  for (const p of seed.retailPrices) assert.ok(p.pricePerKg > 0 && /example/i.test(p.source), p.crop);
});

// ---------------- /api/v1/market
const APP = 'mk-app-token-fixture-123';
const NOW = new Date(T0);
function make() {
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-mk-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'mk-device-token-fixture-1' }]) });
  return buildApp({ config, oe: createOeClient(config, { clock: () => NOW }), provider: createMockProvider({}), clock: () => NOW });
}
const api = async (app, method, url, payload, token = APP) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } });
  return { status: r.statusCode, body: r.json() };
};

test('API market: reads need the app token and list events by start date', async () => {
  const app = make();
  assert.equal((await api(app, 'GET', '/api/v1/market/events', undefined, null)).status, 401);
  const r = await api(app, 'GET', '/api/v1/market/events');
  assert.equal(r.status, 200);
  const starts = r.body.events.map((e) => Date.parse(e.startsAt));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  const p = await api(app, 'GET', '/api/v1/market/prices');
  assert.ok(p.body.prices.some((x) => x.crop === 'Maize'));
});

test('API market: create, then publish needs a confirm token, and the token is single use', async () => {
  const app = make();
  const c = await api(app, 'POST', '/api/v1/market/events', ev([{ crop: 'Spinach', quantityKg: 40, pricePerKg: 12 }], { asOf: undefined }));
  assert.equal(c.status, 201); assert.equal(c.body.status, 'pending_approval');
  const id = c.body.eventId;
  const step1 = await api(app, 'POST', `/api/v1/market/events/${id}/publish`, {});
  assert.equal(step1.status, 202); assert.equal(step1.body.error, 'CONFIRMATION_REQUIRED');
  assert.match(step1.body.summary, /Publish Test market day/);
  const wrongAction = await api(app, 'POST', `/api/v1/market/events/${id}/cancel`, { confirmToken: step1.body.confirmToken });
  assert.equal(wrongAction.status, 403);
  const step2 = await api(app, 'POST', `/api/v1/market/events/${id}/publish`, { confirmToken: step1.body.confirmToken });
  assert.equal(step2.status, 200); assert.equal(step2.body.status, 'published');
  const again = await api(app, 'POST', `/api/v1/market/events/${id}/publish`, { confirmToken: step1.body.confirmToken });
  assert.equal(again.status, 403);   // the token was used up
});

test('API market: a blocked event cannot be published, and the reasons come back', async () => {
  const app = make();
  const c = await api(app, 'POST', '/api/v1/market/events', ev([{ crop: 'Tomato', quantityKg: 10, pricePerKg: 20 }], { asOf: undefined }));
  assert.equal(c.body.status, 'rejected');
  const p = await api(app, 'POST', `/api/v1/market/events/${c.body.eventId}/publish`, {});
  assert.equal(p.status, 409); assert.equal(p.body.error, 'NOT_APPROVABLE');
  assert.equal(p.body.rejectReasons[0].code, 'PRICE_NOT_BELOW_RETAIL');
});

test('API market: reserve, cancel the reservation, then cancel the event with confirmation', async () => {
  const app = make();
  const r = await api(app, 'POST', '/api/v1/market/reservations', { itemId: 1, buyerName: 'Thandi', quantityKg: 20 });
  assert.equal(r.status, 201); assert.equal(r.body.status, 'confirmed');
  const cr = await api(app, 'POST', `/api/v1/market/reservations/${r.body.reservationId}/cancel`, {});
  assert.equal(cr.status, 200); assert.equal(cr.body.status, 'cancelled');
  const s1 = await api(app, 'POST', '/api/v1/market/events/1/cancel', {});
  assert.equal(s1.status, 202);
  const s2 = await api(app, 'POST', '/api/v1/market/events/1/cancel', { confirmToken: s1.body.confirmToken });
  assert.equal(s2.status, 200); assert.equal(s2.body.status, 'cancelled');
});

test('API market: the local UI proxy forwards /market but not other paths', async () => {
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-mk-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'mk-device-token-fixture-1' }]), UI_ENABLED: 'true' });
  const app = buildApp({ config, oe: createOeClient(config, { clock: () => NOW }), provider: createMockProvider({}), clock: () => NOW });
  const h = { host: 'localhost:3000', 'x-requested-with': 'mzansi-ui' };
  const ok = await app.inject({ method: 'GET', url: '/ui/api/v1/market/events/1', headers: h });
  assert.equal(ok.statusCode, 200); assert.equal(ok.json().eventId, 1);
  const no = await app.inject({ method: 'GET', url: '/ui/api/v1/marketing', headers: h });
  assert.equal(no.statusCode, 404);
});

test('market UI: draft isiZulu lines stay in their own table, only for market keys, and every one is listed for native review in docs/MARKET.md', () => {
  const i18n = readFileSync(new URL('../apps/web/public/assets/js/i18n.js', import.meta.url), 'utf8');
  const block = /const zuMarket = \{([\s\S]*?)\n\};/.exec(i18n)[1];
  const rows = [...block.matchAll(/^\s+(\w+): '([^']*)'/gm)];
  assert.ok(rows.length >= 5);
  const doc = readFileSync(new URL('../docs/MARKET.md', import.meta.url), 'utf8');
  for (const [, k, zu] of rows) { assert.match(k, /^mk_/, k); assert.ok(doc.includes(k) && doc.includes(zu), `${k} missing from docs/MARKET.md`); }
});
