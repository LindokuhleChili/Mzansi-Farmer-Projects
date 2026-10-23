// node eval/run-oe-http.mjs [baseUrl] : run the shared OpenEdge contract cases over HTTP against a running
// PAS for OpenEdge instance (web/FarmHandler.cls -> farm-api.p) or against mock-pasoe (node mock-pasoe/server.js).
// Cases are stateful: reseed the database first (scripts/oe-run.ps1 -Action seed).
import { readFileSync } from 'node:fs';
import { report } from './match.mjs';
const base = (process.argv[2] || process.env.OE_BASE_URL || 'http://localhost:8820/web').replace(/\/+$/, '');
const auth = process.env.OE_AUTH ? { Authorization: 'Basic ' + Buffer.from(process.env.OE_AUTH).toString('base64') } : {};
const cases = JSON.parse(readFileSync(new URL('./oe-contract-cases.json', import.meta.url), 'utf8')).cases;
const results = new Map();
for (const c of cases) {
  const { method, path, body } = c.request;
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...auth },
    body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { nonJson: text.slice(0, 200) }; }
  results.set(c.id, { id: c.id, status: res.status, body: parsed });
}
const r = report(`OpenEdge contract over HTTP (${base})`, cases, results);
process.exit(r.fail === 0 && r.unexpectedPass === 0 ? 0 : 1);
