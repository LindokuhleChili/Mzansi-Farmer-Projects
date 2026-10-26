// Farm Assistant (docs/ASSISTANT.md): OpenEdge-native RAG over guide passages and persistent case files.
// Same rules as openedge/src/assistant.i. Routes: /guide/search, /guide/verify, /guide/passages/{id}, /assistant/cases[...].
// Search (identical in ABL): normalise the question like the no-doses rule does, drop stop words and words shorter than 3,
// keep the first 8 words plus each word's singular/plural form (add or drop one final s), add synonyms from the GuideSynonym
// table (24 words at most), find passages that hold any word
// (ABL: CONTAINS on a WORD index), score 2 per question word (or its plural/singular) and 1 per synonym, highest first, then lowest passageId.
// RULE CITATION_UNKNOWN: every cited passage id must exist in GuidePassage. RULE DOSE_BLOCKED (doctor.i) runs on every text.
import { readFileSync } from 'node:fs';
import { iso } from './time.js';
import { appendAudit } from './audit-chain.js';
import { normText, doseCheck } from './doctor.js';

const GUIDE_SEED_PATH = new URL('../openedge/data/guide-seed.json', import.meta.url);
export const PROBLEMS = ['dry_soil', 'sick_plant', 'frost', 'heat'];
export const ACTION_KINDS = ['irrigate', 'hold', 'notify', 'step'];
const COSTS = ['free', 'low', 'medium', 'high'];
const LEVELS = ['low', 'medium', 'high'];
export const MAX_BASE_TERMS = 8, MAX_TERMS = 24, MIN_TERM_LEN = 3;
const DAY_MS = 86400000;
const err = (status, error, message, field, extra = {}) => ({ status, body: { error, message, ...(field ? { field } : {}), ...extra } });
const isStr = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const isInt = (v) => Number.isInteger(v);

export function loadGuideSeed(store, path = GUIDE_SEED_PATH) {
  const d = JSON.parse(readFileSync(path, 'utf8'));
  store.passages = []; store.synonyms = []; store.stopwords = [...d.stopwords]; store.cases = []; store.followUps = []; store.memory = [];
  store.seq.passage = 0; store.seq.synonym = 0; store.seq.case = 0; store.seq.followUp = 0; store.seq.memory = 0;
  for (const p of d.passages) store.passages.push({ passageId: ++store.seq.passage, sourceTitle: p.sourceTitle, section: p.section, crop: p.crop || '', licence: p.licence,
    sourceUrl: p.sourceUrl, text: p.text, searchText: normText(`${p.sourceTitle} ${p.section} ${p.text}`) });
  for (const s of d.synonyms) store.synonyms.push({ synonymId: ++store.seq.synonym, term: s.term, words: s.words.join(' ') });
}

/** The words the search uses: { base, terms }. base = question words plus their singular/plural form (score 2); terms adds synonyms (score 1). */
export const wordForm = (w) => (w.endsWith('s') ? (w.length > MIN_TERM_LEN ? w.slice(0, -1) : '') : w + 's');
export function queryTerms(store, q) {
  const words = [];
  for (const w of normText(q).trim().split(' ')) {
    if (!/^[a-z0-9]+$/.test(w) || w.length < MIN_TERM_LEN || store.stopwords.includes(w) || words.includes(w)) continue;
    words.push(w);
    if (words.length >= MAX_BASE_TERMS) break;
  }
  const base = [];
  for (const w of words) for (const x of [w, wordForm(w)]) if (x && !base.includes(x)) base.push(x);
  const terms = [...base];
  for (const b of words) {
    const syn = store.synonyms.find((s) => s.term === b);
    if (!syn) continue;
    for (const w of syn.words.split(' ')) if (w && !terms.includes(w) && terms.length < MAX_TERMS) terms.push(w);
  }
  return { base, terms };
}
export function searchGuide(store, q, limit = 3) {
  const { base, terms } = queryTerms(store, q);
  const hits = [];
  for (const p of store.passages) {
    let score = 0;
    for (const t of terms) if (p.searchText.includes(` ${t} `)) score += base.includes(t) ? 2 : 1;
    if (score > 0) hits.push({ p, score });
  }
  hits.sort((a, b) => b.score - a.score || a.p.passageId - b.p.passageId);
  return { terms, passages: hits.slice(0, limit).map(({ p, score }) => ({ ...passageJson(p), score })) };
}
const passageJson = (p) => ({ passageId: p.passageId, sourceTitle: p.sourceTitle, section: p.section, crop: p.crop, licence: p.licence, sourceUrl: p.sourceUrl, text: p.text });
const citeJson = (p) => ({ passageId: p.passageId, sourceTitle: p.sourceTitle, section: p.section, licence: p.licence, sourceUrl: p.sourceUrl });
export const unknownCitations = (store, ids) => [...new Set(ids)].filter((id) => !store.passages.some((p) => p.passageId === id)).sort((a, b) => a - b);

/** Shape check of a new case; returns [field, message] of the first problem, or null. */
function caseProblem(b) {
  if (!isInt(b.plotId)) return ['plotId', 'plotId must be an integer.'];
  if (!PROBLEMS.includes(b.problemType)) return ['problemType', `problemType must be one of ${PROBLEMS.join(', ')}.`];
  if (!isStr(b.title, 1, 120)) return ['title', 'title is required (at most 120 characters).'];
  if (!isStr(b.likelyCause, 1, 400)) return ['likelyCause', 'likelyCause is required (at most 400 characters).'];
  if (!LEVELS.includes(b.confidence)) return ['confidence', 'confidence must be low, medium or high.'];
  const cites = (a) => Array.isArray(a) && a.length >= 1 && a.length <= 5 && a.every(isInt);
  if (!cites(b.causeCitations)) return ['causeCitations', 'causeCitations must be 1 to 5 passage ids.'];
  if (!Array.isArray(b.evidence) || b.evidence.length < 1 || b.evidence.length > 12) return ['evidence', 'evidence must be 1 to 12 items.'];
  for (let i = 0; i < b.evidence.length; i++) { const e = b.evidence[i]; if (!e || !isStr(e.kind, 1, 30) || !isStr(e.text, 1, 300)) return [`evidence[${i}]`, 'Each evidence item needs kind (30) and text (300).']; }
  if (!Array.isArray(b.actions) || b.actions.length < 1 || b.actions.length > 5) return ['actions', 'actions must be 1 to 5 items.'];
  for (let i = 0; i < b.actions.length; i++) {
    const a = b.actions[i], f = `actions[${i}]`;
    if (!a || typeof a !== 'object' || !ACTION_KINDS.includes(a.kind)) return [`${f}.kind`, `kind must be one of ${ACTION_KINDS.join(', ')}.`];
    if (!isStr(a.text, 1, 300)) return [`${f}.text`, 'text is required (at most 300 characters).'];
    if (!cites(a.citations) || a.citations.length > 3) return [`${f}.citations`, 'Each action needs 1 to 3 passage ids.'];
    if (a.kind === 'step' && !COSTS.includes(a.cost)) return [`${f}.cost`, 'cost must be free, low, medium or high.'];
    if (a.kind !== 'step' && !isInt(a.suggestionId)) return [`${f}.suggestionId`, 'Irrigation actions must name the suggestion OpenEdge already checked.'];
  }
  if (!isInt(b.followUpDays) || b.followUpDays < 1 || b.followUpDays > 14) return ['followUpDays', 'followUpDays must be 1 to 14.'];
  if (!isStr(b.followUpQuestion, 1, 200)) return ['followUpQuestion', 'followUpQuestion is required (at most 200 characters).'];
  if (b.diagnosisId !== undefined && b.diagnosisId !== null && !isInt(b.diagnosisId)) return ['diagnosisId', 'diagnosisId must be an integer.'];
  return null;
}
export const caseTexts = (b) => [{ field: 'title', text: b.title }, { field: 'likelyCause', text: b.likelyCause },
  ...b.evidence.map((e, i) => ({ field: `evidence[${i}].text`, text: e.text })), ...b.actions.map((a, i) => ({ field: `actions[${i}].text`, text: a.text })),
  { field: 'followUpQuestion', text: b.followUpQuestion }];

function caseJson(s, c) {
  const ids = [...c.causeCitations]; for (const a of c.actions) for (const id of a.citations) if (!ids.includes(id)) ids.push(id);
  return { caseId: c.caseId, createdAt: iso(c.createdAt), plotId: c.plotId, problemType: c.problemType, title: c.title, likelyCause: c.likelyCause, confidence: c.confidence,
    causeCitations: [...c.causeCitations], citations: ids.map((id) => s.passages.find((p) => p.passageId === id)).filter(Boolean).map(citeJson),
    evidence: c.evidence.map((e) => ({ kind: e.kind, text: e.text })),
    actions: c.actions.map((a) => {
      const sg = a.suggestionId ? s.suggestions.find((x) => x.suggestionId === a.suggestionId) : null;
      return { actionNo: a.actionNo, kind: a.kind, text: a.text, cost: a.cost, citations: [...a.citations], suggestionId: a.suggestionId || null,
        verdict: sg ? sg.verdict : null, status: sg ? sg.status : a.status, decidedAt: sg ? iso(sg.decidedAt) : iso(a.decidedAt) };
    }),
    followUps: s.followUps.filter((f) => f.caseId === c.caseId).sort((a, b) => a.followUpId - b.followUpId)
      .map((f) => ({ followUpId: f.followUpId, dueAt: iso(f.dueAt), question: f.question, status: f.status, answer: f.answer, answeredAt: iso(f.answeredAt) })),
    diagnosisId: c.diagnosisId || null, usedFallback: c.usedFallback, provider: c.provider, status: c.status, closedAt: iso(c.closedAt) };
}

export function handleAssistant(s, method, segs, q, body, clock) {
  if ((segs[0] !== 'guide' && segs[0] !== 'assistant') || !s.passages) return null;
  const n = segs.length, idOf = (x) => (/^\d+$/.test(x) ? parseInt(x, 10) : NaN);
  const req = typeof body.requestId === 'string' ? body.requestId : '';
  const actor = typeof body.actor === 'string' && body.actor.trim() ? body.actor.slice(0, 40) : 'farmer';
  if (segs[0] === 'guide') {
    if (method === 'GET' && n === 3 && segs[1] === 'passages') {
      const p = s.passages.find((x) => x.passageId === idOf(segs[2]));
      return p ? { status: 200, body: passageJson(p) } : err(404, 'PASSAGE_NOT_FOUND', `No guide passage with id ${segs[2]}.`);
    }
    if (method === 'POST' && n === 2 && segs[1] === 'search') {
      if (!isStr(body.q, 2, 200)) return err(400, 'VALIDATION_ERROR', 'q must be 2 to 200 characters.', 'q');
      let limit = 3;
      if (body.limit !== undefined) { if (!isInt(body.limit) || body.limit < 1 || body.limit > 10) return err(400, 'VALIDATION_ERROR', 'limit must be 1 to 10.', 'limit'); limit = body.limit; }
      const r = searchGuide(s, body.q, limit);
      return { status: 200, body: { query: body.q, terms: r.terms, passages: r.passages } };
    }
    if (method === 'POST' && n === 2 && segs[1] === 'verify') {
      if (!Array.isArray(body.citations) || body.citations.length > 50 || !body.citations.every(isInt)) return err(400, 'VALIDATION_ERROR', 'citations must be at most 50 passage ids.', 'citations');
      const unknown = unknownCitations(s, body.citations);
      return { status: 200, body: { verdict: unknown.length ? 'blocked' : 'passed', unknown } };
    }
    return null;
  }
  // ---- /assistant/memory: what the assistant remembers about a farm (profile facts and preferences), loaded into every chat turn
  if (segs[1] === 'memory' && n === 2) {
    if (method === 'GET') {
      const farmId = parseInt(q.get('farmId') || '1', 10);
      return { status: 200, body: { farmId, items: s.memory.filter((m) => m.farmId === farmId).sort((a, b) => (a.key < b.key ? -1 : 1)).map((m) => ({ key: m.key, value: m.value, updatedAt: iso(m.updatedAt) })) } };
    }
    if (method !== 'POST') return null;
    if (!isInt(body.farmId)) return err(400, 'VALIDATION_ERROR', 'farmId must be an integer.', 'farmId');
    if (typeof body.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(body.key)) return err(400, 'VALIDATION_ERROR', 'key must be 1 to 40 lower-case letters, digits or _.', 'key');
    if (!isStr(body.value, 1, 300)) return err(400, 'VALIDATION_ERROR', 'value is required (at most 300 characters).', 'value');
    if (!s.farms.some((f) => f.farmId === body.farmId)) return err(404, 'FARM_NOT_FOUND', `No farm with id ${body.farmId}.`, 'farmId');
    const blocked = doseCheck([{ field: 'value', text: body.value }], s.blockedTerms);
    if (blocked.length) return err(422, 'DOSE_BLOCKED', 'The answer gives a chemical dose. Doses are never shown; ask an extension officer.', null, { blocked });
    const now = clock();
    let m = s.memory.find((x) => x.farmId === body.farmId && x.key === body.key);
    if (m) Object.assign(m, { value: body.value.trim(), updatedAt: now });
    else s.memory.push(m = { memoryId: ++s.seq.memory, farmId: body.farmId, key: body.key, value: body.value.trim(), updatedAt: now });
    appendAudit(s, req, actor, 'assistant_memory_saved', JSON.stringify({ farmId: m.farmId, key: m.key }), now);
    return { status: 200, body: { key: m.key, value: m.value, updatedAt: iso(m.updatedAt) } };
  }
  // ---- /assistant/cases
  if (segs[1] !== 'cases') return null;
  if (method === 'GET' && n === 2) {
    const st = q.get('status');
    const lim = Math.min(Math.max(parseInt(q.get('limit') || '20', 10) || 20, 1), 100);
    return { status: 200, body: { cases: s.cases.filter((c) => !st || c.status === st).sort((a, b) => b.caseId - a.caseId).slice(0, lim).map((c) => caseJson(s, c)) } };
  }
  const c = n >= 3 ? s.cases.find((x) => x.caseId === idOf(segs[2])) : null;
  if (method === 'GET' && n === 3) return c ? { status: 200, body: caseJson(s, c) } : err(404, 'CASE_NOT_FOUND', `No case with id ${segs[2]}.`);
  if (method !== 'POST') return null;
  if (n === 2) {
    const bad = caseProblem(body);
    if (bad) return err(400, 'VALIDATION_ERROR', bad[1], bad[0]);
    if (!s.plots.some((p) => p.plotId === body.plotId)) return err(404, 'PLOT_NOT_FOUND', `No plot with id ${body.plotId}.`, 'plotId');
    if (isInt(body.diagnosisId) && !s.diagnoses.some((d) => d.diagnosisId === body.diagnosisId)) return err(404, 'DIAGNOSIS_NOT_FOUND', `No diagnosis with id ${body.diagnosisId}.`, 'diagnosisId');
    for (let i = 0; i < body.actions.length; i++) {
      const a = body.actions[i];
      if (a.kind === 'step') continue;
      const sg = s.suggestions.find((x) => x.suggestionId === a.suggestionId);
      if (!sg) return err(404, 'SUGGESTION_NOT_FOUND', `No suggestion with id ${a.suggestionId}.`, `actions[${i}].suggestionId`);
      if (sg.plotId !== body.plotId || sg.action !== a.kind) return err(422, 'SUGGESTION_MISMATCH', `Suggestion ${a.suggestionId} is not a ${a.kind} for plot ${body.plotId}.`, `actions[${i}].suggestionId`);
    }
    const unknown = unknownCitations(s, [...body.causeCitations, ...body.actions.flatMap((a) => a.citations)]);
    if (unknown.length) {
      appendAudit(s, req, 'abl-rules', 'assistant_citation_blocked', JSON.stringify({ plotId: body.plotId, unknown }), clock());
      return err(422, 'CITATION_UNKNOWN', 'The answer cites guide passages that do not exist.', null, { unknown });
    }
    const blocked = doseCheck(caseTexts(body), s.blockedTerms);
    if (blocked.length) {
      appendAudit(s, req, 'abl-rules', 'assistant_dose_blocked', JSON.stringify({ plotId: body.plotId, blocked: blocked.map((x) => ({ field: x.field, doseTerm: x.doseTerm, chemicalTerm: x.chemicalTerm })) }), clock());
      return err(422, 'DOSE_BLOCKED', 'The answer gives a chemical dose. Doses are never shown; ask an extension officer.', null, { blocked });
    }
    const now = clock();
    const cs = { caseId: ++s.seq.case, createdAt: now, plotId: body.plotId, problemType: body.problemType, title: body.title.trim(), likelyCause: body.likelyCause, confidence: body.confidence,
      causeCitations: [...body.causeCitations], evidence: body.evidence.map((e) => ({ kind: e.kind, text: e.text })),
      actions: body.actions.map((a, i) => ({ actionNo: i + 1, kind: a.kind, text: a.text, cost: a.kind === 'step' ? a.cost : '', citations: [...a.citations], suggestionId: a.kind === 'step' ? 0 : a.suggestionId, status: 'proposed', decidedAt: null })),
      followUpQuestion: body.followUpQuestion, diagnosisId: isInt(body.diagnosisId) ? body.diagnosisId : 0, usedFallback: body.usedFallback === true,
      provider: typeof body.provider === 'string' ? body.provider.slice(0, 40) : 'unknown', status: 'open', closedAt: null, requestId: req };
    s.cases.push(cs);
    s.followUps.push({ followUpId: ++s.seq.followUp, caseId: cs.caseId, dueAt: new Date(now.getTime() + body.followUpDays * DAY_MS), question: body.followUpQuestion, status: 'due', answer: '', answeredAt: null });
    appendAudit(s, req, 'abl-rules', 'assistant_case_opened', JSON.stringify({ caseId: cs.caseId, plotId: cs.plotId, problemType: cs.problemType, actions: cs.actions.length, usedFallback: cs.usedFallback }), now);
    return { status: 201, body: caseJson(s, cs) };
  }
  if (!c) return err(404, 'CASE_NOT_FOUND', `No case with id ${segs[2]}.`);
  if (n === 6 && segs[3] === 'actions' && segs[5] === 'decision') {
    const a = c.actions.find((x) => x.actionNo === idOf(segs[4]));
    if (!a) return err(404, 'ACTION_NOT_FOUND', `Case ${c.caseId} has no action ${segs[4]}.`);
    if (!['accept', 'decline'].includes(body.decision)) return err(400, 'VALIDATION_ERROR', 'decision must be accept or decline.', 'decision');
    if (c.status !== 'open') return err(409, 'CASE_CLOSED', `Case ${c.caseId} is ${c.status}.`);
    if (a.kind !== 'step') return err(409, 'USE_SUGGESTION_APPROVAL', `Approve suggestion ${a.suggestionId} with its two-step confirmation.`);
    if (a.status !== 'proposed') return err(409, 'ALREADY_DECIDED', `Action ${a.actionNo} is already ${a.status}.`);
    a.status = body.decision === 'accept' ? 'accepted' : 'declined'; a.decidedAt = clock();
    appendAudit(s, req, actor, `assistant_action_${a.status}`, JSON.stringify({ caseId: c.caseId, actionNo: a.actionNo }), a.decidedAt);
    return { status: 200, body: caseJson(s, c) };
  }
  if (n === 6 && segs[3] === 'follow-ups' && segs[5] === 'answer') {
    const f = s.followUps.find((x) => x.caseId === c.caseId && x.followUpId === idOf(segs[4]));
    if (!f) return err(404, 'FOLLOWUP_NOT_FOUND', `Case ${c.caseId} has no follow-up ${segs[4]}.`);
    if (!isStr(body.answer, 1, 500)) return err(400, 'VALIDATION_ERROR', 'answer is required (at most 500 characters).', 'answer');
    if (typeof body.resolved !== 'boolean') return err(400, 'VALIDATION_ERROR', 'resolved must be true or false.', 'resolved');
    let next = 3;
    if (body.nextInDays !== undefined) { if (!isInt(body.nextInDays) || body.nextInDays < 1 || body.nextInDays > 14) return err(400, 'VALIDATION_ERROR', 'nextInDays must be 1 to 14.', 'nextInDays'); next = body.nextInDays; }
    if (c.status !== 'open') return err(409, 'CASE_CLOSED', `Case ${c.caseId} is ${c.status}.`);
    if (f.status !== 'due') return err(409, 'ALREADY_ANSWERED', `Follow-up ${f.followUpId} is already answered.`);
    const now = clock();
    Object.assign(f, { status: 'answered', answer: body.answer.trim(), answeredAt: now });
    if (body.resolved) { c.status = 'resolved'; c.closedAt = now; }
    else s.followUps.push({ followUpId: ++s.seq.followUp, caseId: c.caseId, dueAt: new Date(now.getTime() + next * DAY_MS), question: c.followUpQuestion, status: 'due', answer: '', answeredAt: null });
    appendAudit(s, req, actor, body.resolved ? 'assistant_case_resolved' : 'assistant_followup_answered', JSON.stringify({ caseId: c.caseId, followUpId: f.followUpId }), now);
    return { status: 200, body: caseJson(s, c) };
  }
  return null;
}
