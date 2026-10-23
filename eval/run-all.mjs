// npm test : one command, all suites that can run on any machine. Prints honest totals.
//  1. OpenEdge contract/rule cases against mock-pasoe (Node port of the ABL rules)
//  2. API eval + device cases, OE_MODE=mock (in-process)
//  4. sim/ unit tests; 5. simulator against the Node API
//  3. API eval + device cases through the real PASOE HTTP client path, against the mock-pasoe HTTP server
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
const sim = spawnSync(process.execPath, ['--test'], { cwd: fileURLToPath(new URL('../sim', import.meta.url)), encoding: 'utf8' });
const simPass = Number((/^# pass (\d+)/m.exec(sim.stdout) || [])[1] || 0), simFail = Number((/^# fail (\d+)/m.exec(sim.stdout) || [])[1] || 0);
console.log(`  sim unit tests: ${simPass} passed, ${simFail} failed`);
totals.pass += simPass; totals.fail += simFail + (sim.status === 0 ? 0 : (simFail ? 0 : 1));

console.log('\n=== 5. ESP32 simulator against the real Node API (OE_MODE=mock) ===');
for (const r of await runSimAgainstApi()) { console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.title}${r.ok ? '' : '\n      ' + r.detail}`); if (r.ok) totals.pass++; else totals.fail++; }
console.log('  (firmware C++ unit tests need PlatformIO: cd firmware/esp32 && pio test -e native, 15 tests; see docs/NOTES.md)');

console.log(`\nTOTAL: ${totals.pass} passed, ${totals.fail} failed, ${totals.intentional} intentional failures confirmed (by design), ${totals.unexpected} unexpected passes of intentional cases`);
process.exit(totals.fail === 0 && totals.unexpected === 0 ? 0 : 1);
