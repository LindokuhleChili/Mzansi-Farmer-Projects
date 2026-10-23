// Strict ISO 8601 parser matching openedge/src/iso.i (fParseIso): yyyy-mm-ddThh:mm:ss[.sss](Z|+hh:mm)
const RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|z|[+-]\d{2}:\d{2})$/;
// Real calendar check (leap years included): the day must exist in that month. Same rule as openedge/src/iso.i.
export const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysInMonth = (y, m) => (m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31);
export function parseIso(s) {
  if (typeof s !== 'string') return null;
  const m = RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, frac, tz] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > daysInMonth(+y, +mo) || +h > 23 || +mi > 59 || +sec > 59) return null;
  if (tz !== 'Z' && tz !== 'z' && (+tz.slice(1, 3) > 23 || +tz.slice(4, 6) > 59)) return null;
  const ms = frac ? +(frac + '00').slice(0, 3) : 0;
  let offsetMin = 0;
  if (tz !== 'Z' && tz !== 'z') offsetMin = (tz[0] === '-' ? -1 : 1) * (+tz.slice(1, 3) * 60 + +tz.slice(4, 6));
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms) - offsetMin * 60000;
  return Number.isNaN(t) ? null : new Date(t);
}
export const iso = (d) => (d ? d.toISOString() : null);
export const minutesBetween = (later, earlier) => Math.trunc((later.getTime() - earlier.getTime()) / 60000);
