// npm test : one command, all suites that can run on any machine. Prints honest totals.
//  1. OpenEdge contract/rule cases against mock-pasoe (Node port of the ABL rules)
//  2. API eval + device cases, OE_MODE=mock (in-process)
//  4. sim/ unit tests; 5. simulator against the Node API
//  6. eval/fixes.test.mjs: unit/resilience tests for the QA bug fixes (litres on hold/notify, OpenEdge outage timing, calendar dates)
//  3. API eval + device cases through the real PASOE HTTP client path, against the mock-pasoe HTTP server
//  7. eval/ui.test.mjs: web UI (static routes, local-only proxy, demo tools, API shapes the UI reads, front-end file checks)
//  9. eval/market.test.mjs: harvest-day market rule edges and the /api/v1/market routes (two-step publish and cancel). Cases MK01 to MK51 are part of suite 1.
// 11. eval/audit-chain.test.mjs: audit hash chain (feature 21). AUD03-AUD05 are part of suite 1.
// 10. eval/translate.test.mjs: dynamic AI translation (11 languages), cache, fallback, the language picker.
// 13. eval/doctor.test.mjs: plant doctor (mock AI): photo limits, server dose strip, fallback, DOSE_BLOCKED via OpenEdge, approval. Cases DR01 to DR31 are part of suite 1.
// 12. eval/weather.test.mjs: weather alerts (no AI): seed labelling, rule edges, /api/v1 weather routes. Cases WX01 to WX28 are part of suite 1.
//  8. eval/coop.test.mjs: co-op rule unit tests (pro rata rounding, caps, approve re-check, payouts, audit). The co-op contract cases CO01 to CO76 are part of suite 1.
// The same contract cases run against the REAL ABL code on Windows with scripts\oe-run.ps1 -Action test (see docs/NOTES.md).
import { readFileSync } from 'node:fs';
import { createStore } from '../mock-pasoe/store.js';
import { handle } from '../mock-pasoe/handler.js';
import { report } from './match.mjs';
import { runApiSuites } from './run-api.mjs';
import { runSimAgainstApi } from './run-sim-api.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const totals = { pass: 0, fail: 0, intentional: 0, unexpected: 0 };
const add = (r) => { totals.pass += r.pass; totals.fail += r.fail; totals.intentional += r.intentional; totals.unexpected += r.unexpectedPass; };

const cases = JSON.parse(readFileSync(new URL('./oe-contract-cases.json', import.meta.url), 'utf8')).cases;
const store = createStore();
const res = new Map();
for (const c of cases) { const r = handle(store, c.request.method, c.request.path, c.request.body ?? {}); res.set(c.id, { id: c.id, status: r.status, body: JSON.parse(JSON.stringify(r.body)) }); }
console.log('\n=== 1. OpenEdge rules + contract (mock-pasoe) ===');
add(report('mock-pasoe contract', cases, res));

for (const mode of ['mock', 'pasoe-mock']) {
  console.log(`\n=== API suites, oe=${mode} ===`);
  for (const s of await runApiSuites(mode)) add(report(`${s.file} [oe=${mode}]`, s.cases, s.results));
}
console.log('\n=== 4. ESP32 feed: simulator unit tests (sim/, node:test) ===');
const sim = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: fileURLToPath(new URL('../sim', import.meta.url)), encoding: 'utf8' });
const simPass = Number((/^# pass (\d+)/m.exec(sim.stdout) || [])[1] || 0), simFail = Number((/^# fail (\d+)/m.exec(sim.stdout) || [])[1] || 0);
console.log(`  sim unit tests: ${simPass} passed, ${simFail} failed`);
totals.pass += simPass; totals.fail += simFail + (sim.status === 0 ? 0 : (simFail ? 0 : 1));

console.log('\n=== 5. ESP32 simulator against the real Node API (OE_MODE=mock) ===');
for (const r of await runSimAgainstApi()) { console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.title}${r.ok ? '' : '\n      ' + r.detail}`); if (r.ok) totals.pass++; else totals.fail++; }
console.log('  (firmware C++ unit tests need PlatformIO: cd firmware/esp32 && pio test -e native, 15 tests; see docs/NOTES.md)');

console.log('\n=== 6. Bug-fix tests: litres only on irrigate, OpenEdge outage timing, calendar dates (eval/fixes.test.mjs, node:test) ===');
const fixes = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./fixes.test.mjs', import.meta.url))], { encoding: 'utf8' });
const fxPass = Number((/^# pass (\d+)/m.exec(fixes.stdout) || [])[1] || 0), fxFail = Number((/^# fail (\d+)/m.exec(fixes.stdout) || [])[1] || 0);
for (const m of fixes.stdout.matchAll(/^(not ok|ok) \d+ - (.*)$/gm)) console.log(`  ${m[1] === 'ok' ? 'PASS' : 'FAIL'}  ${m[2]}`);
console.log(`  bug-fix tests: ${fxPass} passed, ${fxFail} failed`);
totals.pass += fxPass; totals.fail += fxFail + (fixes.status === 0 ? 0 : (fxFail ? 0 : 1));

console.log('\n=== 7. Web UI: static routes, local-only proxy, demo tools, API shapes, front-end files (eval/ui.test.mjs, node:test) ===');
const uiTests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./ui.test.mjs', import.meta.url))], { encoding: 'utf8' });
const uiPass = Number((/^# pass (\d+)/m.exec(uiTests.stdout) || [])[1] || 0), uiFail = Number((/^# fail (\d+)/m.exec(uiTests.stdout) || [])[1] || 0);
for (const m of uiTests.stdout.matchAll(/^(not ok|ok) \d+ - (.*)$/gm)) console.log(`  ${m[1] === 'ok' ? 'PASS' : 'FAIL'}  ${m[2]}`);
console.log(`  web UI tests: ${uiPass} passed, ${uiFail} failed`);
totals.pass += uiPass; totals.fail += uiFail + (uiTests.status === 0 ? 0 : (uiFail ? 0 : 1));

console.log('\n=== 8. Co-op rules: pro rata maths, caps, approval re-check, payouts, audit (eval/coop.test.mjs, node:test) ===');
const coopTests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./coop.test.mjs', import.meta.url))], { encoding: 'utf8' });
const coPass = Number((/^# pass (\d+)/m.exec(coopTests.stdout) || [])[1] || 0), coFail = Number((/^# fail (\d+)/m.exec(coopTests.stdout) || [])[1] || 0);
for (const m of coopTests.stdout.matchAll(/^(not ok|ok) \d+ - (.*)$/gm)) console.log(`  ${m[1] === 'ok' ? 'PASS' : 'FAIL'}  ${m[2]}`);
console.log(`  co-op tests: ${coPass} passed, ${coFail} failed`);
totals.pass += coPass; totals.fail += coFail + (coopTests.status === 0 ? 0 : (coFail ? 0 : 1));

console.log('\n=== 9. Harvest-day market: rule edges, /api/v1/market, confirmation (eval/market.test.mjs, node:test) ===');
const mkTests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./market.test.mjs', import.meta.url))], { encoding: 'utf8' });
const mkPass = Number((/^# pass (\d+)/m.exec(mkTests.stdout) || [])[1] || 0), mkFail = Number((/^# fail (\d+)/m.exec(mkTests.stdout) || [])[1] || 0);
for (const m of mkTests.stdout.matchAll(/^(not ok|ok) \d+ - (.*)$/gm)) console.log(`  ${m[1] === 'ok' ? 'PASS' : 'FAIL'}  ${m[2]}`);
console.log(`  market tests: ${mkPass} passed, ${mkFail} failed`);
totals.pass += mkPass; totals.fail += mkFail + (mkTests.status === 0 ? 0 : (mkFail ? 0 : 1));

console.log('\n=== 10. AI translation: 11 official languages, /api/v1/translate, cache, fallback, language picker (eval/translate.test.mjs, node:test) ===');
const trTests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./translate.test.mjs', import.meta.url))], { encoding: 'utf8' });
const trPass = Number((/^# pass (\d+)/m.exec(trTests.stdout) || [])[1] || 0), trFail = Number((/^# fail (\d+)/m.exec(trTests.stdout) || [])[1] || 0);
for (const m of trTests.stdout.matchAll(/^(not ok|ok) \d+ - (.*)$/gm)) console.log(`  ${m[1] === 'ok' ? 'PASS' : 'FAIL'}  ${m[2]}`);
console.log(`  translation tests: ${trPass} passed, ${trFail} failed`);
totals.pass += trPass; totals.fail += trFail + (trTests.status === 0 ? 0 : (trFail ? 0 : 1));

console.log('\n=== 11. Audit hash chain: links, tamper detection, legacy rows, ABL parity constant, /api/v1/audit/verify (eval/audit-chain.test.mjs, node:test) ===');
const auTests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./audit-chain.test.mjs', import.meta.url))], { encoding: 'utf8' });
const auPass = Number((/^# pass (\d+)/m.exec(auTests.stdout) || [])[1] || 0), auFail = Number((/^# fail (\d+)/m.exec(auTests.stdout) || [])[1] || 0);
for (const m of auTests.stdout.matchAll(/^(not ok|ok) \d+ - (.*)$/gm)) console.log(`  ${m[1] === 'ok' ? 'PASS' : 'FAIL'}  ${m[2]}`);
console.log(`  audit chain tests: ${auPass} passed, ${auFail} failed`);
totals.pass += auPass; totals.fail += auFail + (auTests.status === 0 ? 0 : (auFail ? 0 : 1));

console.log('\n=== 12. Weather alerts: example forecast, ABL rules, acknowledge, thresholds (eval/weather.test.mjs, node:test) ===');
const wxTests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./weather.test.mjs', import.meta.url))], { encoding: 'utf8' });
const wxPass = Number((/^# pass (\d+)/m.exec(wxTests.stdout) || [])[1] || 0), wxFail = Number((/^# fail (\d+)/m.exec(wxTests.stdout) || [])[1] || 0);
for (const m of wxTests.stdout.matchAll(/^(not ok|ok) \d+ - (.*)$/gm)) console.log(`  ${m[1] === 'ok' ? 'PASS' : 'FAIL'}  ${m[2]}`);
console.log(`  weather tests: ${wxPass} passed, ${wxFail} failed`);
totals.pass += wxPass; totals.fail += wxFail + (wxTests.status === 0 ? 0 : (wxFail ? 0 : 1));

console.log('\n=== 13. Plant doctor: photos, server check, DOSE_BLOCKED, fallback, farmer approval (eval/doctor.test.mjs, node:test) ===');
const drTests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(new URL('./doctor.test.mjs', import.meta.url))], { encoding: 'utf8' });
const drPass = Number((/^# pass (\d+)/m.exec(drTests.stdout) || [])[1] || 0), drFail = Number((/^# fail (\d+)/m.exec(drTests.stdout) || [])[1] || 0);
for (const m of drTests.stdout.matchAll(/^(not ok|ok) \d+ - (.*)$/gm)) console.log(`  ${m[1] === 'ok' ? 'PASS' : 'FAIL'}  ${m[2]}`);
console.log(`  plant doctor tests: ${drPass} passed, ${drFail} failed`);
totals.pass += drPass; totals.fail += drFail + (drTests.status === 0 ? 0 : (drFail ? 0 : 1));

console.log(`\nTOTAL: ${totals.pass} passed, ${totals.fail} failed, ${totals.intentional} intentional failures confirmed (by design), ${totals.unexpected} unexpected passes of intentional cases`);
process.exit(totals.fail === 0 && totals.unexpected === 0 ? 0 : 1);
