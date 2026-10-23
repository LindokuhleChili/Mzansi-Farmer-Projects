// npm test : one command, all suites that can run on any machine. Prints honest totals.
//  1. OpenEdge contract/rule cases against mock-pasoe (Node port of the ABL rules)
//  2. API eval + device cases, OE_MODE=mock (in-process)
//  3. API eval + device cases through the real PASOE HTTP client path, against the mock-pasoe HTTP server
// The same contract cases run against the REAL ABL code on Windows with scripts\oe-run.ps1 -Action test (see docs/NOTES.md).
import { readFileSync } from 'node:fs';
import { createStore } from '../mock-pasoe/store.js';
import { handle } from '../mock-pasoe/handler.js';
import { report } from './match.mjs';
import { runApiSuites } from './run-api.mjs';

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
console.log(`\nTOTAL: ${totals.pass} passed, ${totals.fail} failed, ${totals.intentional} intentional failures confirmed (by design), ${totals.unexpected} unexpected passes of intentional cases`);
process.exit(totals.fail === 0 && totals.unexpected === 0 ? 0 : 1);
