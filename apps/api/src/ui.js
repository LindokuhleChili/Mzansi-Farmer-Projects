// Web UI for the farmer app: static files from apps/web/public, plus a small LOCAL-ONLY proxy (/ui/api/*) so the browser never holds a token.
//
// Security model (see docs/UI.md):
//  - The browser never sees APP_TOKEN, any device token or the AI key. Requests to /ui/api/* are re-issued inside the API process
//    (app.inject) with the server's own APP_TOKEN, so every rule, confirmation gate and audit write of /api/v1 still applies.
//  - /ui/api/* only answers loopback clients (127.0.0.1 / ::1) with a localhost Host header and an X-Requested-With header
//    (blocks cross-site requests and DNS rebinding). UI_ALLOW_REMOTE=1 lifts the loopback check only (Host + header checks stay).
//  - A client that is not allowed gets 403 UI_LOCAL_ONLY; the UI then offers to paste an APP_TOKEN (kept in sessionStorage only)
//    and talks to /api/v1 directly. Demo tools (simulated sensor reading, AI behaviour) are not available that way.
//  - The simulated reading uses the device token of the plot's registered device on the server side; the token is never sent out.
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../../web/public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const PROXY_PATH = /^(plots|suggestions|audit|market|translate|farms|forecast|alerts|alert-thresholds|doctor)(\/[A-Za-z0-9_-]+)*$/;   // never /readings (device ingestion) and never /health
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const isLoopback = (ip = '') => ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.');
export const AI_DEMO_BEHAVIOURS = ['normal', 'greedy'];

export function registerUi(app, { config, oe, provider, clock, oeCall, fail }) {
  // ---- static files (no directory listing, no path traversal, only files under apps/web/public)
  async function sendFile(reply, rel) {
    const clean = normalize(rel).replace(/^([/\\])+/, '');
    const full = join(PUBLIC_DIR, clean);
    if (clean.split(sep).includes('..') || !full.startsWith(PUBLIC_DIR)) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Unknown route.', requestId: reply.request.id });
    try {
      const st = await stat(full);
      if (!st.isFile()) throw new Error('not a file');
      const body = await readFile(full);
      const ext = extname(full).toLowerCase();
      reply.header('Content-Type', TYPES[ext] || 'application/octet-stream').header('Cache-Control', ['.jpg', '.jpeg', '.woff2', '.ttf'].includes(ext) ? 'public, max-age=86400' : 'no-cache');
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
      return reply.send(body);
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Unknown route.', requestId: reply.request.id });
    }
  }
  app.get('/', (req, reply) => sendFile(reply, 'index.html'));
  app.get('/assets/*', (req, reply) => sendFile(reply, 'assets/' + req.params['*']));
  app.get('/favicon.svg', (req, reply) => sendFile(reply, 'assets/favicon.svg'));
  app.get('/favicon.ico', (req, reply) => reply.code(204).send());

  // ---- local-only guard for /ui/*
  function guard(req, reply) {
    const host = req.headers.host || '';
    if (!LOCAL_HOST.test(host) && !config.uiAllowRemote) { fail(reply, req, 403, 'UI_LOCAL_ONLY', 'The demo proxy only answers requests addressed to localhost.'); return false; }
    if (!config.uiAllowRemote && !isLoopback(req.ip)) { fail(reply, req, 403, 'UI_LOCAL_ONLY', 'The demo proxy only answers requests from this computer. Paste the app token instead.'); return false; }
    if (req.headers['x-requested-with'] !== 'mzansi-ui') { fail(reply, req, 403, 'UI_HEADER_REQUIRED', 'Missing X-Requested-With header.'); return false; }
    return true;
  }
  // Used by the session probe: same checks, but reports instead of failing.
  const allowed = (req) => {
    const host = req.headers.host || '';
    return (LOCAL_HOST.test(host) || config.uiAllowRemote) && (isLoopback(req.ip) || config.uiAllowRemote) && req.headers['x-requested-with'] === 'mzansi-ui';
  };

  // Tells the UI how to authenticate and which demo tools exist. Never returns a token.
  app.get('/ui/session', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ok = allowed(req);
    return {
      mode: ok ? 'proxy' : 'token',
      oeMode: oe.mode, aiProvider: provider.name,
      demo: ok ? {
        simulateReadingPlots: config.registry.map((d) => d.plotId),
        devices: config.registry.map((d) => ({ deviceId: d.deviceId, plotId: d.plotId })),
        aiBehaviour: provider.name === 'mock' ? { current: provider.behaviour || 'normal', options: AI_DEMO_BEHAVIOURS } : null,
      } : null,
    };
  });

  const inject = (opts) => app.inject(opts);
  const relay = (reply, res) => {
    reply.code(res.statusCode).type('application/json; charset=utf-8').header('Cache-Control', 'no-store');
    if (res.headers['x-request-id']) reply.header('X-Request-Id', res.headers['x-request-id']);
    return reply.send(res.body);
  };

  // ---- proxy to /api/v1 with the server-side app token (GET, POST, DELETE on plots / suggestions / audit / market only)
  app.route({
    method: ['GET', 'POST', 'DELETE'], url: '/ui/api/v1/*', bodyLimit: 12 * 1024 * 1024,   // plant doctor photos
    handler: async (req, reply) => {
      if (!guard(req, reply)) return;
      const rest = req.params['*'];
      if (!PROXY_PATH.test(rest)) return fail(reply, req, 404, 'NOT_FOUND', 'Unknown route.');
      const qs = req.raw.url.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
      const res = await inject({
        method: req.method, url: `/api/v1/${rest}${qs}`,
        headers: { authorization: `Bearer ${config.appToken}`, 'content-type': 'application/json', 'x-forwarded-by': 'mzansi-ui' },
        ...(req.method === 'GET' ? {} : { payload: JSON.stringify(req.body ?? {}) }),
      });
      return relay(reply, res);
    },
  });

  // ---- numbers from OpenEdge for a plot right now (used by the rule-check table of a suggestion opened later)
  app.get('/ui/api/facts/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    if (!/^\d+$/.test(req.params.id)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'plotId must be an integer.', { field: 'plotId' });
    const r = await oeCall(req, 'ui.get_facts', 'POST', '/farm/validate', { plotId: Number(req.params.id), action: 'hold', litres: 0, asOf: clock().toISOString() }, (x) => ({ status: x.status }));
    reply.header('Cache-Control', 'no-store');
    return reply.code(r.status).send(r.status < 400 ? { facts: r.body.facts } : { ...r.body, requestId: req.id });
  });

  // ---- demo tool: post a simulated sensor reading as the plot's registered device (token stays on the server)
  app.post('/ui/api/demo/reading', async (req, reply) => {
    if (!guard(req, reply)) return;
    const b = req.body || {};
    const dev = Number.isInteger(b.plotId) ? config.registry.find((d) => d.plotId === b.plotId) : null;
    if (!dev) return fail(reply, req, 404, 'NO_DEVICE_FOR_PLOT', 'No sensor device is registered for this plot (see DEVICE_REGISTRY in .env).', { field: 'plotId' });
    let res;
    for (let bump = 0; bump < 3; bump++) {   // same device + second is a duplicate (409): move one second on
      const ts = new Date(clock().getTime() + bump * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
      res = await inject({
        method: 'POST', url: '/api/v1/readings',
        headers: { 'x-device-token': dev.token, 'content-type': 'application/json', 'x-forwarded-by': 'mzansi-ui' },
        payload: JSON.stringify({ deviceId: dev.deviceId, plotId: dev.plotId, timestamp: ts, soilMoisturePct: b.soilMoisturePct, temperatureC: b.temperatureC, humidityPct: b.humidityPct, raining: b.raining === true }),
      });
      if (res.statusCode !== 409) break;
    }
    return relay(reply, res);
  });

  // ---- demo tool (mock AI only): make the stand-in AI over-eager so the rules visibly say no
  app.post('/ui/api/demo/ai-behaviour', async (req, reply) => {
    if (!guard(req, reply)) return;
    if (provider.name !== 'mock') return fail(reply, req, 409, 'NOT_MOCK_AI', 'Only the mock AI can be switched. The real model is not controlled from the UI.');
    const v = req.body && req.body.behaviour;
    if (!AI_DEMO_BEHAVIOURS.includes(v)) return fail(reply, req, 400, 'VALIDATION_ERROR', `behaviour must be one of: ${AI_DEMO_BEHAVIOURS.join(', ')}.`, { field: 'behaviour' });
    provider.behaviour = v;
    return { behaviour: v };
  });
}
