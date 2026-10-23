// Strict ISO 8601 timestamp check with a real calendar (leap years included). Same rules as mock-pasoe/time.js and openedge/src/iso.i.
// Date.parse() alone is not enough: V8 happily rolls 2026-02-31 over to 2026-03-03.
const RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y, m) => (m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);

export function isValidIsoTimestamp(s) {
  if (typeof s !== 'string') return false;
  const m = RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || sec > 59) return false;
  const tz = m[8];
  if (tz !== 'Z' && (Number(tz.slice(1, 3)) > 23 || Number(tz.slice(4, 6)) > 59)) return false;
  return !Number.isNaN(Date.parse(s));
}
