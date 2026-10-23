// The AI layer: more than a chatbot. It reads recent sensor data from OpenEdge, computes a trend IN CODE, asks the model for a
// structured proposal, schema-validates it, checks the explanation only uses numbers that came from OpenEdge, and falls back
// to a deterministic proposal on timeout / bad output. The proposal is then sent to the ABL rules; nothing is applied here.
import Ajv from 'ajv';
import { deterministicProposal, AiError } from './provider.js';
import { MAX_REASON_LENGTH } from '../config.js';

const ajv = new Ajv({ allErrors: true });
export const proposalSchema = {
  type: 'object', additionalProperties: false, required: ['action', 'litres', 'reason'],
  properties: {
    action: { enum: ['irrigate', 'hold', 'notify'] },
    litres: { type: 'integer', minimum: 0, maximum: 1000 },
    reason: { type: 'string', minLength: 1, maxLength: MAX_REASON_LENGTH },
  },
};
const validateProposal = ajv.compile(proposalSchema);

// Trend computed from OpenEdge readings (newest first). Pure code, no model.
export function computeInsight(readings, dryThresholdPct) {
  if (readings.length < 2) return { trendPctPerHour: null, hoursToDryThreshold: null, readingsUsed: readings.length };
  const newest = readings[0], oldest = readings[readings.length - 1];
  const hours = (Date.parse(newest.readAt) - Date.parse(oldest.readAt)) / 3600000;
  if (hours <= 0) return { trendPctPerHour: null, hoursToDryThreshold: null, readingsUsed: readings.length };
  const slope = (newest.soilMoisturePct - oldest.soilMoisturePct) / hours;
  const trendPctPerHour = Math.round(slope * 10) / 10;
  let hoursToDryThreshold = null;
  if (newest.soilMoisturePct <= dryThresholdPct) hoursToDryThreshold = 0;
  else if (slope < 0) hoursToDryThreshold = Math.round(((newest.soilMoisturePct - dryThresholdPct) / -slope) * 10) / 10;
  return { trendPctPerHour, hoursToDryThreshold, readingsUsed: readings.length };
}

function numbersIn(text) { return (text.match(/-?\d+(?:\.\d+)?/g) || []).map(Number); }
function allowedNumbers(ctx, proposal) {
  const set = new Set();
  const add = (v) => { if (typeof v === 'number' && Number.isFinite(v)) { set.add(v); set.add(Math.round(v)); set.add(Math.round(v * 10) / 10); } };
  const { plot, latest, facts, insight } = ctx;
  [plot.maxIrrigationLitres, plot.dryThresholdPct, plot.weeklyWaterBudgetL, facts.usedLast7DaysL, facts.staleLimitMinutes, facts.readingAgeMinutes,
    insight.trendPctPerHour, insight.hoursToDryThreshold, proposal.litres, plot.plotId, plot.areaHa].forEach(add);
  if (latest) [latest.soilMoisturePct, latest.temperatureC, latest.humidityPct].forEach(add);
  // numbers inside the plot name, e.g. "Plot A" has none; allow digits that appear in names
  numbersIn(plot.plotName).forEach(add);
  return set;
}

// Returns { proposal, ai: { provider, usedFallback, fallbackReason?, reasonReplaced? } }
export async function proposeAction(provider, ctx, lang) {
  let raw, fallbackReason = null;
  try {
    raw = await provider.propose(ctx, lang);
  } catch (e) {
    fallbackReason = e instanceof AiError ? `${e.kind}: ${e.message}` : `error: ${e.message}`;
  }
  let proposal = null;
  if (fallbackReason === null) {
    try {
      const parsed = JSON.parse(extractJson(raw));
      if (validateProposal(parsed)) proposal = parsed;
      else fallbackReason = 'schema: ' + ajv.errorsText(validateProposal.errors, { dataVar: 'proposal' });
    } catch { fallbackReason = 'invalid_json: model output was not valid JSON'; }
  }
  const ai = { provider: provider.name, usedFallback: false };
  if (!proposal) {
    proposal = deterministicProposal(ctx, lang);
    ai.usedFallback = true; ai.fallbackReason = fallbackReason;
  } else {
    // The model explains; it must not introduce numbers that did not come from OpenEdge.
    const allowed = allowedNumbers(ctx, proposal);
    const bad = numbersIn(proposal.reason).filter((n) => !allowed.has(n));
    if (bad.length) {
      proposal = { ...proposal, reason: templateReason(ctx, proposal, lang) };
      ai.reasonReplaced = true; ai.reasonReplacedBecause = `explanation contained numbers not found in OpenEdge data: ${bad.join(', ')}`;
    }
  }
  ai.note = "AI-generated suggestion. The numbers in 'facts' come from OpenEdge; the rules decide if it is allowed; the farmer approves.";
  return { proposal, ai };
}

// Explanation built only from OpenEdge numbers and the proposal's own action/litres (used when the model's wording is not trusted).
export function templateReason(ctx, proposal, lang) {
  const { plot, latest } = ctx;
  const n = plot.plotName;
  const m = latest ? latest.soilMoisturePct : null;
  const zu = lang === 'zu';
  if (proposal.action === 'irrigate') {
    return zu
      ? `Umswakama e-${n} ungu-${m}%, umkhawulo wokomisa ungu-${plot.dryThresholdPct}%. Kuphakanyiswa ukunisela ama-litha angu-${proposal.litres}. (Umbhalo wesiZulu uyidrafti, udinga ukubuyekezwa.)`
      : `Soil moisture on ${n} is ${m}% and the dry threshold is ${plot.dryThresholdPct}%. Proposed: irrigate ${proposal.litres} L.`;
  }
  if (proposal.action === 'hold') {
    return zu ? `Kuphakanyiswa ukungasiseli e-${n} okwamanje.${m === null ? '' : ` Umswakama ungu-${m}%.`}`
              : `Proposed: hold irrigation on ${n} for now.${m === null ? '' : ` Soil moisture is ${m}%.`}`;
  }
  return zu ? `Kuphakanyiswa ukuthi umlimi ahlole i-${n}.` : `Proposed: the farmer should check ${n}.`;
}

function extractJson(raw) {
  if (typeof raw !== 'string') throw new Error('not a string');
  const t = raw.trim();
  if (t.startsWith('{')) return t;
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(t);   // tolerate a fenced block, nothing else
  if (m) return m[1].trim();
  throw new Error('no json');
}
