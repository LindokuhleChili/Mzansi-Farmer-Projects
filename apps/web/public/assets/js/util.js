// Small helpers: safe HTML templating (everything is escaped unless wrapped in raw()), icons, time and number formatting.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : v === false || v == null ? '' : esc(v));
export const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const p = (d, extra = '') => `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
// Icon paths are the ones used in the approved demo screens (docs/screens), stroke 1.8.
const CHEV = '<path d="m9 6 6 6-6 6"/>', RECEIPT = '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>';
export const ICONS = {
  home: p('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  grid: p('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
  plots: p('<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  list: p('<path d="m4 7 2 2 3-3M4 16l2 2 3-3M13 7h7M13 17h7"/>'),
  book: p(RECEIPT),
  gear: p('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>'),
  logout: p('<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>'),
  dots: p('<path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/>'),
  bell: p('<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>'),
  search: p('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  pin: p('<path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  drop: p('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'),
  temp: p('<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>'),
  cloud: p('<path d="M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 11a3.5 3.5 0 0 1 0 7z"/>'),
  sun: p('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>'),
  rain: p('<path d="M7 15a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 8a3.5 3.5 0 0 1 .5 7"/><path d="m8 19-1 2m5-2-1 2m5-2-1 2"/>'),
  check: p('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  x: p('<path d="M6 6l12 12M18 6 6 18"/>'),
  lock: p('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  clock: p('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  back: p('<path d="M19 12H5m6-7-7 7 7 7"/>'),
  next: p(CHEV), chev: p(CHEV),
  refresh: p('<path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4M12 8v4l3 2"/>'),
  shield: p('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>'),
  spark: p('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
  sensor: p('<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01"/>'),
  leaf: `<svg class="ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21v-9"/><path d="M12 12c0-4 3-6 7-6 0 4-3 6-7 6z"/><path d="M12 15c0-3-2.5-5-6-5 0 3 2.5 5 6 5z"/></svg>`,
  basket: p('<path d="M4 9h16l-1.5 10a2 2 0 0 1-2 1.7h-9a2 2 0 0 1-2-1.7z"/><path d="m8 9 3-5M16 9l-3-5"/>'),
  send: p('<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>'),
};
export const icon = (name, size) => raw(size ? ICONS[name].replace('width="18" height="18"', `width="${size}" height="${size}"`) : ICONS[name]);

export const TZ = 'Africa/Johannesburg';
const f = (opts) => new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, hour12: false, ...opts });
const fTime = f({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fHM = f({ hour: '2-digit', minute: '2-digit' });
const fDay = f({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fDayLong = f({ weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
const fDayNoYear = f({ weekday: 'short', day: 'numeric', month: 'short' });
const fShortDay = f({ day: 'numeric', month: 'short' });
const ok = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d; };
export const fmtTime = (iso) => { const d = ok(iso); return d ? fTime.format(d) : '—'; };
export const fmtHM = (iso) => { const d = ok(iso); return d ? fHM.format(d) : '—'; };
export const fmtDay = (iso) => { const d = ok(iso); return d ? fDay.format(d).replace(/,/g, '') : '—'; };
export const fmtDayLong = (iso) => { const d = ok(iso); return d ? fDayLong.format(d).replace(/,/g, '') : '—'; };
export const fmtDayNoYear = (iso) => { const d = ok(iso); return d ? fDayNoYear.format(d).replace(/,/g, '') : '—'; };
export const fmtShortDay = (iso) => { const d = ok(iso); return d ? fShortDay.format(d) : '—'; };
export const fmtDateTime = (iso) => { const d = ok(iso); return d ? `${fShortDay.format(d)} ${fHM.format(d)}` : '—'; };
export const ageMinutes = (iso, now = Date.now()) => { const d = ok(iso); return d ? Math.max(0, Math.round((now - d.getTime()) / 60000)) : null; };

export const num = (v, digits = 1) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const [i, d] = (Math.round(Number(v) * 10 ** digits) / 10 ** digits).toFixed(digits).split('.');
  const frac = d && /[1-9]/.test(d) ? '.' + d.replace(/0+$/, '') : '';
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + frac;   // 18.5, 1 500 (point decimal, thin groups, as on the approved screens)
};
export const shortName = (n) => String(n || '').replace(/\s*\(example\)\s*$/i, '');
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const PHOTOS = { Maize: 'plot-maize.jpg', Tomato: 'plot-tomato-greenhouse.jpg', Cabbage: 'plot-cabbage.jpg', Beans: 'plot-beans.jpg', Spinach: 'plot-spinach.jpg' };
export const photoUrl = (crop) => `/assets/photos/${PHOTOS[crop] || 'plot-maize.jpg'}`;
const PHOTO_POS = { Maize: '50% 40%', Tomato: '50% 55%', Cabbage: '50% 60%' };   // focal points used on the approved screens
export const photoStyle = (crop, extra = '') => `background-image:url(${photoUrl(crop)});background-position:${PHOTO_POS[crop] || '50% 50%'};${extra}`;
