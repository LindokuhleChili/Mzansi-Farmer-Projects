// Runs eval/device-cases.json then eval/api-cases.json against the API app, in-process (Fastify inject).
// usage: node eval/run-api.mjs [--oe=mock|pasoe-mock|pasoe-real]  (pasoe-real = OE_BASE_URL, a real PASOE; reseed first)
// usage (orig): node eval/run-api.mjs [--oe=mock|pasoe-mock]   (pasoe-mock = real HTTP PASOE client path against the mock-pasoe HTTP server)
import { readFileSync } from 'node:fs';
import { mkdtempSync, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';
import { createMockServer } from '../mock-pasoe/server.js';
import { pathToFileURL } from 'node:url';
import { report } from './match.mjs';

export async function runApiSuites(mode = 'mock') {
  const FIXED_NOW = new Date('2026-10-23T08:10:00Z');
  const clock = () => FIXED_NOW;
  const env = {
    OE_MODE: mode === 'mock' ? 'mock' : 'pasoe', APP_TOKEN: 'test-app-token-fixture',
    DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: 'test-device-token-fixture' }]),
    AI_PROVIDER: 'mock', LOG_LEVEL: 'silent', LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-logs-')),
  };
  let server;
  if (mode === 'pasoe-real') {
    env.OE_BASE_URL = process.env.OE_BASE_URL || 'http://localhost:8820/web';
    if (process.env.OE_AUTH) env.OE_AUTH = process.env.OE_AUTH;
    if (process.env.OE_ADMIN_AUTH) env.OE_ADMIN_AUTH = process.env.OE_ADMIN_AUTH;
  } else if (mode !== 'mock') {
    server = createMockServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    env.OE_BASE_URL = `http://127.0.0.1:${server.address().port}/web`;
  }
  const config = loadConfig(env);
  if (config.problems.length) throw new Error(config.problems.join('; '));
  const oe = createOeClient(config, { clock });
  const provider = createMockProvider({ behaviour: 'normal' });
  const app = buildApp({ config, oe, provider, clock });
  const subst = (v, caps) => {
    if (typeof v === 'string') return v.replace(/\$\{(\w+)\}/g, (_, k) => caps[k] ?? '');
    if (Array.isArray(v)) return v.map((x) => subst(x, caps));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x, caps)]));
    return v;
  };
  const caps = {};
  const out = [];
  for (const file of ['device-cases.json', 'api-cases.json']) {
    const { cases } = JSON.parse(readFileSync(new URL('./' + file, import.meta.url), 'utf8'));
    const results = new Map();
    for (const c of cases) {
      provider.behaviour = c.aiBehaviour || 'normal';
      const headers = {};
      if (c.request.auth === 'app') headers.authorization = `Bearer ${env.APP_TOKEN}`;
      if (c.request.auth === 'device') headers['x-device-token'] = 'test-device-token-fixture';
      if (c.request.auth === 'badtoken') headers['x-device-token'] = 'nope';
      let payload;
      if (c.request.rawBody !== undefined) { payload = c.request.rawBody; headers['content-type'] = 'application/json'; }
      else if (c.request.body !== undefined) { payload = JSON.stringify(subst(c.request.body, caps)); headers['content-type'] = 'application/json'; }
      const res = await app.inject({ method: c.request.method, url: subst(c.request.path, caps), headers, payload });
      let body; try { body = res.json(); } catch { body = res.body; }
      for (const [k, field] of Object.entries(c.capture || {})) caps[k] = body[field];
      results.set(c.id, { id: c.id, status: res.statusCode, body });
    }
    out.push({ file, cases, results });
  }
  await app.close();
  if (server) await new Promise((r) => server.close(r));
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = (process.argv.find((a) => a.startsWith('--oe=')) || '--oe=mock').slice(5);
  const suites = await runApiSuites(mode);
  let bad = 0;
  for (const s of suites) {
    const r = report(`API ${s.file} [oe=${mode}]`, s.cases, s.results);
    bad += r.fail + r.unexpectedPass;
  }
  process.exit(bad ? 1 : 0);
}
