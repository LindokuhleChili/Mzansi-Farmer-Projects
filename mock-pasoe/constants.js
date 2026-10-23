// Named constants. Keep identical to the &SCOPED-DEFINEs at the top of openedge/src/farm-api.p.
export const STALE_READING_MINUTES = 15;   // sensor reading older than this blocks irrigation (rule SENSOR_STALE)
export const BUDGET_WINDOW_DAYS = 7;       // weekly water budget window
export const ALLOWED_ACTIONS = ['irrigate', 'hold', 'notify'];
