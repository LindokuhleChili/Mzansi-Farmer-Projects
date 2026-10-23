// Small helpers: safe HTML templating (everything is escaped unless wrapped in raw()), icons, time and number formatting.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : v === false || v == null ? '' : esc(v));
export const html = (strings, ...vals) => new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? part(vals[i]) : ''), ''));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const p = (d, extra = '') => `<svg class="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
export const ICONS = {
  home: p('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
  plots: p('<path d="M12 21V11"/><path d="M12 11c0-4 3-7 8-7 0 5-3 8-8 7z"/><path d="M12 15c0-3-2.500-5.500-7-5.500 0 4 2.500 6.500 7 5.500z"/>'),
  list: p('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>'),
  book: p('<path d="M6 3h12v18l-6-4-6 4z"/><path d="M9 8h6M9 12h6"/>'),
  drop: p('<path d="M12 3s6 6.500 6 11a6 6 0 0 1-12 0c0-4.500 6-11 6-11z"/>'),
  temp: p('<path d="M14 14.800V5a2 2 0 0 0-4 0v9.800a4 4 0 1 0 4 0z"/>'),
  cloud: p('<path d="M7 18a4 4 0 0 1-.6-7.900A5.500 5.500 0 0 1 17 9.500 4.300 4.300 0 0 1 17 18z"/>'),
  sun: p('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400"/>'),
  rain: p('<path d="M7 15a4 4 0 0 1-.6-7.900A5.500 5.500 0 0 1 17 6.500 4.300 4.300 0 0 1 17 15z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>'),
  check: p('<path d="M5 12.500l4.500 4.500L19 7.500"/>'),
  x: p('<path d="M6 6l12 12M18 6L6 18"/>'),
  lock: p('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  clock: p('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  back: p('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  next: p('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  refresh: p('<path d="M20 11a8 8 0 0 0-14.500-3.500L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.500 3.500L20 15"/><path d="M20 20v-5h-5"/>'),
  shield: p('<path d="M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
  spark: p('<path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800z"/>'),
  sensor: p('<path d="M5 12.500a10 10 0 0 1 14 0M8 15.500a6 6 0 0 1 8 0"/><circle cx="12" cy="18.500" r="1"/>'),
  leaf: `<svg class="ic" width="20" height="20" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 27V15M16 15c0-4 3-7 8-7 0 5-3 8-8 7zM16 19c0-3-2.500-5.500-6.500-5.500 0 4 2.500 6.500 6.500 5.500z"/></svg>`,
  send: p('<path d="M4 12l16-8-6 16-3-7z"/>'),
};
export const icon = (name, size) => raw(size ? ICONS[name].replace('width="18" height="18"', `width="${size}" height="${size}"`) : ICONS[name]);

export const TZ = 'Africa/Johannesburg';
const f = (opts) => new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, hour12: false, ...opts });
const fTime = f({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fHM = f({ hour: '2-digit', minute: '2-digit' });
const fDay = f({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fShortDay = f({ day: 'numeric', month: 'short' });
const ok = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d; };
export const fmtTime = (iso) => { const d = ok(iso); return d ? fTime.format(d) : '—'; };
export const fmtHM = (iso) => { const d = ok(iso); return d ? fHM.format(d) : '—'; };
export const fmtDay = (iso) => { const d = ok(iso); return d ? fDay.format(d).replace(/,/g, '') : '—'; };
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
