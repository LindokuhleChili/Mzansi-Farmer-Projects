// Farm watch. A background look at the farm that opens assistant cases only when something needs the farmer.
// It uses the same tools as the chat assistant (sensors, forecast, nearby reports, and, for a sick plant, similar
// cases and the guides) and the same offline planner, so propose_action and the OpenEdge rules still gate every card.
// Nothing is watered, sprayed or sent. The scheduled job is off unless FARM_WATCH_INTERVAL_MIN is set.
// The manual route POST /api/v1/assistant/watch/run is how the demo runs it on demand.
import { FARM_ID, createTools } from './tools.js';
import { runTurn } from './agent.js';

export const STALE_READING_MINUTES = 15;   // same limit as the OpenEdge SENSOR_STALE rule
export const RAIN_FORECAST_MM = 1;
export const WATCH_MAX_CASES = 3;

export function forecastHasRain(days, minMm = RAIN_FORECAST_MM) {
  return (days || []).some((d) => Number(d.rainMm) >= minMm);
}

/**
 * Pure scan. readings: { [plotId]: { soilMoisturePct, raining, ageMinutes } }
 * diagnoses: [{ crop, condition }]
 * One stale-sensor issue for the whole farm (the oldest reading), one disease issue, and one dry-soil issue per plot.
 */
export function detectWatchIssues({ plots = [], readings = {}, forecastDays = [], diagnoses = [] } = {}) {
  const issues = [];
  const mine = plots.filter((p) => p && (p.farmId === undefined || p.farmId === FARM_ID)).slice().sort((a, b) => a.plotId - b.plotId);
  const diag = (diagnoses || []).find((d) => d && d.condition);
  if (diag && mine.length) {
    const plot = mine.find((p) => p.crop && diag.crop && p.crop.toLowerCase() === String(diag.crop).toLowerCase()) || mine[0];
    issues.push({
      farmLevel: true, plotId: plot.plotId, problemType: 'sick_plant', reason: 'disease_nearby', watchStale: false,
      titlePrefix: 'Farm watch: nearby disease',
      title: `Farm watch: nearby disease · ${plot.plotName}`.slice(0, 80),
      message: `A plant doctor report for ${diag.crop || plot.crop} says ${diag.condition}. Please check the nearby plants.`,
    });
  }
  const rain = forecastHasRain(forecastDays);
  let oldest = null;
  for (const p of mine) {
    const lat = readings[p.plotId];
    if (!lat || !Number.isFinite(lat.ageMinutes)) continue;
    const stale = lat.ageMinutes > STALE_READING_MINUTES;
    const dry = lat.soilMoisturePct < p.dryThresholdPct && !lat.raining;
    if (!stale && dry && !rain) {
      issues.push({
        farmLevel: false, plotId: p.plotId, problemType: 'dry_soil', reason: 'dry_soil_no_rain', watchStale: false,
        titlePrefix: 'Farm watch: dry soil',
        title: `Farm watch: dry soil · ${p.plotName}`.slice(0, 80),
        message: `${p.plotName} soil is dry (${lat.soilMoisturePct}%) and the forecast has no real rain. Please check whether to water.`,
      });
    } else if (stale && (!oldest || lat.ageMinutes > oldest.lat.ageMinutes || (lat.ageMinutes === oldest.lat.ageMinutes && p.plotId < oldest.plot.plotId))) {
      oldest = { plot: p, lat };
    }
  }
  if (oldest) {
    const p = oldest.plot, lat = oldest.lat;
    issues.push({
      farmLevel: true, plotId: p.plotId, problemType: 'dry_soil', reason: 'stale_sensor', watchStale: true,
      titlePrefix: 'Farm watch: check sensor',
      title: `Farm watch: check sensor · ${p.plotName}`.slice(0, 80),
      message: `The sensor on ${p.plotName} is stale (${lat.ageMinutes} minutes old). Please check it before watering.`,
    });
  }
  return issues;
}

export function watchBlocked(existing, issue, now, dedupeHours) {
  const windowMs = Math.max(1, dedupeHours) * 3600000;
  const tNow = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return (existing || []).some((c) => {
    const title = String(c.title || '');
    const same = issue.farmLevel
      ? title.startsWith(issue.titlePrefix)
      : c.plotId === issue.plotId && c.problemType === issue.problemType && title.startsWith(issue.titlePrefix);
    if (!same) return false;
    if (c.status === 'open') return true;
    const age = tNow - Date.parse(c.createdAt);
    return Number.isFinite(age) && age >= 0 && age < windowMs;
  });
}

export function createFarmWatch({ callFor, provider, clock, dedupeHours = 24 }) {
  let running = false;
  async function run(requestId = 'watch') {
    if (running) return { ok: true, busy: true, checked: [], issues: [], opened: [], skipped: [] };
    running = true;
    const checked = [];
    try {
      const call = callFor(requestId);
      const st = { passages: [], proposals: [], sensor: {}, plots: [], alerts: [] };
      const T = createTools({ call, clock, state: st, requestId, providerName: provider.name });
      const step = async (name, args) => {
        const r = await T[name](args);
        checked.push({ tool: name, summary: r.summary });
        return r.result;
      };
      await step('get_farm_profile');
      const fc = await step('get_forecast');
      const readings = {};
      for (const p of (st.plots || []).filter((x) => x.farmId === FARM_ID)) {
        const sensor = await step('get_sensor_readings', { plotId: p.plotId });
        if (sensor?.latest) readings[p.plotId] = sensor.latest;
      }
      const near = await step('get_nearby_reports', {});
      const diagnoses = near?.diagnoses || [];
      const crop = ((st.plots || []).find((p) => p.farmId === FARM_ID) || {}).crop || '';
      await step('find_similar_cases', { crop, condition: diagnoses[0]?.condition || '' });
      await step('search_guides', { query: 'soil moisture sensor leaf spots' });
      const issues = detectWatchIssues({ plots: st.plots, readings, forecastDays: fc?.days || [], diagnoses });
      let existing = [];
      try {
        const listed = await call('oe.assistant_cases', 'GET', '/farm/assistant/cases?limit=50');
        existing = listed.status === 200 ? (listed.body.cases || []) : [];
      } catch { existing = []; }
      const now = clock();
      const opened = [], skipped = [];
      for (const issue of issues) {
        if (opened.length >= WATCH_MAX_CASES) break;
        if (watchBlocked(existing, issue, now, dedupeHours)) { skipped.push({ plotId: issue.plotId, reason: issue.reason, why: 'deduped' }); continue; }
        try {
          const turn = await runTurn({ call, provider, clock, requestId, source: 'farm-watch' }, {
            message: issue.message, plotId: issue.plotId, problemHint: issue.problemType, plannerOnly: true,
            titleOverride: issue.title, watchStale: issue.watchStale,
          });
          if (turn.case?.caseId) {
            opened.push({ caseId: turn.case.caseId, plotId: issue.plotId, problemType: issue.problemType, reason: issue.reason, title: turn.case.title, status: turn.case.status });
            existing.push(turn.case);
          } else skipped.push({ plotId: issue.plotId, reason: issue.reason, why: turn.error || 'no_case' });
        } catch {
          skipped.push({ plotId: issue.plotId, reason: issue.reason, why: 'error' });
        }
      }
      return { ok: true, busy: false, checked, issues: issues.map((i) => ({ plotId: i.plotId, reason: i.reason, problemType: i.problemType })), opened, skipped };
    } catch (e) {
      return { ok: false, busy: false, error: e.message || 'watch_failed', checked, issues: [], opened: [], skipped: [] };
    } finally { running = false; }
  }
  return { run };
}
