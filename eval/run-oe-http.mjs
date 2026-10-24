// node eval/run-oe-http.mjs [baseUrl] : run the shared OpenEdge contract cases over HTTP against a running
// PAS for OpenEdge instance (web/FarmHandler.cls -> farm-api.p) or against mock-pasoe (node mock-pasoe/server.js).
// Cases are stateful and include co-op cases CO01-CO76: reseed the database first (scripts/oe-run.ps1 -Action seed).
// The same comparison lives in eval/compare-oe.mjs (--http, and --coop for CO01-CO76 only).
import { loadCases, fetchHttpResults } from './compare-oe.mjs';
import { report, checkCase } from './match.mjs';

const base = (process.argv[2] || process.env.OE_BASE_URL || 'http://localhost:8820/web').replace(/\/+$/, '');
const auth = process.env.OE_AUTH ? { Authorization: 'Basic ' + Buffer.from(process.env.OE_AUTH).toString('base64') } : {};
const cases = loadCases();
const results = await fetchHttpResults(cases, base, auth);
const r = report(`OpenEdge contract over HTTP (${base})`, cases, results);
const coop = cases.filter((c) => c.id.startsWith('CO'));
let coopFail = 0;
for (const c of coop) {
  const res = results.get(c.id);
  if (!res || checkCase(c, res).length > 0) coopFail++;
}
console.log(`co-op cases CO01-CO76: ${coop.length - coopFail} passed, ${coopFail} failed (${coop.length} cases)`);
process.exit(r.fail === 0 && r.unexpectedPass === 0 ? 0 : 1);
