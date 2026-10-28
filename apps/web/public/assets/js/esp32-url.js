// Address of the ESP32 station-mode dashboard (the board joins the farmer's Wi-Fi).
// The Node server only stores this string and hands it to the browser (GET /ui/session).
// It never connects to the device. The browser reads GET /data, GET /history and GET /calibrate.
// The device sends Access-Control-Allow-Origin: *. A public page may still be blocked from a
// private address (Chrome Local network access); the sensors page treats a failed fetch as that case.
export const ESP32_DASHBOARD_URL_DEFAULT = 'http://192.168.4.1';
export const ESP32_URL_STORAGE_KEY = 'mf.esp32Url';
export const ESP32_FETCH_TIMEOUT_MS = 4000;
export const ESP32_POLL_MS = 1500;
export const ESP32_HISTORY_POINTS = 120;
const MAX_URL_LENGTH = 300;
const CAL_MODES = ['wempty', 'wfull', 'sdry', 'swet'];

/** http(s) URL with no userinfo, or null. Trailing slash and hash are dropped. */
export function normalizeEsp32DashboardUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > MAX_URL_LENGTH) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path === '/' ? '' : path}${u.search || ''}`;
}

/** Empty env means the historical default. A set but invalid value is a startup error. */
export function esp32DashboardUrlFromEnv(raw) {
  if (raw == null || String(raw).trim() === '') return ESP32_DASHBOARD_URL_DEFAULT;
  const n = normalizeEsp32DashboardUrl(raw);
  if (!n) throw new Error('ESP32_DASHBOARD_URL must be an http or https URL with no username or password');
  return n;
}

export function readEsp32UrlOverride(storage) {
  let v = null;
  try { v = storage.getItem(ESP32_URL_STORAGE_KEY); } catch { return null; }
  if (v == null || v === '') return null;
  const n = normalizeEsp32DashboardUrl(v);
  if (!n) { try { storage.removeItem(ESP32_URL_STORAGE_KEY); } catch { /* ignore */ } return null; }
  return n;
}

export function writeEsp32UrlOverride(url, storage) {
  const n = normalizeEsp32DashboardUrl(url);
  if (!n) return null;
  try { storage.setItem(ESP32_URL_STORAGE_KEY, n); } catch { return null; }
  return n;
}

export function clearEsp32UrlOverride(storage) {
  try { storage.removeItem(ESP32_URL_STORAGE_KEY); } catch { /* ignore */ }
}

/** Saved browser address wins. Otherwise the server value, otherwise the default. */
export function resolveEsp32DashboardUrl(serverUrl, storage) {
  return readEsp32UrlOverride(storage) || normalizeEsp32DashboardUrl(serverUrl) || ESP32_DASHBOARD_URL_DEFAULT;
}

/** Device path on the saved origin. Rejects anything that is not a single absolute path. */
export function esp32ResourceUrl(base, pathAndQuery) {
  const n = normalizeEsp32DashboardUrl(base);
  const extra = String(pathAndQuery || '');
  if (!n || !extra.startsWith('/') || extra.startsWith('//') || extra.includes('://') || extra.includes('..')) return null;
  return n + extra;
}

export function esp32CalibrateUrl(base, mode) {
  if (!CAL_MODES.includes(mode)) return null;
  return esp32ResourceUrl(base, `/calibrate?mode=${mode}`);
}

function finite(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : null;
}

function flag(v) {
  return v === true || v === 1 || v === 'true';
}

function clip(v, n) {
  const s = String(v ?? '');
  return s.length > n ? s.slice(0, n) : s;
}

/** Percent from two calibration points. -1 when either point is missing or they are equal. */
export function toSensorPct(raw, lo, hi, loSet, hiSet) {
  if (!loSet || !hiSet || !Number.isFinite(raw) || !Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return -1;
  let p = Math.round((raw - lo) * 100 / (hi - lo));
  if (p < 0) p = 0;
  if (p > 100) p = 100;
  return p;
}

/** Prefer the device's wPct/sPct. -1 means not calibrated. */
export function displayPct(devicePct, raw, lo, hi, loSet, hiSet) {
  if (Number.isFinite(devicePct)) return devicePct < 0 ? -1 : Math.max(0, Math.min(100, Math.round(devicePct)));
  return toSensorPct(raw, lo, hi, loSet, hiSet);
}

/** Live JSON from GET /data, or null when the shape is not usable. */
export function parseEsp32Data(body) {
  if (!body || typeof body !== 'object') return null;
  const wRaw = finite(body.wRaw);
  const sRaw = finite(body.sRaw);
  if (wRaw == null || sRaw == null) return null;
  return {
    wRaw, sRaw,
    wPct: finite(body.wPct),
    sPct: finite(body.sPct),
    wE: finite(body.wE), wF: finite(body.wF), wEs: flag(body.wEs), wFs: flag(body.wFs),
    sD: finite(body.sD), sW: finite(body.sW), sDs: flag(body.sDs), sWs: flag(body.sWs),
    sta: body.sta === true || body.sta === 'true',
    staIp: clip(body.staIp, 80),
    cloud: clip(body.cloud, 120),
    rssi: finite(body.rssi),
  };
}

/** GET /history body. Missing arrays become empty. Samples are capped. */
export function parseEsp32History(body) {
  if (!body || typeof body !== 'object') return null;
  const series = (v) => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite).slice(-ESP32_HISTORY_POINTS) : []);
  const interval = finite(body.intervalMs);
  return { intervalMs: interval && interval > 0 ? interval : 1000, w: series(body.w), s: series(body.s) };
}

/**
 * CORS GET of one device path. A rejection (including Chrome blocking a private address
 * from a public page) is `{ ok: false, reason: 'network' }`. The body is only read on HTTP 2xx.
 */
export async function fetchEsp32Json(base, pathAndQuery, fetchImpl = globalThis.fetch, timeoutMs = ESP32_FETCH_TIMEOUT_MS) {
  const url = esp32ResourceUrl(base, pathAndQuery);
  if (!url || typeof fetchImpl !== 'function') return { ok: false, reason: 'bad-url' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET', mode: 'cors', cache: 'no-store', credentials: 'omit', redirect: 'follow', signal: ctrl.signal,
    });
    if (!res || res.ok !== true || typeof res.json !== 'function') return { ok: false, reason: 'http', status: res ? res.status : 0 };
    try {
      return { ok: true, json: await res.json() };
    } catch {
      return { ok: false, reason: 'json' };
    }
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { ok: false, reason: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
