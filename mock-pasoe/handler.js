// mock-pasoe: implements the OpenEdge REST contract (docs/OE-CONTRACT.md) in Node, with the same rules as farm-api.p.
// handle(store, method, pathWithQuery, body, clock) -> { status, body }
import { validate } from './rules.js';
import { parseIso, iso } from './time.js';
import { handleCoop } from './coop-handler.js';

const err = (status, error, message, field) => ({ status, body: { error, message, ...(field ? { field } : {}) } });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';

function plotJson(p) {
  return { plotId: p.plotId, farmId: p.farmId, plotName: p.plotName, crop: p.crop, areaHa: p.areaHa,
    maxIrrigationLitres: p.maxIrrigationLitres, dryThresholdPct: p.dryThresholdPct, weeklyWaterBudgetL: p.weeklyWaterBudgetL };
}
function suggJson(s) {
  return { suggestionId: s.suggestionId, plotId: s.plotId, action: s.action, litres: s.litres, reason: s.reason, provider: s.provider,
    status: s.status, verdict: s.verdict, rejectReasons: s.rejectReasons, createdAt: iso(s.createdAt), decidedAt: iso(s.decidedAt), requestId: s.requestId };
}
function addAudit(store, requestId, actor, event, detail, at) {
  const row = { auditId: ++store.seq.audit, at, requestId: requestId || '', actor: actor || 'api', event, detail: detail || '' };
  store.audit.push(row);
  return row;
}
function parseAsOf(body, clock) {
  if (body.asOf === undefined) return { asOf: clock() };
  const d = isStr(body.asOf) ? parseIso(body.asOf) : null;
  return d ? { asOf: d } : { error: err(400, 'VALIDATION_ERROR', 'asOf must be ISO 8601 UTC.', 'asOf') };
}
function parseValidateInput(body, clock) {
  if (!isNum(body.plotId) || !Number.isInteger(body.plotId)) return { error: err(400, 'VALIDATION_ERROR', 'plotId must be an integer.', 'plotId') };
  if (!isStr(body.action)) return { error: err(400, 'VALIDATION_ERROR', 'action must be a string.', 'action') };
  let litres = 0;
  if (body.litres !== undefined) {
    if (!isNum(body.litres)) return { error: err(400, 'VALIDATION_ERROR', 'litres must be a number.', 'litres') };
    litres = body.litres;
  }
  const a = parseAsOf(body, clock);
  if (a.error) return a;
  return { plotId: body.plotId, action: body.action, litres, asOf: a.asOf };
}

export function handle(store, method, pathWithQuery, body = {}, clock = () => new Date()) {
  const [rawPath, query = ''] = pathWithQuery.split('?');
  const q = new URLSearchParams(query);
  let segs = rawPath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segs[0] === 'web') segs = segs.slice(1);
  if (segs[0] === 'farm') segs = segs.slice(1);
  const n = segs.length;
  const idOf = (s) => (/^-?\d+$/.test(s) ? parseInt(s, 10) : NaN);
  const coop = handleCoop(store, method, segs, q, body, clock);   // members, credits, lots, contracts, allocations, payouts
  if (coop) return coop;

  if (method === 'GET') {
    if (n === 1 && segs[0] === 'plots') return { status: 200, body: { plots: [...store.plots].sort((a, b) => a.plotId - b.plotId).map(plotJson) } };
    if (n === 2 && segs[0] === 'plots') {
      const p = store.plots.find((x) => x.plotId === idOf(segs[1]));
      return p ? { status: 200, body: plotJson(p) } : err(404, 'PLOT_NOT_FOUND', `No plot with id ${idOf(segs[1])}.`);
    }
    if (n === 3 && segs[0] === 'plots' && segs[2] === 'readings') {
      const id = idOf(segs[1]);
      if (!store.plots.find((x) => x.plotId === id)) return err(404, 'PLOT_NOT_FOUND', `No plot with id ${id}.`);
      let limit = parseInt(q.get('limit') ?? '20', 10);
      if (!(limit >= 1 && limit <= 500)) limit = 20;
      const rows = store.readings.filter((r) => r.plotId === id).sort((a, b) => b.readAt - a.readAt).slice(0, limit)
        .map((r) => ({ readingId: r.readingId, deviceId: r.deviceId, readAt: iso(r.readAt), soilMoisturePct: r.soilMoisturePct,
          temperatureC: r.temperatureC, humidityPct: r.humidityPct, raining: r.raining }));
      return { status: 200, body: { plotId: id, readings: rows } };
    }
    if (n === 1 && segs[0] === 'suggestions') {
      const st = q.get('status');
      const rows = [...store.suggestions].sort((a, b) => b.suggestionId - a.suggestionId).filter((s) => !st || s.status === st).map(suggJson);
      return { status: 200, body: { suggestions: rows } };
    }
    if (n === 2 && segs[0] === 'suggestions') {
      const s = store.suggestions.find((x) => x.suggestionId === idOf(segs[1]));
      return s ? { status: 200, body: suggJson(s) } : err(404, 'SUGGESTION_NOT_FOUND', `No suggestion with id ${idOf(segs[1])}.`);
    }
    if (n === 1 && segs[0] === 'audit') {
      let limit = parseInt(q.get('limit') ?? '50', 10);
      if (!(limit >= 1 && limit <= 500)) limit = 50;
      const rows = [...store.audit].sort((a, b) => b.auditId - a.auditId).slice(0, limit)
        .map((a) => ({ auditId: a.auditId, at: iso(a.at), requestId: a.requestId, actor: a.actor, event: a.event, detail: a.detail }));
      return { status: 200, body: { events: rows } };
    }
    return err(404, 'NOT_FOUND', 'Unknown route.');
  }

  if (method === 'POST') {
    if (n === 1 && segs[0] === 'readings') return postReading(store, body);
    if (n === 1 && segs[0] === 'validate') {
      const v = parseValidateInput(body, clock);
      return v.error ?? { status: 200, body: validate(store, v) };
    }
    if (n === 1 && segs[0] === 'suggestions') return createSuggestion(store, body, clock);
    if (n === 3 && segs[0] === 'suggestions' && segs[2] === 'decision') return decide(store, idOf(segs[1]), body, clock);
    if (n === 1 && segs[0] === 'audit') {
      if (!isStr(body.event) || body.event === '') return err(400, 'VALIDATION_ERROR', 'event is required.', 'event');
      let detail = '';
      if (body.detail && typeof body.detail === 'object') detail = JSON.stringify(body.detail);
      else if (isStr(body.detail)) detail = body.detail;
      const row = addAudit(store, isStr(body.requestId) ? body.requestId : '', isStr(body.actor) ? body.actor : 'api', body.event, detail.slice(0, 4000), clock());
      return { status: 201, body: { id: row.auditId } };
    }
    return err(404, 'NOT_FOUND', 'Unknown route.');
  }
  return err(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
}

function postReading(store, b) {
  if (!isStr(b.deviceId) || b.deviceId === '' || b.deviceId.length > 40) return err(400, 'VALIDATION_ERROR', 'deviceId must be a string of 1 to 40 characters.', 'deviceId');
  if (!isNum(b.plotId) || !Number.isInteger(b.plotId)) return err(400, 'VALIDATION_ERROR', 'plotId must be an integer.', 'plotId');
  const ts = parseIso(b.timestamp);
  if (!ts) return err(400, 'VALIDATION_ERROR', 'timestamp must be ISO 8601 UTC, e.g. 2026-10-24T08:00:00Z.', 'timestamp');
  if (!isNum(b.soilMoisturePct) || b.soilMoisturePct < 0 || b.soilMoisturePct > 100) return err(400, 'VALIDATION_ERROR', 'soilMoisturePct must be a number between 0 and 100.', 'soilMoisturePct');
  if (!isNum(b.temperatureC) || b.temperatureC < -20 || b.temperatureC > 60) return err(400, 'VALIDATION_ERROR', 'temperatureC must be a number between -20 and 60.', 'temperatureC');
  if (!isNum(b.humidityPct) || b.humidityPct < 0 || b.humidityPct > 100) return err(400, 'VALIDATION_ERROR', 'humidityPct must be a number between 0 and 100.', 'humidityPct');
  if (b.raining !== undefined && typeof b.raining !== 'boolean') return err(400, 'VALIDATION_ERROR', 'raining must be true or false.', 'raining');
  if (!store.plots.find((p) => p.plotId === b.plotId)) return err(404, 'PLOT_NOT_FOUND', `No plot with id ${b.plotId}.`, 'plotId');
  if (store.readings.some((r) => r.deviceId === b.deviceId && r.readAt.getTime() === ts.getTime())) {
    return err(409, 'DUPLICATE_READING', 'A reading for this deviceId and timestamp already exists.', 'timestamp');
  }
  const row = { readingId: ++store.seq.reading, plotId: b.plotId, deviceId: b.deviceId, readAt: ts, soilMoisturePct: b.soilMoisturePct,
    temperatureC: b.temperatureC, humidityPct: b.humidityPct, raining: b.raining === true };
  store.readings.push(row);
  return { status: 201, body: { id: row.readingId } };
}

function createSuggestion(store, b, clock) {
  const v = parseValidateInput(b, clock);
  if (v.error) return v.error;
  const plot = store.plots.find((p) => p.plotId === v.plotId);
  if (!plot) return err(404, 'PLOT_NOT_FOUND', `No plot with id ${v.plotId}.`, 'plotId');
  const res = validate(store, v);
  const ok = res.verdict === 'approved_by_rules';
  const s = { suggestionId: ++store.seq.suggestion, plotId: v.plotId, createdAt: v.asOf, decidedAt: null, action: v.action, litres: Math.trunc(v.litres),
    reason: (isStr(b.reason) ? b.reason : '').slice(0, 1000), provider: isStr(b.provider) ? b.provider : 'unknown',
    status: ok ? 'pending_approval' : 'rejected', verdict: res.verdict, rejectReasons: res.rejectReasons, requestId: isStr(b.requestId) ? b.requestId : '' };
  store.suggestions.push(s);
  addAudit(store, s.requestId, 'abl-rules', 'rule_check', `suggestion ${s.suggestionId} plot ${v.plotId} ${v.action} ${s.litres} L => ${res.verdict}`, v.asOf);
  return { status: 201, body: suggJson(s) };
}

function decide(store, id, b, clock) {
  if (!isStr(b.decision) || !['approve', 'reject', 'delete'].includes(b.decision)) return err(400, 'VALIDATION_ERROR', 'decision must be approve, reject or delete.', 'decision');
  const actor = isStr(b.actor) ? b.actor : 'farmer';
  const requestId = isStr(b.requestId) ? b.requestId : '';
  const a = parseAsOf(b, clock);
  if (a.error) return a.error;
  const asOf = a.asOf;
  const s = store.suggestions.find((x) => x.suggestionId === id);
  if (!s) return err(404, 'SUGGESTION_NOT_FOUND', `No suggestion with id ${id}.`);
  let event;
  if (b.decision === 'approve') {
    if (s.status === 'rejected') return err(409, 'NOT_APPROVABLE', 'This suggestion was rejected by the rules and cannot be approved.');
    if (s.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Suggestion is already ${s.status}.`);
    const res = validate(store, { plotId: s.plotId, action: s.action, litres: s.litres, asOf });
    if (res.verdict !== 'approved_by_rules') {
      Object.assign(s, { status: 'rejected', verdict: 'rejected_by_rules', rejectReasons: res.rejectReasons, decidedAt: asOf });
      addAudit(store, requestId, actor, 'approve_blocked_by_rules', `suggestion ${id}`, asOf);
      return { status: 409, body: { ...suggJson(s), error: 'NOT_APPROVABLE' } };
    }
    Object.assign(s, { status: 'approved', decidedAt: asOf });
    event = 'suggestion_approved';
  } else if (b.decision === 'reject') {
    if (s.status !== 'pending_approval') return err(409, 'ALREADY_DECIDED', `Suggestion is already ${s.status}.`);
    Object.assign(s, { status: 'declined', decidedAt: asOf });
    event = 'suggestion_declined';
  } else {
    if (s.status === 'approved') return err(409, 'CANNOT_DELETE_APPROVED', 'Approved suggestions count against the water budget and cannot be deleted.');
    if (s.status === 'deleted') return err(409, 'ALREADY_DECIDED', 'Suggestion is already deleted.');
    Object.assign(s, { status: 'deleted', decidedAt: asOf });
    event = 'suggestion_deleted';
  }
  addAudit(store, requestId, actor, event, `suggestion ${id}`, asOf);
  return { status: 200, body: suggJson(s) };
}
