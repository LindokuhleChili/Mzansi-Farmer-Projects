// The same rules as openedge/src/farm-api.p (procedure do-validate). Numbers come from the store (stand-in for OpenEdge).
import { STALE_READING_MINUTES, BUDGET_WINDOW_DAYS, ALLOWED_ACTIONS } from './constants.js';
import { minutesBetween, iso } from './time.js';

export function validate(store, { plotId, action, litres, asOf }) {
  const reasons = [];
  const facts = {};
  const plot = store.plots.find((p) => p.plotId === plotId);
  const add = (code, message) => reasons.push({ code, message });
  if (!plot) {
    add('PLOT_NOT_FOUND', `No plot with id ${plotId}.`);
    return { verdict: 'rejected_by_rules', rejectReasons: reasons, facts };
  }
  Object.assign(facts, {
    plotName: plot.plotName, dryThresholdPct: plot.dryThresholdPct, maxIrrigationLitres: plot.maxIrrigationLitres,
    weeklyWaterBudgetL: plot.weeklyWaterBudgetL, staleLimitMinutes: STALE_READING_MINUTES,
  });
  const windowStart = asOf.getTime() - BUDGET_WINDOW_DAYS * 86400000;
  const used = store.suggestions
    .filter((s) => s.plotId === plotId && s.status === 'approved' && s.action === 'irrigate' && s.decidedAt && s.decidedAt.getTime() >= windowStart)
    .reduce((a, s) => a + s.litres, 0);
  facts.usedLast7DaysL = used;
  const latest = store.latestReading(plotId);
  let age = null, haveFresh = false;
  if (latest) {
    age = Math.max(0, minutesBetween(asOf, latest.readAt));
    Object.assign(facts, {
      soilMoisturePct: latest.soilMoisturePct, temperatureC: latest.temperatureC, humidityPct: latest.humidityPct,
      raining: latest.raining, readingAt: iso(latest.readAt), readingAgeMinutes: age,
    });
    haveFresh = age <= STALE_READING_MINUTES;
  } else {
    facts.soilMoisturePct = null; facts.readingAgeMinutes = null;
  }
  if (!ALLOWED_ACTIONS.includes(action)) add('ACTION_NOT_ALLOWED', `Action '${action}' is not allowed. Allowed: ${ALLOWED_ACTIONS.join(', ')}.`);
  if (action === 'irrigate') {
    if (litres < 1 || litres > plot.maxIrrigationLitres) add('LITRES_OUT_OF_RANGE', `Litres must be between 1 and ${plot.maxIrrigationLitres} for this plot.`);
    if (!latest) add('NO_SENSOR_DATA', 'No sensor reading exists for this plot.');
    else if (!haveFresh) add('SENSOR_STALE', `Latest reading is ${age} min old (limit ${STALE_READING_MINUTES}).`);
    if (haveFresh) {
      if (latest.soilMoisturePct >= plot.dryThresholdPct) add('SOIL_NOT_DRY', `Soil moisture ${latest.soilMoisturePct}% is not below the dry threshold ${plot.dryThresholdPct}%.`);
      if (latest.raining) add('RAIN_DETECTED', 'Rain is being detected on this plot.');
    }
    if (used + litres > plot.weeklyWaterBudgetL) add('WATER_BUDGET_EXCEEDED', `Used ${used} L in the last 7 days; adding ${litres} L would exceed the weekly budget of ${plot.weeklyWaterBudgetL} L.`);
  }
  return { verdict: reasons.length === 0 ? 'approved_by_rules' : 'rejected_by_rules', rejectReasons: reasons, facts };
}
