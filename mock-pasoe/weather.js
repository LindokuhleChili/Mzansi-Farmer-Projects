// Weather alerts (feature 17): same rules as openedge/src/weather.i. No AI: alerts and their wording come from OpenEdge data.
// Forecast rows are FICTIONAL EXAMPLE DATA (openedge/data/weather-seed.json, from the synthetic forecast CSV).
import { readFileSync } from 'node:fs';
import { iso } from './time.js';
import { appendAudit } from './audit-chain.js';   // hash chain (feature 21)

const WEATHER_SEED_PATH = new URL('../openedge/data/weather-seed.json', import.meta.url);
const LEVELS = ['watch', 'warning', 'severe'];
const TYPES = { rain: { unit: 'mm', field: 'rainMm', label: 'Heavy rain' }, heat: { unit: 'C', field: 'tempMaxC', label: 'Heat' }, frost: { unit: 'C', field: 'tempMinC', label: 'Frost' } };
const err = (status, error, message, field) => ({ status, body: { error, message, ...(field ? { field } : {}) } });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const oneDec = (v) => isNum(v) && Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
export const alertMessage = (type, dayNo, value) => `${TYPES[type].label} Day ${dayNo}, ${f1(value)} ${TYPES[type].unit}`;

export function loadWeatherSeed(store, path = WEATHER_SEED_PATH) {
  const w = JSON.parse(readFileSync(path, 'utf8'));
  store.forecast = []; store.thresholds = []; store.alerts = [];
  store.seq.forecast = 0; store.seq.threshold = 0; store.seq.alert = 0;
  for (const f of w.farms) {
    let farm = store.farms.find((x) => x.farmId === f.farmId);
    if (!farm) { farm = { farmId: f.farmId, farmName: f.farmName, location: f.location, acreage: f.acreage }; store.farms.push(farm); }
    farm.province = f.province || '';
  }
  for (const t of w.thresholds) store.thresholds.push({ thresholdId: ++store.seq.threshold, ...t, active: true, updatedAt: null, updatedBy: 'seed' });
  for (const r of w.forecast) store.forecast.push({ forecastId: ++store.seq.forecast, province: r.province, baseDate: w.baseDate, dayNo: r.dayNo,
    forecastDate: addDays(w.baseDate, r.dayNo - 1), tempMaxC: r.tempMaxC, tempMinC: r.tempMinC, rainMm: r.rainMm, isSynthetic: true, source: 'example' });
}

const provinceDays = (s, province) => {
  const rows = s.forecast.filter((f) => f.province === province);
  if (!rows.length) return [];
  const base = rows.map((r) => r.baseDate).sort().at(-1);
  return rows.filter((r) => r.baseDate === base).sort((a, b) => a.dayNo - b.dayNo);
};
const hits = (op, v, th) => (op === '>=' ? v >= th - 1e-9 : v <= th + 1e-9);
/** For each day and alert type, the highest level whose active threshold the forecast meets. */
export function matchAlerts(days, thresholds) {
  const out = [];
  for (const d of days) for (const type of Object.keys(TYPES)) {
    const v = d[TYPES[type].field];
    let best = null;
    for (const t of thresholds) if (t.active && t.alertType === type && hits(t.op, v, t.value) && (!best || LEVELS.indexOf(t.level) > LEVELS.indexOf(best.level))) best = t;
    if (best) out.push({ type, day: d, value: v, level: best.level });
  }
  return out;
}
const alertJson = (a) => ({ alertId: a.alertId, farmId: a.farmId, province: a.province, alertType: a.alertType, dayNo: a.dayNo, forecastDate: a.forecastDate,
  value: a.value, unit: a.unit, level: a.level, message: a.message, status: a.status, createdAt: iso(a.createdAt), ackedAt: iso(a.ackedAt) });
const thJson = (t) => ({ thresholdId: t.thresholdId, alertType: t.alertType, op: t.op, value: t.value, unit: t.unit, level: t.level, active: t.active, updatedAt: iso(t.updatedAt), updatedBy: t.updatedBy });
const openAlerts = (s, farmId) => s.alerts.filter((a) => a.farmId === farmId && a.status === 'open').sort((a, b) => (a.forecastDate < b.forecastDate ? -1 : a.forecastDate > b.forecastDate ? 1 : a.alertType < b.alertType ? -1 : 1));

const PROVINCES = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'];
const r1 = (v) => Math.round(v * 10) / 10;
function forecastJson(s, province) {
  const days = provinceDays(s, province);
  return { province, baseDate: days[0]?.baseDate ?? null, isSynthetic: days.length ? days[0].isSynthetic : true, source: days.length ? (days[0].source || 'example') : 'example',
    noData: days.length === 0, days: days.map((d) => ({ dayNo: d.dayNo, date: d.forecastDate, tempMaxC: d.tempMaxC, tempMinC: d.tempMinC, rainMm: d.rainMm })) };
}
/** POST /forecast/import: a real forecast (Open-Meteo) fetched by the API; replaces that province's rows for baseDate. Same rules as h-wx-import. */
function importForecast(s, b, clock) {
  const bad = (field, m) => err(400, 'FORECAST_INVALID', m, field);
  if (!PROVINCES.includes(b.province)) return bad('province', 'province must be one of the 9 South African provinces.');
  const okDate = typeof b.baseDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.baseDate) && (() => { try { return addDays(b.baseDate, 0) === b.baseDate; } catch { return false; } })();
  if (!okDate) return bad('baseDate', 'baseDate must be a real date (yyyy-mm-dd).');
  if (typeof b.source !== 'string' || !/^[a-z0-9-]{1,20}$/.test(b.source) || b.source === 'example') return bad('source', "source must be 1 to 20 lower-case letters, digits or '-', and not 'example'.");
  if (!Array.isArray(b.days) || b.days.length !== 7) return bad('days', 'days must be an array of 7 days.');
  for (let i = 0; i < 7; i++) {
    const d = b.days[i], f = (x) => `days[${i}]${x}`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return bad(f(''), `${f('')} is missing or out of range.`);
    if (d.dayNo !== i + 1) return bad(f('.dayNo'), `${f('.dayNo')} is missing or out of range.`);
    if (!isNum(d.tempMaxC) || d.tempMaxC < -30 || d.tempMaxC > 60) return bad(f('.tempMaxC'), `${f('.tempMaxC')} is missing or out of range.`);
    if (!isNum(d.tempMinC) || d.tempMinC < -30 || d.tempMinC > 60 || d.tempMinC > d.tempMaxC) return bad(f('.tempMinC'), `${f('.tempMinC')} is missing or out of range.`);
    if (!isNum(d.rainMm) || d.rainMm < 0 || d.rainMm > 1000) return bad(f('.rainMm'), `${f('.rainMm')} is missing or out of range.`);
  }
  s.forecast = s.forecast.filter((r) => !(r.province === b.province && r.baseDate === b.baseDate));
  b.days.forEach((d, i) => s.forecast.push({ forecastId: ++s.seq.forecast, province: b.province, baseDate: b.baseDate, dayNo: i + 1, forecastDate: addDays(b.baseDate, i),
    tempMaxC: r1(d.tempMaxC), tempMinC: r1(d.tempMinC), rainMm: r1(d.rainMm), isSynthetic: false, source: b.source }));
  appendAudit(s, typeof b.requestId === 'string' ? b.requestId : '', 'api', 'forecast_imported', JSON.stringify({ province: b.province, baseDate: b.baseDate, source: b.source, days: 7 }), clock());
  return { status: 200, body: forecastJson(s, b.province) };
}

export function handleWeather(s, method, segs, q, body, clock) {
  const n = segs.length, idOf = (x) => (/^-?\d+$/.test(x) ? parseInt(x, 10) : NaN);
  if (!s.forecast) return null;
  if (method === 'GET' && n === 2 && segs[0] === 'farms') {
    const f = s.farms.find((x) => x.farmId === idOf(segs[1]));
    return f ? { status: 200, body: { farmId: f.farmId, farmName: f.farmName, location: f.location, province: f.province || '' } } : err(404, 'FARM_NOT_FOUND', `No farm with id ${idOf(segs[1])}.`);
  }
  if (method === 'GET' && n === 1 && segs[0] === 'forecast') {
    const province = q.get('province');
    if (!province) return err(400, 'VALIDATION_ERROR', 'province is required.', 'province');
    const days = provinceDays(s, province);
    return { status: 200, body: forecastJson(s, province) };
  }
  if (method === 'POST' && n === 2 && segs[0] === 'forecast' && segs[1] === 'import') return importForecast(s, body, clock);
  if (method === 'GET' && n === 1 && segs[0] === 'alerts') {
    const farmId = idOf(q.get('farmId') ?? '');
    if (!Number.isInteger(farmId)) return err(400, 'VALIDATION_ERROR', 'farmId is required.', 'farmId');
    const status = q.get('status');
    const rows = s.alerts.filter((a) => a.farmId === farmId && (!status || a.status === status)).sort((a, b) => (a.forecastDate < b.forecastDate ? -1 : a.forecastDate > b.forecastDate ? 1 : a.alertType < b.alertType ? -1 : 1));
    return { status: 200, body: { alerts: rows.map(alertJson) } };
  }
  if (method === 'GET' && n === 1 && segs[0] === 'alert-thresholds') return { status: 200, body: { thresholds: s.thresholds.map(thJson) } };
  if (method === 'POST' && n === 2 && segs[0] === 'alerts' && segs[1] === 'refresh') {
    if (!isNum(body.farmId) || !Number.isInteger(body.farmId)) return err(400, 'VALIDATION_ERROR', 'farmId must be an integer.', 'farmId');
    const farm = s.farms.find((x) => x.farmId === body.farmId);
    if (!farm) return err(404, 'FARM_NOT_FOUND', `No farm with id ${body.farmId}.`);
    const days = provinceDays(s, farm.province || '');
    const now = clock();
    let created = 0, expired = 0;
    const want = days.length ? matchAlerts(days, s.thresholds) : [];
    const keys = new Set(want.map((w) => w.type + '|' + w.day.forecastDate));
    for (const a of s.alerts) if (a.farmId === farm.farmId && a.status === 'open' && !keys.has(a.alertType + '|' + a.forecastDate)) { a.status = 'expired'; expired++; }
    for (const w of want) {
      const ex = s.alerts.find((a) => a.farmId === farm.farmId && a.alertType === w.type && a.forecastDate === w.day.forecastDate);   // unique (FarmId, AlertType, ForecastDate)
      if (ex) { if (ex.status === 'expired') { Object.assign(ex, { status: 'open', level: w.level, value: w.value, message: alertMessage(w.type, w.day.dayNo, w.value), ackedAt: null }); created++; } continue; }
      s.alerts.push({ alertId: ++s.seq.alert, farmId: farm.farmId, province: farm.province, alertType: w.type, dayNo: w.day.dayNo, forecastDate: w.day.forecastDate, value: w.value,
        unit: TYPES[w.type].unit, level: w.level, message: alertMessage(w.type, w.day.dayNo, w.value), status: 'open', createdAt: now, ackedAt: null, requestId: body.requestId || '' });
      created++;
    }
    appendAudit(s, typeof body.requestId === 'string' ? body.requestId : '', 'abl-rules', 'weather_alerts_refreshed', JSON.stringify({ farmId: farm.farmId, province: farm.province, noData: !days.length, created, expired }), now);
    return { status: 200, body: { farmId: farm.farmId, province: farm.province || '', noData: days.length === 0, created, expired, alerts: openAlerts(s, farm.farmId).map(alertJson) } };
  }
  if (method === 'POST' && n === 3 && segs[0] === 'alerts' && segs[2] === 'ack') {
    const a = s.alerts.find((x) => x.alertId === idOf(segs[1]));
    if (!a) return err(404, 'ALERT_NOT_FOUND', `No alert with id ${idOf(segs[1])}.`);
    if (a.status !== 'open') return err(409, 'ALREADY_DECIDED', `Alert ${a.alertId} is already ${a.status}.`);
    a.status = 'acknowledged'; a.ackedAt = clock();
    appendAudit(s, typeof body.requestId === 'string' ? body.requestId : '', typeof body.actor === 'string' ? body.actor : 'farmer', 'weather_alert_acknowledged', JSON.stringify({ alertId: a.alertId }), a.ackedAt);
    return { status: 200, body: alertJson(a) };
  }
  if (method === 'POST' && n === 2 && segs[0] === 'alert-thresholds') {
    const t = s.thresholds.find((x) => x.thresholdId === idOf(segs[1]));
    if (!t) return err(404, 'THRESHOLD_NOT_FOUND', `No threshold with id ${idOf(segs[1])}.`);
    const bad = (field, m) => err(400, 'ALERT_THRESHOLD_INVALID', m, field);
    let value = t.value, level = t.level, active = t.active;
    if (body.value !== undefined) { if (!oneDec(body.value)) return bad('value', 'value must be a number with at most one decimal.'); value = body.value; }
    if (body.level !== undefined) { if (!LEVELS.includes(body.level)) return bad('level', 'level must be watch, warning or severe.'); level = body.level; }
    if (body.active !== undefined) { if (typeof body.active !== 'boolean') return bad('active', 'active must be true or false.'); active = body.active; }
    if (t.alertType === 'rain' && !(value > 0 && value <= 500)) return bad('value', 'Rain threshold must be above 0 and at most 500 mm.');
    if (t.alertType === 'heat' && !(value >= 0 && value <= 60)) return bad('value', 'Heat threshold must be between 0 and 60 C.');
    if (t.alertType === 'frost' && !(value >= -20 && value <= 20)) return bad('value', 'Frost threshold must be between -20 and 20 C.');
    const heat = s.thresholds.filter((x) => x.alertType === 'heat' && x.active && x !== t).map((x) => x.value);
    const frost = s.thresholds.filter((x) => x.alertType === 'frost' && x.active && x !== t).map((x) => x.value);
    if (active && t.alertType === 'frost' && heat.some((h) => value >= h)) return bad('value', 'The frost (minimum) threshold must be below the heat (maximum) threshold.');
    if (active && t.alertType === 'heat' && frost.some((f) => value <= f)) return bad('value', 'The heat (maximum) threshold must be above the frost (minimum) threshold.');
    Object.assign(t, { value, level, active, updatedAt: clock(), updatedBy: typeof body.updatedBy === 'string' ? body.updatedBy.slice(0, 40) : 'api' });
    appendAudit(s, typeof body.requestId === 'string' ? body.requestId : '', t.updatedBy, 'alert_threshold_changed', JSON.stringify({ thresholdId: t.thresholdId, alertType: t.alertType, value, level, active }), t.updatedAt);
    return { status: 200, body: thJson(t) };
  }
  return null;
}
