// API client. Two ways to authenticate, chosen by GET /ui/session:
//  - "proxy": the page runs on the same computer as the API. Calls go to /ui/api/v1/*; the server adds its own app token. The browser holds no token.
//  - "token": the page is opened from another device. The farmer pastes the app token; it is kept in sessionStorage (this tab only) and sent to /api/v1/*.
const H = { 'X-Requested-With': 'mzansi-ui' };
let session = null;
const TOKEN_KEY = 'mf.token';
const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
export const setToken = (v) => { try { v ? sessionStorage.setItem(TOKEN_KEY, v) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };
export const needsToken = () => session?.mode === 'token' && !getToken();
export const getSession = () => session;

export async function loadSession() {
  try {
    const r = await fetch('/ui/session', { headers: H });
    session = r.ok ? await r.json() : { mode: 'token', demo: null };
  } catch { session = { mode: 'token', demo: null, offline: true }; }
  return session;
}

/** Returns { status, body, requestId }. Never throws for HTTP errors; throws only when the network fails. */
export async function api(method, path, body) {
  const proxy = session?.mode === 'proxy';
  const base = proxy ? '/ui/api/v1' : '/api/v1';
  const headers = { ...H };
  if (!proxy) headers.Authorization = `Bearer ${getToken()}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try { res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { const err = new Error('network'); err.network = true; throw err; }
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json || {}, requestId: res.headers.get('X-Request-Id') || json?.requestId || '' };
}
/** Demo tools only exist in proxy mode. */
export async function demo(path, body) {
  const res = await fetch('/ui/api/' + path, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = {}; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}
export async function facts(plotId) {
  if (session?.mode !== 'proxy') return null;
  const res = await fetch(`/ui/api/facts/${plotId}`, { headers: H });
  if (!res.ok) return null;
  return (await res.json()).facts || null;
}
export const FRESH_MINUTES = 15;
