// node eval/run-oe-mock.mjs : run the shared OpenEdge contract cases against mock-pasoe (in-process).
import { readFileSync } from 'node:fs';
import { createStore } from '../mock-pasoe/store.js';
import { handle } from '../mock-pasoe/handler.js';
import { report } from './match.mjs';
const cases = JSON.parse(readFileSync(new URL('./oe-contract-cases.json', import.meta.url), 'utf8')).cases;
const store = createStore();
const results = new Map();
for (const c of cases) {
  const r = handle(store, c.request.method, c.request.path, c.request.body ?? {});
  // round-trip through JSON so undefined/Date quirks match a real HTTP response
  results.set(c.id, { id: c.id, status: r.status, body: JSON.parse(JSON.stringify(r.body)) });
}
const r = report('mock-pasoe contract', cases, results);
process.exit(r.fail === 0 && r.unexpectedPass === 0 ? 0 : 1);
