// Fastify app: /api/v1. AI proposes -> OpenEdge (ABL) rules validate -> farmer approves with an explicit confirmation step.
import { fetchOpenMeteo, PROVINCE_COORDS } from './weather/open-meteo.js';
import Fastify from 'fastify';
import { checkDoctorAnswer, fallbackAnswer, checkPhotos, checkMeta, DOSE_QUANTITY } from './ai/doctor.js';
import { formatVector, loadAndRank, similarPayload } from './ai/similar.js';
import crypto from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { OeError } from './oe/client.js';
import { proposeAction, computeInsight } from './ai/advise.js';
import { CONFIRM_TTL_SECONDS, FUTURE_SKEW_MINUTES, READINGS_FOR_AI, AUDIT_TIMEOUT_MS } from './config.js';
import { isValidIsoTimestamp } from './iso.js';
import { registerUi } from './ui.js';
import { createTranslator, validateTranslateBody } from './ai/translate.js';
import { runTurn } from './assistant/agent.js';
import { createCheckIns } from './assistant/checkins.js';
import { createFarmWatch } from './assistant/watch.js';

const PREFIX = '/api/v1';
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function buildApp({ config, oe, provider, clock = () => new Date(), weatherFetch = globalThis.fetch }) {
  const app = Fastify({ logger: config.logLevel === 'silent' ? false : { level: config.logLevel }, genReqId: () => 'req_' + crypto.randomBytes(4).toString('hex') });
  const confirmations = new Map(); // token -> { suggestionId, action, expiresAt }
  let logFile = null;
  if (config.logDir) { try { mkdirSync(config.logDir, { recursive: true }); logFile = join(config.logDir, 'tool-calls.jsonl'); } catch { /* logging to file is best effort */ } }

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body)); } catch { const e = new Error('Request body is not valid JSON.'); e.statusCode = 400; e.code = 'INVALID_JSON'; done(e); }
  });
  app.addHook('onRequest', async (req, reply) => { reply.header('X-Request-Id', req.id); });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof OeError) return reply.code(error.status).send({ error: error.code, message: error.message, requestId: req.id });
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    return reply.code(status).send({ error: error.code === 'INVALID_JSON' ? 'INVALID_JSON' : status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', message: status === 500 ? 'Unexpected error.' : error.message, requestId: req.id });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'NOT_FOUND', message: 'Unknown route.', requestId: req.id }));

  const fail = (reply, req, status, error, message, extra = {}) => reply.code(status).send({ error, message, ...extra, requestId: req.id });

  // ---- tool-call logging: every call to OpenEdge or the AI is recorded in OpenEdge (AuditLog) and logs/tool-calls.jsonl
  async function tool(req, name, input, fn, summarize = () => undefined) {
    const t0 = Date.now();
    let out, ok = true, errMsg, thrown;
    try { out = await fn(); return out; }
    catch (e) { ok = false; errMsg = e.message; thrown = e; throw e; }
    finally {
      const rec = { at: clock().toISOString(), requestId: req.id, tool: name, input, ok, ms: Date.now() - t0, ...(ok ? { output: summarize(out) } : { error: errMsg }) };
      // If OpenEdge itself just failed (timeout / unreachable), do not try to write the audit row to the same dead server:
      // that doubled the wait (BUG-2). The record still goes to the local log file, flagged as not audited in OpenEdge.
      const oeFailed = !ok && thrown instanceof OeError;
      if (oeFailed) rec.auditSkipped = 'openedge_unavailable';
      if (logFile) { try { appendFileSync(logFile, JSON.stringify(rec) + '\n'); } catch { /* ignore */ } }
      if (!oeFailed) {
        // short timeout so a slow audit write can never hold a request for a full OE_TIMEOUT_MS
        try { await oe.call('POST', '/farm/audit', { requestId: req.id, actor: 'api', event: 'tool_call', detail: { tool: name, input, ok, ms: rec.ms, output: rec.output, error: rec.error } }, { timeoutMs: AUDIT_TIMEOUT_MS }); } catch { /* never fail a request because logging failed */ }
      }
    }
  }
  const oeCall = (req, name, method, path, body, summarize) =>
    tool(req, name, { method, path, ...(body ? { body } : {}) }, () => oe.call(method, path, body, { timeoutMs: config.oeTimeoutMs }), (r) => summarize ? summarize(r) : { status: r.status });

  // ---- auth
  const requireApp = (req, reply) => {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!tok || !safeEqual(tok, config.appToken)) { fail(reply, req, 401, 'UNAUTHORIZED', 'Missing or invalid bearer token.'); return false; }
    return true;
  };
  const deviceFor = (req) => {
    const tok = req.headers['x-device-token'];
    if (!tok) return null;
    return config.registry.find((d) => safeEqual(tok, d.token)) || null;
  };

  app.get('/health', async () => ({ status: 'ok', oeMode: oe.mode, aiProvider: provider.name }));

  // ---- 1. sensor ingestion (device token)
  app.post(`${PREFIX}/readings`, async (req, reply) => {
    const dev = deviceFor(req);
    if (!dev) return fail(reply, req, 401, 'UNAUTHORIZED', 'Missing or unknown X-Device-Token.');
    const b = req.body;
    const bad = (field, message) => fail(reply, req, 400, 'VALIDATION_ERROR', message, { field });
    if (!b || typeof b !== 'object' || Array.isArray(b)) return bad('body', 'Body must be a JSON object.');
    if (typeof b.deviceId !== 'string' || !b.deviceId) return bad('deviceId', 'deviceId must be a non-empty string.');
    if (!Number.isInteger(b.plotId)) return bad('plotId', 'plotId must be an integer.');
    if (!isValidIsoTimestamp(b.timestamp)) return bad('timestamp', 'timestamp must be ISO 8601 UTC, e.g. 2026-10-24T08:00:00Z.');
    const num = (f, lo, hi) => typeof b[f] === 'number' && Number.isFinite(b[f]) && b[f] >= lo && b[f] <= hi;
    if (!num('soilMoisturePct', 0, 100)) return bad('soilMoisturePct', 'soilMoisturePct must be a number between 0 and 100.');
    if (!num('temperatureC', -20, 60)) return bad('temperatureC', 'temperatureC must be a number between -20 and 60.');
    if (!num('humidityPct', 0, 100)) return bad('humidityPct', 'humidityPct must be a number between 0 and 100.');
    if (b.raining !== undefined && typeof b.raining !== 'boolean') return bad('raining', 'raining must be true or false.');
    if (b.deviceId !== dev.deviceId) return fail(reply, req, 400, 'DEVICE_MISMATCH', 'deviceId does not match the device token.', { field: 'deviceId' });
    if (b.plotId !== dev.plotId) return fail(reply, req, 400, 'DEVICE_MISMATCH', 'plotId does not match the device token.', { field: 'plotId' });
    if (Date.parse(b.timestamp) > clock().getTime() + FUTURE_SKEW_MINUTES * 60000) return bad('timestamp', `timestamp is more than ${FUTURE_SKEW_MINUTES} minutes in the future.`);
    const r = await oeCall(req, 'oe.post_reading', 'POST', '/farm/readings',
      { deviceId: b.deviceId, plotId: b.plotId, timestamp: b.timestamp, soilMoisturePct: b.soilMoisturePct, temperatureC: b.temperatureC, humidityPct: b.humidityPct, raining: b.raining === true });
    return reply.code(r.status).send(r.status === 201 ? r.body : { ...r.body, requestId: req.id });
  });

  // ---- 2. reads (app token)
  const passthrough = (name, buildPath) => async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const path = buildPath(req);
    if (!path) return fail(reply, req, 400, 'VALIDATION_ERROR', 'Invalid id.', { field: 'id' });
    const r = await oeCall(req, name, 'GET', path);
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  };
  const intId = (s) => (/^\d+$/.test(s) ? parseInt(s, 10) : null);
  app.get(`${PREFIX}/plots`, passthrough('oe.list_plots', () => '/farm/plots'));
  app.get(`${PREFIX}/plots/:id/readings`, passthrough('oe.get_readings', (req) => { const id = intId(req.params.id); return id === null ? null : `/farm/plots/${id}/readings${req.query.limit ? '?limit=' + encodeURIComponent(req.query.limit) : ''}`; }));
  app.get(`${PREFIX}/suggestions`, passthrough('oe.list_suggestions', (req) => `/farm/suggestions${req.query.status ? '?status=' + encodeURIComponent(req.query.status) : ''}`));
  app.get(`${PREFIX}/suggestions/:id`, passthrough('oe.get_suggestion', (req) => { const id = intId(req.params.id); return id === null ? null : `/farm/suggestions/${id}`; }));
  app.get(`${PREFIX}/audit`, passthrough('oe.list_audit', (req) => `/farm/audit${req.query.limit ? '?limit=' + encodeURIComponent(req.query.limit) : ''}`));
  app.get(`${PREFIX}/audit/verify`, passthrough('oe.verify_audit', () => '/farm/audit/verify'));   // hash chain check (feature 21)

  // ---- 3. advise: AI proposes, ABL validates
  app.post(`${PREFIX}/plots/:id/advise`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const plotId = intId(req.params.id);
    if (plotId === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'plotId must be an integer.', { field: 'plotId' });
    const lang = (req.body && req.body.lang) ?? 'en';
    if (!['en', 'zu'].includes(lang)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'lang must be "en" or "zu".', { field: 'lang' });
    const asOf = clock().toISOString();
    const pr = await oeCall(req, 'oe.get_plot', 'GET', `/farm/plots/${plotId}`);
    if (pr.status !== 200) return reply.code(pr.status).send({ ...pr.body, requestId: req.id });
    const rr = await oeCall(req, 'oe.get_readings', 'GET', `/farm/plots/${plotId}/readings?limit=${READINGS_FOR_AI}`, undefined, (r) => ({ status: r.status, count: r.body.readings?.length }));
    const readings = rr.body.readings || [];
    const vr = await oeCall(req, 'oe.get_facts', 'POST', '/farm/validate', { plotId, action: 'hold', litres: 0, asOf }, (r) => ({ status: r.status, facts: r.body.facts }));
    const facts = vr.body.facts;
    const ctx = { plot: pr.body, latest: readings[0] || null, facts, insight: computeInsight(readings, pr.body.dryThresholdPct) };
    const { proposal, ai } = await tool(req, 'ai.propose', { plotId, lang, provider: provider.name }, () => proposeAction(provider, ctx, lang),
      (o) => ({ action: o.proposal.action, litres: o.proposal.litres, usedFallback: o.ai.usedFallback, fallbackReason: o.ai.fallbackReason }));
    const sr = await oeCall(req, 'oe.create_suggestion', 'POST', '/farm/suggestions',
      { plotId, action: proposal.action, litres: proposal.litres, reason: proposal.reason, provider: ai.usedFallback ? `${provider.name}+fallback` : provider.name, requestId: req.id, asOf },
      (r) => ({ status: r.status, suggestionId: r.body.suggestionId, verdict: r.body.verdict, rejectReasons: (r.body.rejectReasons || []).map((x) => x.code) }));
    if (sr.status !== 201) return reply.code(sr.status).send({ ...sr.body, requestId: req.id });
    const s = sr.body;
    return {
      suggestionId: s.suggestionId, requestId: req.id, status: s.status,
      proposal: { plotId, action: proposal.action, litres: proposal.litres, reason: proposal.reason },
      verdict: s.verdict, rejectReasons: s.rejectReasons,
      facts: { ...facts, trendPctPerHour: ctx.insight.trendPctPerHour, hoursToDryThreshold: ctx.insight.hoursToDryThreshold },
      ai,
      next: s.status === 'pending_approval' ? `POST ${PREFIX}/suggestions/${s.suggestionId}/approve to start the confirmation step` : 'Rejected by the rules; nothing can be approved.',
    };
  });

  // ---- 4. decisions: approve and delete need a confirmation token; reject does not
  async function gated(req, reply, action) {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id);
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const cur = await oeCall(req, 'oe.get_suggestion', 'GET', `/farm/suggestions/${id}`);
    if (cur.status !== 200) return reply.code(cur.status).send({ ...cur.body, requestId: req.id });
    const s = cur.body;
    const token = req.body && req.body.confirmToken;
    if (token === undefined) {
      if (action === 'approve' && s.status === 'rejected') return fail(reply, req, 409, 'NOT_APPROVABLE', 'This suggestion was rejected by the rules and cannot be approved.', { rejectReasons: s.rejectReasons });
      if (action === 'approve' && s.status !== 'pending_approval') return fail(reply, req, 409, 'ALREADY_DECIDED', `Suggestion is already ${s.status}.`);
      if (action === 'delete' && s.status === 'approved') return fail(reply, req, 409, 'CANNOT_DELETE_APPROVED', 'Approved suggestions count against the water budget and cannot be deleted.');
      if (action === 'delete' && s.status === 'deleted') return fail(reply, req, 409, 'ALREADY_DECIDED', 'Suggestion is already deleted.');
      const pl = await oeCall(req, 'oe.get_plot', 'GET', `/farm/plots/${s.plotId}`);
      const plotName = pl.body.plotName || `plot ${s.plotId}`;
      const confirmToken = 'cfm_' + crypto.randomBytes(12).toString('hex');
      confirmations.set(confirmToken, { suggestionId: id, action, expiresAt: clock().getTime() + CONFIRM_TTL_SECONDS * 1000 });
      const summary = action === 'approve' ? `${cap(s.action)} ${plotName}${s.action === 'irrigate' ? ` with ${s.litres} L` : ''}` : `Delete suggestion ${id} for ${plotName}`;
      await tool(req, 'api.request_confirmation', { suggestionId: id, action }, async () => true, () => ({ issued: true }));
      return reply.code(202).send({ error: 'CONFIRMATION_REQUIRED', message: 'Send the same request again with this confirmToken to confirm.', confirmToken, summary, expiresInSeconds: CONFIRM_TTL_SECONDS, requestId: req.id });
    }
    const rec = typeof token === 'string' ? confirmations.get(token) : undefined;
    if (!rec || rec.suggestionId !== id || rec.action !== action || rec.expiresAt < clock().getTime()) {
      return fail(reply, req, 403, 'CONFIRMATION_INVALID', 'The confirmToken is wrong, expired or was already used.');
    }
    confirmations.delete(token); // single use
    const r = await oeCall(req, `oe.${action}_suggestion`, 'POST', `/farm/suggestions/${id}/decision`,
      { decision: action, actor: 'farmer', requestId: req.id, asOf: clock().toISOString() }, (x) => ({ status: x.status, newStatus: x.body.status, rejectReasons: (x.body.rejectReasons || []).map((c) => c.code) }));
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  }
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  app.post(`${PREFIX}/suggestions/:id/approve`, (req, reply) => gated(req, reply, 'approve'));
  app.delete(`${PREFIX}/suggestions/:id`, (req, reply) => gated(req, reply, 'delete'));
  app.post(`${PREFIX}/suggestions/:id/reject`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id);
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const r = await oeCall(req, 'oe.reject_suggestion', 'POST', `/farm/suggestions/${id}/decision`, { decision: 'reject', actor: 'farmer', requestId: req.id, asOf: clock().toISOString() });
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });

  // ---- 5. harvest-day market (docs/MARKET.md): the farmer lists a market day, ABL checks prices and lot stock,
  //         publishing and cancelling need the same two-step confirmation as approving a suggestion
  const qsOf = (req, keys) => {
    const p = keys.filter((k) => req.query[k] !== undefined).map((k) => `${k}=${encodeURIComponent(req.query[k])}`);
    return p.length ? '?' + p.join('&') : '';
  };
  app.get(`${PREFIX}/market/prices`, passthrough('oe.market_prices', () => '/farm/market/prices'));
  app.get(`${PREFIX}/market/events`, passthrough('oe.market_events', (req) => `/farm/market/events${qsOf(req, ['status'])}`));
  app.get(`${PREFIX}/market/events/:id`, passthrough('oe.market_event', (req) => { const id = intId(req.params.id); return id === null ? null : `/farm/market/events/${id}`; }));
  app.get(`${PREFIX}/market/reservations`, passthrough('oe.market_reservations', (req) => `/farm/market/reservations${qsOf(req, ['eventId', 'itemId', 'status'])}`));

  const EVENT_FIELDS = ['farmId', 'eventName', 'venue', 'area', 'notes', 'startsAt', 'endsAt', 'items'];
  const pick = (b, keys) => Object.fromEntries(keys.filter((k) => b && b[k] !== undefined).map((k) => [k, b[k]]));
  const mkSummary = (r) => ({ status: r.status, eventId: r.body.eventId, newStatus: r.body.status, rejectReasons: (r.body.rejectReasons || []).map((x) => x.code) });
  async function saveEvent(req, reply, id) {
    if (!requireApp(req, reply)) return;
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'Body must be a JSON object.', { field: 'body' });
    const path = id === undefined ? '/farm/market/events' : `/farm/market/events/${id}`;
    const r = await oeCall(req, id === undefined ? 'oe.market_create_event' : 'oe.market_edit_event', 'POST', path,
      { ...pick(b, EVENT_FIELDS), actor: 'farmer', requestId: req.id, asOf: clock().toISOString() }, mkSummary);
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  }
  app.post(`${PREFIX}/market/events`, (req, reply) => saveEvent(req, reply, undefined));
  app.post(`${PREFIX}/market/events/:id`, (req, reply) => saveEvent(req, reply, intId(req.params.id)));

  async function marketGated(req, reply, action) {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id);
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const cur = await oeCall(req, 'oe.market_event', 'GET', `/farm/market/events/${id}`);
    if (cur.status !== 200) return reply.code(cur.status).send({ ...cur.body, requestId: req.id });
    const e = cur.body;
    const token = req.body && req.body.confirmToken;
    if (token === undefined) {
      if (action === 'approve' && e.status === 'rejected') return fail(reply, req, 409, 'NOT_APPROVABLE', 'The rules blocked this market day. Change it and save it again.', { rejectReasons: e.rejectReasons });
      if (action === 'approve' && e.status !== 'pending_approval') return fail(reply, req, 409, 'ALREADY_DECIDED', `Market day is already ${e.status}.`);
      if (action === 'cancel' && !['pending_approval', 'published'].includes(e.status)) return fail(reply, req, 409, 'NOT_CANCELLABLE', `A ${e.status} market day cannot be cancelled.`);
      const confirmToken = 'cfm_' + crypto.randomBytes(12).toString('hex');
      confirmations.set(confirmToken, { marketEventId: id, action, expiresAt: clock().getTime() + CONFIRM_TTL_SECONDS * 1000 });
      const summary = action === 'approve'
        ? `Publish ${e.eventName} at ${e.venue} (${e.items.length} item(s), ${e.totalKg} kg)`
        : `Cancel ${e.eventName}${e.reservedKg ? ` and its reservations (${e.reservedKg} kg)` : ''}`;
      await tool(req, 'api.request_confirmation', { marketEventId: id, action }, async () => true, () => ({ issued: true }));
      return reply.code(202).send({ error: 'CONFIRMATION_REQUIRED', message: 'Send the same request again with this confirmToken to confirm.', confirmToken, summary, expiresInSeconds: CONFIRM_TTL_SECONDS, requestId: req.id });
    }
    const rec = typeof token === 'string' ? confirmations.get(token) : undefined;
    if (!rec || rec.marketEventId !== id || rec.action !== action || rec.expiresAt < clock().getTime()) {
      return fail(reply, req, 403, 'CONFIRMATION_INVALID', 'The confirmToken is wrong, expired or was already used.');
    }
    confirmations.delete(token);
    const r = await oeCall(req, `oe.market_${action}_event`, 'POST', `/farm/market/events/${id}/decision`,
      { decision: action, actor: 'farmer', requestId: req.id, asOf: clock().toISOString() }, mkSummary);
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  }
  app.post(`${PREFIX}/market/events/:id/publish`, (req, reply) => marketGated(req, reply, 'approve'));
  app.post(`${PREFIX}/market/events/:id/cancel`, (req, reply) => marketGated(req, reply, 'cancel'));
  app.post(`${PREFIX}/market/events/:id/decline`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id);
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const r = await oeCall(req, 'oe.market_decline_event', 'POST', `/farm/market/events/${id}/decision`, { decision: 'reject', actor: 'farmer', requestId: req.id, asOf: clock().toISOString() }, mkSummary);
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });
  app.post(`${PREFIX}/market/reservations`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'Body must be a JSON object.', { field: 'body' });
    const r = await oeCall(req, 'oe.market_reserve', 'POST', '/farm/market/reservations',
      { ...pick(b, ['itemId', 'buyerName', 'quantityKg']), actor: 'buyer', requestId: req.id, asOf: clock().toISOString() },
      (x) => ({ status: x.status, reservationId: x.body.reservationId, newStatus: x.body.status, rejectReasons: (x.body.rejectReasons || []).map((c) => c.code) }));
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });
  app.post(`${PREFIX}/market/reservations/:id/cancel`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id);
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const r = await oeCall(req, 'oe.market_cancel_reservation', 'POST', `/farm/market/reservations/${id}/decision`, { decision: 'cancel', actor: 'farmer', requestId: req.id, asOf: clock().toISOString() });
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });

  // ---- 6. weather alerts (docs/WEATHER.md): no AI. ABL compares the synthetic example forecast with the thresholds,
  //      writes WeatherAlert rows and the audit; the farmer acknowledges. Thresholds are validated by OpenEdge.
  app.get(`${PREFIX}/farms/:id`, passthrough('oe.farm', (req) => { const id = intId(req.params.id); return id === null ? null : `/farm/farms/${id}`; }));
  app.get(`${PREFIX}/forecast`, passthrough('oe.forecast', (req) => `/farm/forecast${qsOf(req, ['province'])}`));
  app.get(`${PREFIX}/farms/:id/alerts`, passthrough('oe.weather_alerts', (req) => {
    const id = intId(req.params.id); if (id === null) return null;
    const st = typeof req.query?.status === 'string' ? `&status=${encodeURIComponent(req.query.status)}` : '';
    return `/farm/alerts?farmId=${id}${st}`;
  }));
  // Real forecast: the API fetches Open-Meteo (no key) and OpenEdge validates and stores it. On any failure nothing changes and the
  // answer says so (fallback: true); the page keeps showing the stored forecast with its own label (example or open-meteo).
  app.post(`${PREFIX}/forecast/refresh`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const province = req.body?.province;
    if (typeof province !== 'string' || !PROVINCE_COORDS[province]) return fail(reply, req, 400, 'VALIDATION_ERROR', 'province must be one of the 9 South African provinces.', { field: 'province' });
    if (config.weatherSource === 'example') return reply.send({ province, source: 'example', fallback: false, skipped: true });
    let body;
    try {
      body = await tool(req, 'weather.open_meteo', { province, place: PROVINCE_COORDS[province].place }, () => fetchOpenMeteo(province, { fetchImpl: weatherFetch, timeoutMs: config.weatherTimeoutMs }),
        (x) => ({ baseDate: x.baseDate, days: x.days.length }));
    } catch (e) {
      return reply.send({ province, source: 'stored', fallback: true, reason: e.kind || 'network' });
    }
    const r = await oeCall(req, 'oe.forecast_import', 'POST', '/farm/forecast/import', { ...body, requestId: req.id });
    if (r.status !== 200) return reply.send({ province, source: 'stored', fallback: true, reason: 'rejected_by_openedge', error: r.body?.error, field: r.body?.field });
    return reply.send({ province, source: 'open-meteo', fallback: false, forecast: r.body });
  });
  app.get(`${PREFIX}/alert-thresholds`, passthrough('oe.alert_thresholds', () => '/farm/alert-thresholds'));
  app.post(`${PREFIX}/farms/:id/alerts/refresh`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id);
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const r = await oeCall(req, 'oe.weather_refresh', 'POST', '/farm/alerts/refresh', { farmId: id, requestId: req.id, asOf: clock().toISOString() },
      (x) => ({ status: x.status, created: x.body.created, expired: x.body.expired, noData: x.body.noData }));
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });
  app.post(`${PREFIX}/alerts/:id/acknowledge`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id);
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const r = await oeCall(req, 'oe.weather_ack', 'POST', `/farm/alerts/${id}/ack`, { actor: 'farmer', requestId: req.id, asOf: clock().toISOString() });
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });
  app.post(`${PREFIX}/alert-thresholds/:id`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id);
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'Body must be a JSON object.', { field: 'body' });
    const r = await oeCall(req, 'oe.alert_threshold_save', 'POST', `/farm/alert-thresholds/${id}`, { ...pick(b, ['value', 'level', 'active']), updatedBy: 'farmer', requestId: req.id });
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });

  // ---- 7. plant doctor (docs/DOCTOR.md): photos -> AI proposes -> server check -> OpenEdge DOSE_BLOCKED -> farmer saves or dismisses.
  //      The photos go to the AI only; never to OpenEdge, the logs or the audit (only counts and sizes are logged).
  const DOCTOR_BODY_LIMIT = 12 * 1024 * 1024;
  app.post(`${PREFIX}/doctor/diagnoses`, { bodyLimit: DOCTOR_BODY_LIMIT }, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'Body must be a JSON object.', { field: 'body' });
    const mbad = checkMeta(b);
    if (mbad) return fail(reply, req, 400, 'VALIDATION_ERROR', mbad.message, { field: mbad.field });
    const ph = checkPhotos(b.photos);
    if (!ph.ok) return fail(reply, req, ph.status, ph.code, ph.message, { field: ph.field });
    const meta = { crop: b.crop.trim(), plantPart: b.plantPart, growthStage: b.growthStage, province: b.province, photoCount: ph.photos.length };
    let result = null, fallbackReason = '', removedSteps = 0;
    try {
      const raw = await tool(req, 'ai.diagnose', { ...meta, photoBytes: ph.photos.map((x) => x.bytes), provider: provider.name },
        () => provider.diagnose(meta, ph.photos), (txt) => ({ chars: String(txt || '').length }));
      const c = checkDoctorAnswer(raw);
      if (c.ok) { result = c.result; removedSteps = c.removedSteps; } else { fallbackReason = c.reason; removedSteps = c.removedSteps || 0; }
    } catch (e) { fallbackReason = e.kind === 'timeout' ? 'ai_timeout' : 'ai_unavailable'; }
    // Description embedding is optional and must not change the diagnosis if it fails. The chat model (AI_MODEL) writes
    // a short visual description; a separate text-embedding model turns that description into a vector. No photo pixels are embedded.
    let visual = null;
    if (config.similarCases && typeof provider.describePhotos === 'function' && typeof provider.embedText === 'function') {
      try {
        const line = await tool(req, 'ai.describe_photos', { ...meta, provider: provider.name }, () => provider.describePhotos(meta, ph.photos), (txt) => ({ chars: String(txt || '').length }));
        if (typeof line === 'string' && line.trim() && !DOSE_QUANTITY.test(line)) {
          const emb = await tool(req, 'ai.embed_description', { provider: provider.name, model: config.aiEmbedModel, dim: config.aiEmbedDim }, () => provider.embedText(line), (e) => ({ model: e?.model, dim: e?.vector?.length }));
          const embedVector = formatVector(emb?.vector);
          if (embedVector) visual = { visualText: line.trim().slice(0, 500), embedModel: String(emb.model || config.aiEmbedModel).slice(0, 40), embedVector };
        }
      } catch { visual = null; }
    }
    const send = (res, fb, why) => oeCall(req, 'oe.doctor_create', 'POST', '/farm/doctor/diagnoses',
      { ...meta, result: res, usedFallback: fb, fallbackReason: why, requestId: req.id, ...(visual || {}) }, (x) => ({ status: x.status, diagnosisId: x.body?.diagnosisId, error: x.body?.error }));
    let r = result ? await send(result, false, '') : null;
    if (r && r.status === 422 && r.body?.error === 'DOSE_BLOCKED') fallbackReason = 'dose_blocked';
    else if (r && r.status >= 400) fallbackReason = fallbackReason || 'rejected_by_openedge';
    const blocked = r && r.status === 422 ? r.body.blocked : undefined;
    if (!r || r.status >= 400) r = await send(fallbackAnswer(), true, fallbackReason);
    if (r.status >= 400) return reply.code(r.status).send({ ...r.body, requestId: req.id });
    let similar = { method: 'disabled', compared: 'none', cases: [] };
    if (config.similarCases) {
      try {
        similar = await loadAndRank((method, path, body) => oeCall(req, 'oe.similar_candidates', method, path, body), {
          diagnosisId: r.body.diagnosisId, crop: r.body.crop, condition: r.body.condition, plantPart: r.body.plantPart,
          embedModel: visual?.embedModel || r.body.embedModel || '', embedVector: visual?.embedVector || '', excludeDiagnosisId: r.body.diagnosisId,
        }, { now: clock(), limit: 3 });
      } catch { similar = { method: 'none', compared: 'none', cases: [] }; }
    }
    return reply.code(201).send({ diagnosis: r.body, usedFallback: r.body.usedFallback, fallbackReason: r.body.fallbackReason || null, removedSteps, ...similarPayload(similar), ...(blocked ? { blocked } : {}) });
  });
  app.get(`${PREFIX}/doctor/diagnoses`, passthrough('oe.doctor_list', (req) => `/farm/doctor/diagnoses${qsOf(req, ['limit'])}`));
  app.post(`${PREFIX}/doctor/similar`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    if (!config.similarCases) return { ...similarPayload({ method: 'disabled', compared: 'none', cases: [] }), requestId: req.id };
    const b = req.body;
    if (b !== undefined && b !== null && (typeof b !== 'object' || Array.isArray(b))) return fail(reply, req, 400, 'VALIDATION_ERROR', 'Body must be a JSON object.', { field: 'body' });
    const body = b || {};
    if (body.diagnosisId !== undefined && !Number.isInteger(body.diagnosisId)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'diagnosisId must be an integer.', { field: 'diagnosisId' });
    if (body.crop !== undefined && typeof body.crop !== 'string') return fail(reply, req, 400, 'VALIDATION_ERROR', 'crop must be a string.', { field: 'crop' });
    if (body.condition !== undefined && typeof body.condition !== 'string') return fail(reply, req, 400, 'VALIDATION_ERROR', 'condition must be a string.', { field: 'condition' });
    try {
      const similar = await loadAndRank((method, path, pBody) => oeCall(req, 'oe.similar_candidates', method, path, pBody), {
        diagnosisId: body.diagnosisId, crop: body.crop || '', condition: body.condition || '', plantPart: typeof body.plantPart === 'string' ? body.plantPart : '',
        excludeDiagnosisId: body.diagnosisId,
      }, { now: clock(), limit: body.limit });
      return { ...similarPayload(similar), requestId: req.id };
    } catch {
      return { ...similarPayload({ method: 'none', compared: 'none', cases: [] }), requestId: req.id };
    }
  });
  app.get(`${PREFIX}/doctor/diagnoses/:id`, passthrough('oe.doctor_get', (req) => { const id = intId(req.params.id); return id === null ? null : `/farm/doctor/diagnoses/${id}`; }));
  for (const [act, decision] of [['save', 'save'], ['dismiss', 'dismiss']]) {
    app.post(`${PREFIX}/doctor/diagnoses/:id/${act}`, async (req, reply) => {
      if (!requireApp(req, reply)) return;
      const id = intId(req.params.id);
      if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
      const r = await oeCall(req, `oe.doctor_${act}`, 'POST', `/farm/doctor/diagnoses/${id}/decision`, { decision, actor: 'farmer', requestId: req.id });
      return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
    });
  }
  // admin-editable no-doses word list (the BlockedTerm table)
  app.get(`${PREFIX}/doctor/blocked-terms`, passthrough('oe.blocked_terms', () => '/farm/doctor/blocked-terms'));
  app.post(`${PREFIX}/doctor/blocked-terms`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const b = req.body || {};
    const r = await oeCall(req, 'oe.blocked_term_add', 'POST', '/farm/doctor/blocked-terms', { ...pick(b, ['term', 'kind']), updatedBy: 'admin', requestId: req.id });
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });
  app.post(`${PREFIX}/doctor/blocked-terms/:id`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id);
    if (id === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'id must be an integer.', { field: 'id' });
    const r = await oeCall(req, 'oe.blocked_term_save', 'POST', `/farm/doctor/blocked-terms/${id}`, { ...pick(req.body || {}, ['active']), updatedBy: 'admin', requestId: req.id });
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });

  // ---- dynamic AI translation (English -> one of the 11 official languages). Never fails because the AI failed: English is returned.
  const translator = createTranslator(provider, { log: (rec) => {
    if (logFile) { try { appendFileSync(logFile, JSON.stringify({ at: clock().toISOString(), ...rec }) + '\n'); } catch { /* ignore */ } }
    if (rec.rejectedByNumberCheck || !rec.ok) app.log.warn(rec, 'translation batch');
  } });
  app.post(`${PREFIX}/translate`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const bad = validateTranslateBody(req.body);
    if (bad) return fail(reply, req, 400, 'VALIDATION_ERROR', bad.message, { field: bad.field });
    const { texts, target } = req.body;
    const r = await translator.translate(texts, target);
    return { target, provider: provider.name, fallback: r.fallback, translations: r.translations, requestId: req.id };
  });

  if (config.uiEnabled) registerUi(app, { config, oe, provider, clock, oeCall, fail });

  // ---- 9. Farm Assistant (docs/ASSISTANT.md): chat turn -> tool loop (AI or offline planner) -> case file in OpenEdge
  //      (ABL: CITATION_UNKNOWN, DOSE_BLOCKED) -> approval cards. Nothing changes until the farmer approves.
  const ASSIST_LANGS = ['en', 'af', 'nr', 'xh', 'zu', 'nso', 'st', 'tn', 'ss', 've', 'ts'];
  const asCall = (req) => (name, method, path, body) => oeCall(req, name, method, path, body);
  app.post(`${PREFIX}/assistant/chat`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'Body must be a JSON object.', { field: 'body' });
    if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 1000) return fail(reply, req, 400, 'VALIDATION_ERROR', 'message must be 1 to 1000 characters.', { field: 'message' });
    const lang = b.lang ?? 'en';
    if (!ASSIST_LANGS.includes(lang)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'lang must be one of the 11 official language codes.', { field: 'lang' });
    if (b.plotId !== undefined && b.plotId !== null && !Number.isInteger(b.plotId)) return fail(reply, req, 400, 'VALIDATION_ERROR', 'plotId must be an integer.', { field: 'plotId' });
    const history = Array.isArray(b.history) ? b.history.filter((h) => h && typeof h.text === 'string').slice(-6) : [];
    const out = await tool(req, 'assistant.turn', { chars: b.message.length, lang, provider: provider.name },
      () => runTurn({ call: asCall(req), provider, clock, requestId: req.id }, { message: b.message.trim(), lang, plotId: b.plotId ?? undefined, history }),
      (o) => ({ caseId: o.case?.caseId ?? null, steps: o.steps.length, cards: o.cards.length, usedFallback: o.usedFallback, fallbackReason: o.fallbackReason || undefined }));
    return { ack: 'Let me check your farm.', ...out, requestId: req.id };
  });
  app.get(`${PREFIX}/assistant/cases`, passthrough('oe.assistant_cases', (req) => `/farm/assistant/cases${qsOf(req, ['status', 'limit'])}`));
  app.get(`${PREFIX}/assistant/cases/:id`, passthrough('oe.assistant_case', (req) => { const id = intId(req.params.id); return id === null ? null : `/farm/assistant/cases/${id}`; }));
  for (const [act, decision] of [['accept', 'accept'], ['decline', 'decline']]) {
    app.post(`${PREFIX}/assistant/cases/:id/actions/:n/${act}`, async (req, reply) => {
      if (!requireApp(req, reply)) return;
      const id = intId(req.params.id), n = intId(req.params.n);
      if (id === null || n === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'Invalid id.', { field: 'id' });
      const r = await oeCall(req, `oe.assistant_action_${act}`, 'POST', `/farm/assistant/cases/${id}/actions/${n}/decision`, { decision, actor: 'farmer', requestId: req.id });
      return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
    });
  }
  app.post(`${PREFIX}/assistant/cases/:id/follow-ups/:fid/answer`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const id = intId(req.params.id), fid = intId(req.params.fid);
    if (id === null || fid === null) return fail(reply, req, 400, 'VALIDATION_ERROR', 'Invalid id.', { field: 'id' });
    const r = await oeCall(req, 'oe.assistant_followup', 'POST', `/farm/assistant/cases/${id}/follow-ups/${fid}/answer`, { ...pick(req.body || {}, ['answer', 'resolved', 'nextInDays']), actor: 'farmer', requestId: req.id });
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });
  app.get(`${PREFIX}/assistant/memory`, passthrough('oe.assistant_memory', () => '/farm/assistant/memory?farmId=1'));
  app.post(`${PREFIX}/assistant/memory`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const r = await oeCall(req, 'oe.assistant_memory_save', 'POST', '/farm/assistant/memory', { ...pick(req.body || {}, ['key', 'value']), farmId: 1, actor: 'farmer', requestId: req.id });
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });
  app.post(`${PREFIX}/guide/search`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const r = await oeCall(req, 'oe.guide_search', 'POST', '/farm/guide/search', pick(req.body || {}, ['q', 'limit']));
    return reply.code(r.status).send(r.status < 400 ? r.body : { ...r.body, requestId: req.id });
  });
  // proactive check-ins: the job itself is started by index.js (ASSISTANT_CHECKIN_MS); tests call app.checkIns.run()
  const checkInReq = { id: 'checkin' };
  app.checkIns = createCheckIns({ call: (name, method, path, body) => oeCall(checkInReq, name, method, path, body), clock });
  // Farm watch: off on a schedule unless FARM_WATCH_INTERVAL_MIN is set. This route is the on-demand demo trigger.
  // It always uses the offline planner (see assistant/watch.js) so a missing key does not change the result.
  app.farmWatch = createFarmWatch({
    callFor: (requestId) => (name, method, path, body) => oeCall({ id: requestId }, name, method, path, body),
    provider, clock, dedupeHours: config.farmWatchDedupeHours,
  });
  app.post(`${PREFIX}/assistant/watch/run`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const out = await tool(req, 'assistant.watch', { trigger: 'manual' }, () => app.farmWatch.run(req.id),
      (o) => ({ ok: o.ok, opened: o.opened?.length || 0, skipped: o.skipped?.length || 0, issues: o.issues?.length || 0 }));
    return { ...out, requestId: req.id };
  });
  app.get(`${PREFIX}/assistant/check-ins`, async (req, reply) => {
    if (!requireApp(req, reply)) return;
    const after = intId(String(req.query.after ?? '0')) ?? 0;
    return { messages: app.checkIns.list(after) };
  });

  return app;
}
