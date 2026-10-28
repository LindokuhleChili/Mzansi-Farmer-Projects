// Plant doctor (feature 1) and the no-doses guardrail (feature 2): same rules as openedge/src/doctor.i (docs/DOCTOR.md).
// OpenEdge never sees the photos. It stores the AI's (or the fallback's) answer only after the rule DOSE_BLOCKED passes:
// a sentence that has a dose word AND a chemical word from the admin-editable BlockedTerm table is refused.
import { readFileSync } from 'node:fs';
import { iso } from './time.js';
import { appendAudit } from './audit-chain.js';

const DOCTOR_SEED_PATH = new URL('../openedge/data/doctor-seed.json', import.meta.url);
export const PLANT_PARTS = ['leaf', 'stem', 'fruit', 'root', 'flower', 'whole_plant'];
export const GROWTH_STAGES = ['seedling', 'vegetative', 'flowering', 'fruiting', 'mature'];
export const PROVINCES = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'];
export const COSTS = ['free', 'low', 'medium', 'high'];
const LEVELS = ['low', 'medium', 'high'];
const err = (status, error, message, field, extra = {}) => ({ status, body: { error, message, ...(field ? { field } : {}), ...extra } });
const isStr = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;

export function loadDoctorSeed(store, path = DOCTOR_SEED_PATH) {
  const d = JSON.parse(readFileSync(path, 'utf8'));
  store.blockedTerms = []; store.diagnoses = [];
  store.seq.term = 0; store.seq.diagnosis = 0;
  for (const t of d.blockedTerms) store.blockedTerms.push({ termId: ++store.seq.term, term: t.term, kind: t.kind, active: true, updatedAt: null, updatedBy: 'seed' });
}

/** Lower-case, keep a-z 0-9 %, split digits from letters ("20ml" -> "20 ml"), single spaces, padded with one space each side. */
export function normText(s) {
  let out = ' ', prev = ' ';
  for (const ch of String(s).toLowerCase()) {
    const c = /[a-z]/.test(ch) ? 'a' : /[0-9]/.test(ch) ? '9' : ch === '%' ? '%' : ' ';
    if (c === ' ') { if (prev !== ' ') out += ' '; prev = ' '; continue; }
    if (prev !== ' ' && prev !== c) out += ' ';
    out += ch; prev = c;
  }
  return out.endsWith(' ') ? out : out + ' ';
}
export const sentences = (text) => String(text).split(/[.!?;\n]/).map((x) => x.trim()).filter(Boolean);
/** DOSE_BLOCKED: every sentence that holds an active dose term and an active chemical term (first of each by termId). */
export function doseCheck(items, terms) {
  const act = [...terms].filter((t) => t.active).sort((a, b) => a.termId - b.termId);
  const dose = act.filter((t) => t.kind === 'dose'), chem = act.filter((t) => t.kind === 'chemical');
  const blocked = [];
  for (const { field, text } of items) for (const s of sentences(text)) {
    const n = normText(s);
    const d = dose.find((t) => n.includes(normText(t.term)));
    const c = d && chem.find((t) => n.includes(normText(t.term)));
    if (d && c) blocked.push({ code: 'DOSE_BLOCKED', field, sentence: s.slice(0, 300), doseTerm: d.term, chemicalTerm: c.term });
  }
  return blocked;
}
export function resultTexts(r) {
  return [{ field: 'condition', text: r.condition }, { field: 'observations', text: r.observations },
    ...r.steps.map((s, i) => ({ field: `steps[${i}].text`, text: s.text })), ...r.monitor.map((m, i) => ({ field: `monitor[${i}]`, text: m })),
    { field: 'neighbourRisk.reason', text: r.neighbourRisk.reason }, { field: 'callExpert', text: r.callExpert }];
}
/** Shape check of the answer; returns the field name of the first problem, or null. */
export function resultProblem(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'result';
  if (!isStr(r.condition, 1, 120)) return 'result.condition';
  if (!LEVELS.includes(r.confidence)) return 'result.confidence';
  if (typeof r.observations !== 'string' || r.observations.length > 1000) return 'result.observations';
  if (!Array.isArray(r.steps) || r.steps.length < 3 || r.steps.length > 5) return 'result.steps';
  for (let i = 0; i < r.steps.length; i++) {
    const s = r.steps[i];
    if (!s || typeof s !== 'object' || !isStr(s.text, 1, 300)) return `result.steps[${i}].text`;
    if (!COSTS.includes(s.cost)) return `result.steps[${i}].cost`;
  }
  if (!Array.isArray(r.monitor) || r.monitor.length < 1 || r.monitor.length > 5 || !r.monitor.every((m) => isStr(m, 1, 200))) return 'result.monitor';
  if (!r.neighbourRisk || typeof r.neighbourRisk !== 'object' || !LEVELS.includes(r.neighbourRisk.level)) return 'result.neighbourRisk.level';
  if (!isStr(r.neighbourRisk.reason, 1, 300)) return 'result.neighbourRisk.reason';
  if (!isStr(r.callExpert, 1, 300)) return 'result.callExpert';
  return null;
}
const termJson = (t) => ({ termId: t.termId, term: t.term, kind: t.kind, active: t.active, updatedAt: iso(t.updatedAt), updatedBy: t.updatedBy });
const diagJson = (d) => ({ diagnosisId: d.diagnosisId, createdAt: iso(d.createdAt), crop: d.crop, plantPart: d.plantPart, growthStage: d.growthStage,
  province: d.province, photoCount: d.photoCount, condition: d.condition, confidence: d.confidence, observations: d.observations,
  steps: d.steps.map((s) => ({ text: s.text, cost: s.cost })), monitor: [...d.monitor], neighbourRisk: { level: d.neighbourRisk.level, reason: d.neighbourRisk.reason },
  callExpert: d.callExpert, usedFallback: d.usedFallback, fallbackReason: d.fallbackReason, verdict: 'passed', status: d.status, decidedAt: iso(d.decidedAt),
  visualText: d.visualText || '', embedModel: d.embedModel || '', hasDescriptionEmbedding: Boolean(d.embedVector) });
// Same rules as dr-take-visual / dr-vec-ok in openedge/src/doctor.i. A bad or dose-blocked description is dropped;
// the diagnosis itself is still stored. The vector is a text embedding of visualText, not of the photo.
const MODEL_RE = /^[A-Za-z0-9._-]{1,40}$/;
function takeVisual(body, terms) {
  let visualText = typeof body.visualText === 'string' ? body.visualText.trim() : '';
  if (visualText.length > 500) visualText = '';
  if (visualText && doseCheck([{ field: 'visualText', text: visualText }], terms).length) visualText = '';
  if (!visualText) return { visualText: '', embedModel: '', embedDim: 0, embedVector: '' };
  const embedModel = typeof body.embedModel === 'string' ? body.embedModel.trim() : '';
  const raw = typeof body.embedVector === 'string' ? body.embedVector.trim() : '';
  if (!MODEL_RE.test(embedModel) || raw.length > 4000 || !raw.startsWith('[')) return { visualText, embedModel: '', embedDim: 0, embedVector: '' };
  let arr;
  try { arr = JSON.parse(raw); } catch { return { visualText, embedModel: '', embedDim: 0, embedVector: '' }; }
  if (!Array.isArray(arr) || arr.length < 8 || arr.length > 256) return { visualText, embedModel: '', embedDim: 0, embedVector: '' };
  if (!arr.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= -1.5 && n <= 1.5)) return { visualText, embedModel: '', embedDim: 0, embedVector: '' };
  return { visualText, embedModel, embedDim: arr.length, embedVector: raw };
}
const candidateJson = (d) => ({ ...diagJson(d), embedDim: d.embedDim || 0, embedVector: d.embedVector || '' });

export function handleDoctor(s, method, segs, q, body, clock) {
  if (segs[0] !== 'doctor' || !s.blockedTerms) return null;
  const n = segs.length, idOf = (x) => (/^\d+$/.test(x) ? parseInt(x, 10) : NaN);
  const req = typeof body.requestId === 'string' ? body.requestId : '';
  if (method === 'GET' && n === 2 && segs[1] === 'blocked-terms') return { status: 200, body: { terms: [...s.blockedTerms].sort((a, b) => a.termId - b.termId).map(termJson) } };
  if (method === 'GET' && n === 2 && segs[1] === 'similar-candidates') {
    const lim = Math.min(Math.max(parseInt(q.get('limit') || '100', 10) || 100, 1), 100);
    return { status: 200, body: { cases: [...s.diagnoses].sort((a, b) => b.diagnosisId - a.diagnosisId).slice(0, lim).map(candidateJson) } };
  }
  if (method === 'GET' && n === 2 && segs[1] === 'diagnoses') {
    const lim = Math.min(Math.max(parseInt(q.get('limit') || '20', 10) || 20, 1), 100);
    return { status: 200, body: { diagnoses: [...s.diagnoses].sort((a, b) => b.diagnosisId - a.diagnosisId).slice(0, lim).map(diagJson) } };
  }
  if (method === 'GET' && n === 3 && segs[1] === 'diagnoses') {
    const d = s.diagnoses.find((x) => x.diagnosisId === idOf(segs[2]));
    return d ? { status: 200, body: diagJson(d) } : err(404, 'DIAGNOSIS_NOT_FOUND', `No diagnosis with id ${segs[2]}.`);
  }
  if (method !== 'POST') return null;
  if (n === 2 && segs[1] === 'check') {
    if (!Array.isArray(body.texts) || body.texts.length < 1 || body.texts.length > 20 || !body.texts.every((t) => typeof t === 'string' && t.length <= 2000))
      return err(400, 'VALIDATION_ERROR', 'texts must be 1 to 20 strings of at most 2000 characters.', 'texts');
    const blocked = doseCheck(body.texts.map((text, i) => ({ field: `texts[${i}]`, text })), s.blockedTerms);
    return { status: 200, body: { verdict: blocked.length ? 'blocked' : 'passed', blocked } };
  }
  if (n === 2 && segs[1] === 'diagnoses') {
    const b = body;
    if (!isStr(b.crop, 1, 40)) return err(400, 'VALIDATION_ERROR', 'crop is required (at most 40 characters).', 'crop');
    if (!PLANT_PARTS.includes(b.plantPart)) return err(400, 'VALIDATION_ERROR', `plantPart must be one of ${PLANT_PARTS.join(', ')}.`, 'plantPart');
    if (!GROWTH_STAGES.includes(b.growthStage)) return err(400, 'VALIDATION_ERROR', `growthStage must be one of ${GROWTH_STAGES.join(', ')}.`, 'growthStage');
    if (!PROVINCES.includes(b.province)) return err(400, 'VALIDATION_ERROR', 'province must be one of the 9 South African provinces.', 'province');
    if (!Number.isInteger(b.photoCount) || b.photoCount < 1 || b.photoCount > 3) return err(400, 'VALIDATION_ERROR', 'photoCount must be 1, 2 or 3.', 'photoCount');
    const bad = resultProblem(b.result);
    if (bad) return err(400, 'VALIDATION_ERROR', `${bad} is missing or not valid.`, bad);
    const r = b.result;
    for (let i = 1; i < r.steps.length; i++) if (COSTS.indexOf(r.steps[i].cost) < COSTS.indexOf(r.steps[i - 1].cost))
      return err(400, 'STEPS_NOT_CHEAPEST_FIRST', 'Steps must be ordered cheapest first (free, low, medium, high).', 'result.steps');
    const blocked = doseCheck(resultTexts(r), s.blockedTerms);
    if (blocked.length) {
      appendAudit(s, req, 'abl-rules', 'doctor_dose_blocked', JSON.stringify({ crop: b.crop, blocked: blocked.map((x) => ({ field: x.field, doseTerm: x.doseTerm, chemicalTerm: x.chemicalTerm })) }), clock());
      return err(422, 'DOSE_BLOCKED', 'The answer gives a chemical dose. Doses are never shown; ask an extension officer.', null, { blocked });
    }
    const d = { diagnosisId: ++s.seq.diagnosis, createdAt: clock(), crop: b.crop.trim(), plantPart: b.plantPart, growthStage: b.growthStage, province: b.province,
      photoCount: b.photoCount, condition: r.condition, confidence: r.confidence, observations: r.observations, steps: r.steps.map((x) => ({ text: x.text, cost: x.cost })),
      monitor: [...r.monitor], neighbourRisk: { level: r.neighbourRisk.level, reason: r.neighbourRisk.reason }, callExpert: r.callExpert,
      usedFallback: b.usedFallback === true, fallbackReason: typeof b.fallbackReason === 'string' ? b.fallbackReason.slice(0, 40) : '', status: 'pending_review', decidedAt: null, requestId: req,
      ...takeVisual(b, s.blockedTerms) };
    s.diagnoses.push(d);
    appendAudit(s, req, 'abl-rules', 'doctor_diagnosis_created', JSON.stringify({ diagnosisId: d.diagnosisId, crop: d.crop, condition: d.condition, usedFallback: d.usedFallback }), d.createdAt);
    return { status: 201, body: diagJson(d) };
  }
  if (n === 4 && segs[1] === 'diagnoses' && segs[3] === 'decision') {
    const d = s.diagnoses.find((x) => x.diagnosisId === idOf(segs[2]));
    if (!d) return err(404, 'DIAGNOSIS_NOT_FOUND', `No diagnosis with id ${segs[2]}.`);
    if (!['save', 'dismiss'].includes(body.decision)) return err(400, 'VALIDATION_ERROR', 'decision must be save or dismiss.', 'decision');
    if (d.status !== 'pending_review') return err(409, 'ALREADY_DECIDED', `Diagnosis ${d.diagnosisId} is already ${d.status}.`);
    d.status = body.decision === 'save' ? 'saved' : 'dismissed'; d.decidedAt = clock();
    appendAudit(s, req, typeof body.actor === 'string' ? body.actor.slice(0, 40) : 'farmer', `doctor_diagnosis_${d.status}`, JSON.stringify({ diagnosisId: d.diagnosisId }), d.decidedAt);
    return { status: 200, body: diagJson(d) };
  }
  if (n === 2 && segs[1] === 'blocked-terms') {
    const term = typeof body.term === 'string' ? body.term.trim().toLowerCase() : '';
    if (!term || term.length > 40 || !/^[a-z0-9% ]+$/.test(term)) return err(400, 'BLOCKED_TERM_INVALID', 'term must be 1 to 40 letters, digits, spaces or %.', 'term');
    if (!['dose', 'chemical'].includes(body.kind)) return err(400, 'BLOCKED_TERM_INVALID', 'kind must be dose or chemical.', 'kind');
    if (s.blockedTerms.some((t) => t.kind === body.kind && t.term === term)) return err(409, 'TERM_EXISTS', `"${term}" is already in the ${body.kind} list.`, 'term');
    const t = { termId: ++s.seq.term, term, kind: body.kind, active: true, updatedAt: clock(), updatedBy: typeof body.updatedBy === 'string' ? body.updatedBy.slice(0, 40) : 'admin' };
    s.blockedTerms.push(t);
    appendAudit(s, req, t.updatedBy, 'blocked_term_added', JSON.stringify({ termId: t.termId, term, kind: t.kind }), t.updatedAt);
    return { status: 201, body: termJson(t) };
  }
  if (n === 3 && segs[1] === 'blocked-terms') {
    const t = s.blockedTerms.find((x) => x.termId === idOf(segs[2]));
    if (!t) return err(404, 'TERM_NOT_FOUND', `No blocked term with id ${segs[2]}.`);
    if (typeof body.active !== 'boolean') return err(400, 'BLOCKED_TERM_INVALID', 'active must be true or false.', 'active');
    Object.assign(t, { active: body.active, updatedAt: clock(), updatedBy: typeof body.updatedBy === 'string' ? body.updatedBy.slice(0, 40) : 'admin' });
    appendAudit(s, req, t.updatedBy, 'blocked_term_changed', JSON.stringify({ termId: t.termId, term: t.term, active: t.active }), t.updatedAt);
    return { status: 200, body: termJson(t) };
  }
  return null;
}
