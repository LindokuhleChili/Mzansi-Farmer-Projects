// Named constants. Keep identical to the &SCOPED-DEFINEs at the top of openedge/src/farm-api.p.
export const STALE_READING_MINUTES = 15;   // sensor reading older than this blocks irrigation (rule SENSOR_STALE)
export const BUDGET_WINDOW_DAYS = 7;       // weekly water budget window
export const ALLOWED_ACTIONS = ['irrigate', 'hold', 'notify'];

// Co-op rules (docs/COOP.md). Keep identical to the &SCOPED-DEFINEs at the top of openedge/src/farm-api.p.
export const MAX_AMOUNT_RAND = 10000000;   // largest credit / payout amount accepted (sanity limit, whole Rand)
export const MAX_KG = 10000000;            // largest quantity in kg accepted (sanity limit)

// Harvest-day market (docs/MARKET.md). Keep identical to the &SCOPED-DEFINEs at the top of openedge/src/farm-api.p.
export const MARKET_MAX_ITEMS = 20;        // most items one harvest-day event can list
export const RESERVE_CAP_KG = 50;          // most kg one reservation may hold
export const RESERVE_SHARE_PCT = 50;       // at most this share of an item can be reserved ahead; the rest stays for walk-up buyers
