// Address of the ESP32's own dashboard (WaterLevel-ESP32 hotspot).
// The Node server only stores this string and hands it to the browser (GET /ui/session).
// It never connects to the device: 192.168.4.1 is reachable only from a browser on that hotspot.
// The device sends no CORS headers, so the page embeds it in an iframe and does not read GET /data.
export const ESP32_DASHBOARD_URL_DEFAULT = 'http://192.168.4.1';
export const ESP32_URL_STORAGE_KEY = 'mf.esp32Url';
export const ESP32_PROBE_TIMEOUT_MS = 3000;
const MAX_URL_LENGTH = 300;

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

/** Empty env means the hotspot default. A set but invalid value is a startup error. */
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

/** Saved browser address wins. Otherwise the server value, otherwise the hotspot default. */
export function resolveEsp32DashboardUrl(serverUrl, storage) {
  return readEsp32UrlOverride(storage) || normalizeEsp32DashboardUrl(serverUrl) || ESP32_DASHBOARD_URL_DEFAULT;
}

/**
 * Browser reachability check. mode no-cors: the device sends no Access-Control-Allow-Origin,
 * so a successful response is opaque and the body is not read (not GET /data).
 * A rejection means this browser could not open the address (offline, blocked, or timed out).
 */
export async function probeEsp32Dashboard(url, fetchImpl = globalThis.fetch, timeoutMs = ESP32_PROBE_TIMEOUT_MS) {
  const normalized = normalizeEsp32DashboardUrl(url);
  if (!normalized || typeof fetchImpl !== 'function') return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchImpl(normalized, { method: 'GET', mode: 'no-cors', cache: 'no-store', redirect: 'follow', credentials: 'omit', signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
