// Farm Assistant tests (run by `npm test`, or alone: node --test eval/assistant.test.mjs). Offline: mock OpenEdge, mock AI or a scripted AI.
// The ABL rule cases AS01 to AS41 (guide search, citations, DOSE_BLOCKED, approvals, memory) are in eval/oe-contract-cases.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';
import { classify, firstSentence } from '../apps/api/src/assistant/agent.js';
import { createCheckIns } from '../apps/api/src/assistant/checkins.js';
import { STEP_LIMIT, TOOL_DEFS } from '../apps/api/src/assistant/tools.js';
import { DOSE_QUANTITY } from '../apps/api/src/ai/doctor.js';

const APP = 'as-app-token-fixture-123';
function mkApp(provider = createMockProvider()) {
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-as-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'as-device-token-fixture-1' }]) });
  return buildApp({ config, oe: createOeClient(config), provider });
}
const api = async (app, method, url, payload, token = APP) => {
  const r = await app.inject({ method, url, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const chat = (app, message, extra = {}) => api(app, 'POST', '/api/v1/assistant/chat', { message, ...extra });
const stable = (b) => ({ reply: b.reply, steps: b.steps.map((s) => [s.tool, s.summary]), cards: b.cards.map((c) => [c.kind, c.text, c.status, c.citations]), problemType: b.problemType });
// scripted "AI": returns the given messages in order (tool calls or a final JSON answer)
const scripted = (turns) => { let i = 0; return { name: 'scripted', calls: 0, async agentStep() { this.calls++; const t = turns[Math.min(i++, turns.length - 1)]; if (t instanceof Error) throw t; return t; } }; };
const tc = (name, args, id = name) => ({ toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const final = (o) => ({ content: JSON.stringify(o) });

test('classify: problem type from the farmer message (English and a few isiZulu words)', () => {
  assert.equal(classify('My tomato leaves have brown spots'), 'sick_plant');
  assert.equal(classify('Is the soil dry on the maize?'), 'dry_soil');
  assert.equal(classify('Frost tonight, what do I do?'), 'frost');
  assert.equal(classify('Hello'), 'none');
});

test('firstSentence keeps "A. solani" together and quotes the passage exactly', () => {
  const t = 'On tomato, foliar symptoms of A. solani generally occur on the oldest leaves. Lesions grow.';
  assert.equal(firstSentence(t), 'On tomato, foliar symptoms of A. solani generally occur on the oldest leaves.');
});

test('tool registry: the 9 named tools plus memory; step limit 6', () => {
  const names = TOOL_DEFS.map((t) => t.name);
  for (const n of ['get_sensor_readings', 'get_forecast', 'run_plant_doctor', 'search_guides', 'get_nearby_reports', 'get_case', 'propose_action', 'list_harvest_days', 'remember']) assert.ok(names.includes(n), n);
  assert.equal(STEP_LIMIT, 6);
});

test('offline chat: sick plant -> quick ack, what I checked, cited reply, case file, step cards; deterministic', async () => {
  const a = mkApp(), b = mkApp();
  const r = await chat(a, 'My tomato leaves have brown spots with rings'), r2 = await chat(b, 'My tomato leaves have brown spots with rings');
  assert.equal(r.status, 200);
  assert.ok(r.body.ack);
  assert.equal(r.body.problemType, 'sick_plant');
  assert.deepEqual(stable(r.body), stable(r2.body));
  assert.ok(r.body.steps.some((s) => s.tool === 'search_guides'));
  assert.ok(r.body.case.caseId > 0);
  assert.ok(r.body.cards.length >= 2 && r.body.cards.every((c) => c.citations.length && c.status === 'proposed'));
  assert.ok(r.body.cards.some((c) => /extension officer/i.test(c.text)), 'suggests an expert');
  assert.ok(![r.body.reply, ...r.body.cards.map((c) => c.text)].some((t) => DOSE_QUANTITY.test(t)), 'no doses');
  assert.match(r.body.reply, /\[\d+\]/);
  // every citation exists in OpenEdge
  const ids = [...new Set([...r.body.case.causeCitations, ...r.body.cards.flatMap((c) => c.citations)])];
  const v = await api(a, 'POST', '/api/v1/guide/search', { q: 'tomato leaf spots' });
  assert.equal(v.status, 200); assert.ok(v.body.passages.length <= 3);
  for (const id of ids) { const c = await api(a, 'GET', `/api/v1/assistant/cases/${r.body.case.caseId}`); assert.ok(c.body.citations.some((x) => x.passageId === id), `citation ${id} returned with source`); }
  const cs = (await api(a, 'GET', `/api/v1/assistant/cases/${r.body.case.caseId}`)).body;
  assert.ok(cs.citations.every((c) => c.licence && c.sourceUrl));
  assert.ok(cs.evidence.some((e) => e.kind === 'search_guides'), 'what I checked is in the case file');
});

test('offline chat: dry soil -> irrigate card goes through the OpenEdge rules (rejection is final, with reasons)', async () => {
  const a = mkApp();
  const r = await chat(a, 'Is the soil dry on the maize?');
  assert.equal(r.status, 200);
  const irr = r.body.cards.find((c) => c.kind === 'irrigate');
  assert.ok(irr && irr.suggestionId);
  assert.equal(irr.status, 'rejected');               // seed readings are stale: OpenEdge says no
  assert.ok(irr.rejectReasons.length);
  const acc = await api(a, 'POST', `/api/v1/assistant/cases/${r.body.case.caseId}/actions/${irr.actionNo}/accept`, {});
  assert.equal(acc.status, 409);                         // suggestions use the suggestion approval, never this route
});

test('offline chat: frost and plain hello', async () => {
  const a = mkApp();
  const f = await chat(a, 'Frost tonight, what should I do?');
  assert.equal(f.body.problemType, 'frost'); assert.ok(f.body.cards.length);
  assert.match(f.body.reply, /not sure/i, 'honest when the sensors do not confirm it');
  const h = await chat(a, 'Hello');
  assert.equal(h.body.problemType, 'none'); assert.equal(h.body.case, null); assert.deepEqual(h.body.cards, []);
});

test('approval: accept and decline a step card, then follow-up answer resolves the case; all audited', async () => {
  const a = mkApp();
  const r = await chat(a, 'My tomato leaves have brown spots with rings');
  const id = r.body.case.caseId;
  const [c1, c2] = r.body.cards;
  assert.equal((await api(a, 'POST', `/api/v1/assistant/cases/${id}/actions/${c1.actionNo}/accept`, {})).status, 200);
  assert.equal((await api(a, 'POST', `/api/v1/assistant/cases/${id}/actions/${c1.actionNo}/decline`, {})).body.error, 'ALREADY_DECIDED');
  assert.equal((await api(a, 'POST', `/api/v1/assistant/cases/${id}/actions/${c2.actionNo}/decline`, {})).status, 200);
  const cs = (await api(a, 'GET', `/api/v1/assistant/cases/${id}`)).body;
  const fu = cs.followUps[0];
  const ans = await api(a, 'POST', `/api/v1/assistant/cases/${id}/follow-ups/${fu.followUpId}/answer`, { answer: 'Better now', resolved: true });
  assert.equal(ans.status, 200);
  assert.equal((await api(a, 'GET', `/api/v1/assistant/cases/${id}`)).body.status, 'resolved');
  assert.equal((await api(a, 'GET', '/api/v1/audit/verify')).body.ok, true);
});

test('chat validation and auth', async () => {
  const a = mkApp();
  assert.equal((await chat(a, '')).status, 400);
  assert.equal((await chat(a, 'hi', { lang: 'fr' })).status, 400);
  assert.equal((await chat(a, 'x'.repeat(1001))).status, 400);
  assert.equal((await api(a, 'POST', '/api/v1/assistant/chat', { message: 'hi' }, null)).status, 401);
});

test('AI tool loop: uses the tools, cites what it retrieved, case saved', async () => {
  const p = scripted([tc('get_sensor_readings', { plotId: 4 }), tc('search_guides', { query: 'tomato leaf spots' }, 's1'),
    tc('propose_action', { kind: 'contact_expert', text: 'Ask your extension officer to look at the leaves.', citations: [1] }, 'p1'),
    final({ problemType: 'sick_plant', plotId: 4, title: 'Spots on tomato leaves', likelyCause: 'Maybe early blight [1].', confidence: 'low', causeCitations: [1], followUpQuestion: 'Are the spots spreading?', reply: 'It may be early blight [1]. I am not sure; please ask your extension officer.' })]);
  const r = await chat(mkApp(p), 'Spots on my tomato leaves');
  assert.equal(r.status, 200); assert.equal(r.body.usedFallback, false);
  assert.deepEqual(r.body.steps.map((s) => s.tool), ['get_sensor_readings', 'search_guides', 'propose_action']);
  assert.equal(r.body.cards.length, 1); assert.equal(r.body.cards[0].kind, 'step');
});

test('AI cites a passage it did not retrieve -> offline planner instead', async () => {
  const p = scripted([tc('search_guides', { query: 'frost' }), final({ problemType: 'frost', title: 'Frost', likelyCause: 'x', causeCitations: [44], reply: 'See [44].' })]);
  const r = await chat(mkApp(p), 'Frost tonight');
  assert.equal(r.body.usedFallback, true); assert.equal(r.body.fallbackReason, 'citation_not_retrieved');
  assert.ok(r.body.case.caseId > 0);
});

test('AI answer with a dose -> offline planner, no dose shown', async () => {
  const p = scripted([tc('search_guides', { query: 'tomato blight' }), final({ problemType: 'sick_plant', title: 'Blight', likelyCause: 'Blight [1]', causeCitations: [1], reply: 'Spray 20 ml per litre of water [1].' })]);
  const r = await chat(mkApp(p), 'My tomato leaves have spots');
  assert.equal(r.body.usedFallback, true); assert.equal(r.body.fallbackReason, 'dose_removed');
  assert.ok(!DOSE_QUANTITY.test(JSON.stringify(r.body.reply)));
});

test('AI keeps calling tools -> stops at the step limit and falls back', async () => {
  const p = scripted([tc('get_forecast', {})]);
  const r = await chat(mkApp(p), 'Is the soil dry?');
  assert.equal(r.body.usedFallback, true);
  assert.ok(p.calls <= STEP_LIMIT + 1);
});

test('AI error -> offline planner with the same tools and cards', async () => {
  const r = await chat(mkApp(scripted([Object.assign(new Error('t'), { kind: 'timeout' })])), 'Frost tonight, what should I do?');
  const off = await chat(mkApp(), 'Frost tonight, what should I do?');
  assert.equal(r.body.usedFallback, true); assert.equal(r.body.fallbackReason, 'ai_timeout');
  assert.deepEqual(r.body.cards.map((c) => c.text), off.body.cards.map((c) => c.text));
});

test('memory: remember then read back per farm', async () => {
  const a = mkApp();
  assert.equal((await api(a, 'POST', '/api/v1/assistant/memory', { key: 'water_source', value: 'borehole' })).status, 200);
  const m = await api(a, 'GET', '/api/v1/assistant/memory');
  assert.ok(m.body.items.some((x) => x.key === 'water_source' && x.value === 'borehole'));
});

test('check-ins: first look is quiet, nothing changed is quiet, a new alert makes one message', async () => {
  let alerts = [];
  const call = async (_n, _m, path) => {
    if (path.startsWith('/farm/alerts')) return { status: 200, body: { alerts } };
    if (path === '/farm/plots') return { status: 200, body: { plots: [] } };
    return { status: 200, body: { cases: [] } };
  };
  const ci = createCheckIns({ call, clock: () => new Date('2026-10-26T10:00:00Z') });
  assert.equal((await ci.run()).added, 0);
  assert.equal((await ci.run()).added, 0);
  alerts = [{ alertType: 'frost', forecastDate: '2026-10-27', value: 1, unit: '°C' }];
  assert.equal((await ci.run()).added, 1);
  assert.equal((await ci.run()).added, 0, 'same alert again is quiet');
  assert.equal(ci.list(0).length, 1); assert.match(ci.list(0)[0].text, /Frost/);
  const a = mkApp(); await a.checkIns.run();
  assert.deepEqual((await api(a, 'GET', '/api/v1/assistant/check-ins?after=0')).body.messages, []);
});
