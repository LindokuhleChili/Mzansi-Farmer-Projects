// Fastify app: /api/v1. AI proposes -> OpenEdge (ABL) rules validate -> farmer approves with an explicit confirmation step.
import Fastify from 'fastify';
import crypto from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { OeError } from './oe/client.js';
import { proposeAction, computeInsight } from './ai/advise.js';
import { CONFIRM_TTL_SECONDS, FUTURE_SKEW_MINUTES, READINGS_FOR_AI, AUDIT_TIMEOUT_MS } from './config.js';
import { isValidIsoTimestamp } from './iso.js';
import { registerUi } from './ui.js';
import { createTranslator, validateTranslateBody } from './ai/translate.js';

const PREFIX = '/api/v1';
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function buildApp({ config, oe, provider, clock = () => new Date() }) {
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

  return app;
}
