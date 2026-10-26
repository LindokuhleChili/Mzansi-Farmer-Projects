// OpenEdge client. Two interchangeable implementations of the same REST contract (docs/OE-CONTRACT.md):
//   mock  -> mock-pasoe running in-process (Node port of the ABL rules)
//   pasoe -> HTTP calls to a real PAS for OpenEdge instance running openedge/src/farm-api.p behind web/FarmHandler.cls
import { createStore } from '../../../../mock-pasoe/store.js';
import { handle } from '../../../../mock-pasoe/handler.js';
import { OE_TIMEOUT_MS } from '../config.js';

// Admin-only PASOE routes (ABL answers 403 FORBIDDEN_ROLE without ROLE_PSCAdmin). Same list as fIsAdminRoute in farm-api.p.
export function isAdminRoute(method, path) {
  const p = String(path).split('?')[0].replace(/^\/+|\/+$/g, '').replace(/^web\//, '').replace(/^farm\/?/, '');
  return String(method).toUpperCase() === 'POST' && (p === 'doctor/blocked-terms' || p.startsWith('doctor/blocked-terms/') || p.startsWith('alert-thresholds/'));
}
const basic = (cred) => 'Basic ' + Buffer.from(cred).toString('base64');

export class OeError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = code === 'OE_TIMEOUT' ? 504 : 502; }
}

export function createOeClient(config, { clock = () => new Date() } = {}) {
  if (config.oeMode === 'mock') {
    const store = createStore();
    return {
      mode: 'mock', store,
      async call(method, path, body) {
        const r = handle(store, method, path, body ?? {}, clock);
        return { status: r.status, body: JSON.parse(JSON.stringify(r.body)) };
      },
    };
  }
  const base = config.oeBaseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (config.oeAuth) headers.Authorization = basic(config.oeAuth);
  const adminHeaders = config.oeAdminAuth ? { ...headers, Authorization: basic(config.oeAdminAuth) } : headers;
  return {
    mode: 'pasoe',
    async call(method, path, body, { timeoutMs = OE_TIMEOUT_MS } = {}) {
      const url = base + (path.startsWith('/farm') ? path : '/farm' + path);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method, headers: isAdminRoute(method, path) ? adminHeaders : headers, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body), signal: ctl.signal });
        const text = await res.text();
        let parsed;
        try { parsed = text ? JSON.parse(text) : {}; } catch { throw new OeError('OE_UNAVAILABLE', `OpenEdge returned non-JSON (HTTP ${res.status})`); }
        return { status: res.status, body: parsed };
      } catch (e) {
        if (e instanceof OeError) throw e;
        if (e.name === 'AbortError') throw new OeError('OE_TIMEOUT', `OpenEdge did not answer within ${timeoutMs} ms`);
        throw new OeError('OE_UNAVAILABLE', `OpenEdge not reachable: ${e.cause?.code || e.message}`);
      } finally { clearTimeout(timer); }
    },
  };
}
