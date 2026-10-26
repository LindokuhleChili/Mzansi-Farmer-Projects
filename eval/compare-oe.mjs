// Compare the shared OpenEdge contract cases (irrigation + co-op CO01-CO76 + market MK01-MK51) with real ABL output.
//
// Batch, after openedge/src/run-contract.p has written a results file (reseed first; the cases are stateful):
//   node eval/compare-oe.mjs eval/abl-results.json
//   node eval/compare-oe.mjs eval/abl-results.json --coop
//   node eval/compare-oe.mjs eval/abl-results.json --market
//
// HTTP, against PASOE (web/FarmHandler.cls -> farm-api.p) or mock-pasoe. Reseed first.
//   node eval/compare-oe.mjs --http http://localhost:8820/web
//   node eval/compare-oe.mjs --http http://localhost:8820/web --coop
//   node eval/compare-oe.mjs --http                 # OE_BASE_URL, else http://localhost:8820/web
// With PASOE basic login, set OE_AUTH=farmapi:<password> and OE_ADMIN_AUTH=farmadmin:<password> (admin routes).
//
// --coop keeps only case ids that start with CO, --market only MK (harvest-day market, docs/MARKET.md).
// A full run already includes those cases and prints a co-op and a market subtotal.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkCase, report } from './match.mjs';
import { isAdminRoute } from '../apps/api/src/oe/client.js';

export function loadCases() {
  return JSON.parse(readFileSync(new URL('./oe-contract-cases.json', import.meta.url), 'utf8')).cases;
}

export function isCoopCase(c) {
  return typeof c.id === 'string' && c.id.startsWith('CO');
}

export function isMarketCase(c) {
  return typeof c.id === 'string' && c.id.startsWith('MK');
}

export function selectCases(cases, coopOnly, marketOnly = false) {
  if (coopOnly) return cases.filter(isCoopCase);
  if (marketOnly) return cases.filter(isMarketCase);
  return cases;
}

export function tally(cases, resultsById) {
  let pass = 0, fail = 0, intentional = 0, unexpectedPass = 0;
  for (const c of cases) {
    const res = resultsById.get(c.id);
    const problems = res ? checkCase(c, res) : ['no result recorded'];
    const ok = problems.length === 0;
    if (c.intentionalFail) {
      if (ok) unexpectedPass++;
      else intentional++;
    } else if (ok) pass++;
    else fail++;
  }
  return { pass, fail, intentional, unexpectedPass };
}

export function resultsFromFile(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return new Map(parsed.results.map((r) => [r.id, r]));
}

export async function fetchHttpResults(cases, base, authHeader = {}, adminAuthHeader = authHeader) {
  const root = base.replace(/\/+$/, '');
  const results = new Map();
  for (const c of cases) {
    const { method, path, body } = c.request;
    const res = await fetch(root + path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(isAdminRoute(method, path) ? adminAuthHeader : authHeader) },
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; }
    catch { parsed = { nonJson: text.slice(0, 200) }; }
    results.set(c.id, { id: c.id, status: res.status, body: parsed });
  }
  return results;
}

function httpBase(argv) {
  const i = argv.indexOf('--http');
  if (i < 0) return null;
  const next = argv[i + 1];
  if (next && !next.startsWith('--')) return next;
  return process.env.OE_BASE_URL || 'http://localhost:8820/web';
}

function printCoopSubtotal(cases, results) {
  const coop = cases.filter(isCoopCase);
  if (coop.length === 0) return;
  const t = tally(coop, results);
  console.log(`co-op cases CO01-CO76: ${t.pass} passed, ${t.fail} failed, ${t.intentional} intentional failure(s) confirmed, ${t.unexpectedPass} unexpected pass(es) (${coop.length} cases)`);
}

function printMarketSubtotal(cases, results) {
  const mk = cases.filter(isMarketCase);
  if (mk.length === 0) return;
  const t = tally(mk, results);
  console.log(`market cases MK01-MK${String(mk.length).padStart(2, '0')}: ${t.pass} passed, ${t.fail} failed, ${t.intentional} intentional failure(s) confirmed, ${t.unexpectedPass} unexpected pass(es) (${mk.length} cases)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const coopOnly = argv.includes('--coop');
  const marketOnly = argv.includes('--market');
  const base = httpBase(argv);
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--http');
  const all = loadCases();
  const cases = selectCases(all, coopOnly, marketOnly);
  const only = coopOnly ? ', co-op only' : marketOnly ? ', market only' : '';
  let results;
  let label;
  if (base) {
    const hdr = (cred) => (cred ? { Authorization: 'Basic ' + Buffer.from(cred).toString('base64') } : {});
    const auth = hdr(process.env.OE_AUTH);
    // PASOE basic login: admin routes (blocked terms, alert thresholds) need a PSCAdmin user (OE_ADMIN_AUTH)
    results = await fetchHttpResults(cases, base, auth, process.env.OE_ADMIN_AUTH ? hdr(process.env.OE_ADMIN_AUTH) : auth);
    label = `OpenEdge contract over HTTP (${base}${only})`;
  } else if (file) {
    results = resultsFromFile(file);
    label = `OpenEdge ABL contract (${file}${only})`;
  } else {
    console.error('Usage: node eval/compare-oe.mjs <results.json> [--coop|--market]');
    console.error('       node eval/compare-oe.mjs --http [baseUrl] [--coop|--market]');
    process.exit(2);
  }
  const r = report(label, cases, results);
  const full = !coopOnly && !marketOnly;
  if (full) { printCoopSubtotal(all, results); printMarketSubtotal(all, results); }
  const coop = tally(all.filter(isCoopCase), results), mk = tally(all.filter(isMarketCase), results);
  const subBad = full && (coop.fail > 0 || coop.unexpectedPass > 0 || mk.fail > 0 || mk.unexpectedPass > 0);
  process.exit(r.fail === 0 && r.unexpectedPass === 0 && !subBad ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
