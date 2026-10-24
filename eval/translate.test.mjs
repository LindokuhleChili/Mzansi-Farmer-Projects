// Dynamic AI translation (run by `npm test`, or alone: node --test eval/translate.test.mjs). Offline: the mock AI provider is used.
//  - POST /api/v1/translate: auth, target validation (11 official languages), size limits, en passthrough
//  - cache per (target, text hash), fallback to English on AI failure, numbers/prices/kg/dates/names kept (mock)
//  - the web language picker: 11 languages in their own names, English default with no saved choice, a manual pick is saved
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { createTranslator, LANGUAGES, TRANSLATE_SYSTEM_PROMPT, buildTranslatePrompt } from '../apps/api/src/ai/translate.js';
import { buildApp } from '../apps/api/src/app.js';

const APP = 'tr-app-token-fixture-123', NOW = new Date('2026-10-23T20:00:00Z');
const CODES = ['en', 'zu', 'xh', 'af', 'nso', 'st', 'tn', 'ss', 've', 'ts', 'nr'];
function make(behaviour = 'normal') {
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: APP, AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-tr-')),
    DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'tr-device-token-fixture-1' }]) });
  const provider = createMockProvider({ behaviour });
  return { provider, app: buildApp({ config, oe: createOeClient(config, { clock: () => NOW }), provider, clock: () => NOW }) };
}
const post = (app, body, auth = true) => app.inject({ method: 'POST', url: '/api/v1/translate', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${APP}` } : {}) }, payload: JSON.stringify(body) });

test('translate: exactly the 11 official South African languages are supported', () => {
  assert.deepEqual(Object.keys(LANGUAGES).sort(), [...CODES].sort());
});
test('translate: needs the app token (401), validates target (400) and texts / limits (400)', async () => {
  const { app } = make();
  assert.equal((await post(app, { texts: ['Market'], target: 'xh' }, false)).statusCode, 401);
  for (const target of [undefined, 'fr', 'ZU', 'zul', '', 7]) {
    const r = await post(app, { texts: ['Market'], target });
    assert.equal(r.statusCode, 400, String(target)); assert.equal(r.json().field, 'target');
  }
  for (const texts of [undefined, [], 'Market', [1], ['x'.repeat(501)], Array(61).fill('a')]) {
    const r = await post(app, { texts, target: 'xh' });
    assert.equal(r.statusCode, 400); assert.equal(r.json().field, 'texts');
  }
  for (const target of CODES) assert.equal((await post(app, { texts: ['Market'], target })).statusCode, 200, target);
});
test('translate: en is a passthrough (no AI call); other targets go to the AI provider', async () => {
  const { app } = make();
  const en = (await post(app, { texts: ['Market day'], target: 'en' })).json();
  assert.deepEqual(en.translations, [{ text: 'Market day', translated: false, source: 'passthrough' }]);
  const xh = (await post(app, { texts: ['Market day'], target: 'xh' })).json();
  assert.equal(xh.translations[0].text, '[xh] Market day'); assert.equal(xh.translations[0].translated, true); assert.equal(xh.fallback, false);
});
test('translate: results are cached per (target, text): each string reaches the AI once', async () => {
  const p = createMockProvider(); let calls = 0; const orig = p.translate; p.translate = (...a) => { calls++; return orig(...a); };
  const tr = createTranslator(p);
  await tr.translate(['Beans', 'Spinach', 'Beans'], 'tn');
  const again = await tr.translate(['Spinach', 'Beans'], 'tn');
  assert.equal(calls, 1); assert.ok(again.translations.every((x) => x.source === 'cache'));
  await tr.translate(['Beans'], 've');   // a different target is a different cache entry
  assert.equal(calls, 2);
});
test('translate: on AI failure (timeout, bad JSON, wrong count) English comes back, status 200, nothing cached', async () => {
  const { app } = make('timeout');
  const r = await post(app, { texts: ['Publish', 'Reserve'], target: 'st' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().fallback, true);
  assert.deepEqual(r.json().translations.map((x) => [x.text, x.translated]), [['Publish', false], ['Reserve', false]]);
  for (const bad of ['not json', JSON.stringify({ translations: ['only one'] })]) {
    const tr = createTranslator({ name: 'x', translate: async () => bad });
    const o = await tr.translate(['a b', 'c d'], 'ss');
    assert.equal(o.fallback, true); assert.deepEqual(o.translations.map((x) => x.text), ['a b', 'c d']); assert.equal(tr.cache.size, 0);
  }
});
test('translate: numbers, prices (R..), kg, dates, names and {placeholders} are kept; output that changes them is rejected', async () => {
  assert.match(TRANSLATE_SYSTEM_PROMPT, /numbers, prices/); assert.match(TRANSLATE_SYSTEM_PROMPT, /names/); assert.match(TRANSLATE_SYSTEM_PROMPT, /placeholders/);
  assert.match(buildTranslatePrompt(['x'], 'nr'), /isiNdebele \(nr\)/);
  const src = 'Lindiwe Zulu reserved 10 kg spinach at R18.50/kg for Sat 31 Oct 2026, {n} items';
  const ok = await createTranslator(createMockProvider()).translate([src], 'xh');
  const out = ok.translations[0].text;
  for (const keep of ['Lindiwe Zulu', '10 kg', 'R18.50', '31 Oct 2026', '{n}']) assert.ok(out.includes(keep), keep);
  const mangled = await createTranslator(createMockProvider({ behaviour: 'translate-mangle' })).translate([src], 'xh');
  assert.equal(mangled.translations[0].text, src); assert.equal(mangled.translations[0].translated, false);
});
test('translate: the local UI proxy reaches /translate (no token in the browser)', async () => {
  const { app } = make();
  const r = await app.inject({ method: 'POST', url: '/ui/api/v1/translate', remoteAddress: '127.0.0.1', headers: { host: 'localhost:3000', 'x-requested-with': 'mzansi-ui', 'content-type': 'application/json' }, payload: JSON.stringify({ texts: ['Market'], target: 'af' }) });
  assert.equal(r.statusCode, 200); assert.equal(r.json().translations[0].text, '[af] Market');
});

// ---- web UI language picker (pure module code; no browser)
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
test('UI picker: 11 languages, each in its own language; English when nothing is saved; a manual pick is saved', async () => {
  const i18n = await import('../apps/web/public/assets/js/i18n.js');
  assert.equal(i18n.getLang(), 'en', 'no saved choice => English (no device-language detection)');
  assert.deepEqual([...i18n.LANG_CODES].sort(), [...CODES].sort());
  assert.deepEqual(Object.fromEntries(i18n.LANGS), { en: 'English', af: 'Afrikaans', nr: 'isiNdebele', xh: 'isiXhosa', zu: 'isiZulu', nso: 'Sepedi', st: 'Sesotho', tn: 'Setswana', ss: 'siSwati', ve: 'Tshivenda', ts: 'Xitsonga' });
  assert.equal(i18n.pickLang(null), 'en'); assert.equal(i18n.pickLang('fr'), 'en'); assert.equal(i18n.pickLang('af-ZA'), 'en'); assert.equal(i18n.pickLang('ts'), 'ts');
  i18n.setLang('xh'); assert.equal(store.get('mf.lang'), 'xh'); assert.equal(i18n.getLang(), 'xh');
  const { langToggle } = await import('../apps/web/public/assets/js/views.js');
  const h = String(langToggle());
  assert.equal((h.match(/<option /g) || []).length, 11); assert.match(h, /<option value="xh" lang="xh" selected>isiXhosa<\/option>/);
  assert.ok(!/glow|box-shadow|outline/.test(h));
});
test('UI picker: hand-written isiZulu first, then AI for missing strings, user content via tx(); show original switch', async () => {
  const i18n = await import('../apps/web/public/assets/js/i18n.js');
  i18n.setLang('zu');
  assert.equal(i18n.t('mk_publish'), 'Shicilela');                         // hand-written zuMarket line wins
  i18n.takeMissing(); i18n.beginRender();
  assert.equal(i18n.t('mk_notes'), 'Notes');                               // no zu line yet => English, queued for AI
  assert.equal(i18n.tx('Spinach day'), 'Spinach day');
  assert.deepEqual(i18n.takeMissing().sort(), ['Notes', 'Spinach day']);
  i18n.storeAi('zu', [['Notes', 'Amanothi'], ['Spinach day', null]]);
  assert.equal(i18n.t('mk_notes'), 'Amanothi'); assert.equal(i18n.renderUsedAi(), true);
  assert.equal(i18n.tx('Spinach day'), 'Spinach day'); assert.deepEqual(i18n.takeMissing(), [], 'a failed string is not retried (no render loop)');
  i18n.toggleOriginal(); assert.equal(i18n.t('mk_notes'), 'Notes'); assert.equal(i18n.t('mk_publish'), 'Publish'); i18n.toggleOriginal();
  i18n.setLang('en'); assert.equal(i18n.tx('Spinach day'), 'Spinach day'); assert.deepEqual(i18n.takeMissing(), []);
});

test('advice: the irrigation reason is translated for every language except en; hand-written isiZulu wins; litres kept', async () => {
  const i18n = await import('../apps/web/public/assets/js/i18n.js');
  const { reasonTextFor } = await import('../apps/web/public/assets/js/views.js');
  const plot = { plotId: 1, plotName: 'Maize field A', dryThresholdPct: 30 };
  const f = { soilMoisturePct: 22, dryThresholdPct: 30 };
  const s = { plotId: 1, action: 'irrigate', litres: 120, status: 'pending_approval', reason: 'Soil moisture on Maize field A is 22%, below the dry threshold of 30%. Irrigate 120 L.' };
  i18n.setLang('en'); i18n.takeMissing();
  assert.equal(reasonTextFor(s, plot, f), s.reason); assert.deepEqual(i18n.takeMissing(), []);
  for (const code of ['st', 'xh', 'af', 'nso', 'tn', 'ss', 've', 'ts', 'nr']) {
    i18n.setLang(code); i18n.takeMissing();
    assert.equal(reasonTextFor(s, plot, f), s.reason, 'English until the AI answers');
    assert.deepEqual(i18n.takeMissing(), [s.reason], code);
  }
  const tr = await createTranslator(createMockProvider()).translate([s.reason], 'st');
  for (const keep of ['22%', '30%', '120 L', 'Maize field A']) assert.ok(tr.translations[0].text.includes(keep), keep);
  i18n.storeAi('st', [[s.reason, tr.translations[0].text]]); i18n.setLang('st'); i18n.beginRender();
  assert.equal(reasonTextFor(s, plot, f), tr.translations[0].text); assert.equal(i18n.renderUsedAi(), true);
  i18n.toggleOriginal(); assert.equal(reasonTextFor(s, plot, f), s.reason); i18n.toggleOriginal();
  i18n.setLang('zu'); i18n.takeMissing();
  const zuS = { ...s, reason: 'Umswakama e-Maize field A ungu-22%.' };
  reasonTextFor(zuS, plot, f); assert.deepEqual(i18n.takeMissing(), [], 'isiZulu advice with hand-written lines is not sent to the AI');
});
test('advice: rule-check titles and explanations go through the same pipeline (missing in st => queued)', async () => {
  const i18n = await import('../apps/web/public/assets/js/i18n.js');
  i18n.setLang('st'); i18n.takeMissing();
  const out = [i18n.t('r_RAIN_DETECTED'), i18n.t('rej_why_RAIN_DETECTED')];
  const q = i18n.takeMissing();
  assert.equal(q.length, 2); assert.deepEqual(out, q);
  i18n.setLang('en');
});
test('live refresh: main.js queues translation after the 30 s dashboard and plot redraws', () => {
  const src = readFileSync(new URL('../apps/web/public/assets/js/main.js', import.meta.url), 'utf8');
  assert.ok(/drawDashboard\(x\); afterLiveDraw\(\)/.test(src)); assert.ok(/drawPlotLive\(plot, rd\); afterLiveDraw\(\)/.test(src));
});
