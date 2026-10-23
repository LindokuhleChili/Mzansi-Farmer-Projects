// node eval/compare-oe.mjs <results.json>  - check raw responses (e.g. from the real ABL run) against the shared cases
import { readFileSync } from 'node:fs';
import { report } from './match.mjs';
const cases = JSON.parse(readFileSync(new URL('./oe-contract-cases.json', import.meta.url), 'utf8')).cases;
const file = process.argv[2];
const results = new Map(JSON.parse(readFileSync(file, 'utf8')).results.map((r) => [r.id, r]));
const r = report(`OpenEdge ABL contract (${file})`, cases, results);
process.exit(r.fail === 0 && r.unexpectedPass === 0 ? 0 : 1);
