// The ESP32 simulator (sim/esp32-sim.js, same contract as the firmware) against the REAL Node API (OE_MODE=mock, AI mock).
// Spawns the simulator as a child process over real HTTP. Exported function is used by `npm test`.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../apps/api/src/config.js';
import { createOeClient } from '../apps/api/src/oe/client.js';
import { createMockProvider } from '../apps/api/src/ai/provider.js';
import { buildApp } from '../apps/api/src/app.js';

const simPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'sim', 'esp32-sim.js');
const runSim = (args, token) => new Promise((resolve) => {
  const p = spawn(process.execPath, [simPath, ...args], { env: { ...process.env, DEVICE_TOKEN: token } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});

export async function runSimAgainstApi() {
  const TOKEN = 'sim-device-token-fixture';
  const config = loadConfig({ OE_MODE: 'mock', APP_TOKEN: 'sim-app-token-fixture', AI_PROVIDER: 'mock', LOG_LEVEL: 'silent',
    LOG_DIR: mkdtempSync(join(tmpdir(), 'mfo-sim-')), DEVICE_REGISTRY: JSON.stringify([{ deviceId: 'esp32-01', plotId: 1, token: TOKEN }]) });
  const app = buildApp({ config, oe: createOeClient(config), provider: createMockProvider() });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const base = ['--url', url, '--interval', '0', '--max-attempts', '1'];
  const checks = [
    ['sim normal: every reading stored (201)', ['--scenario', 'normal', '--count', '3', ...base], TOKEN, 0, '"success":3'],
    ['sim invalid: API answers 400 with the field name, sim does not retry', ['--scenario', 'invalid', '--count', '1', ...base], TOKEN, 0, '"bad":1'],
    ['sim with a wrong token: 401, no retry', ['--scenario', 'normal', '--count', '1', ...base], 'wrong-token', 1, '"auth":1'],
    ['sim for another plot than the token allows: 400 DEVICE_MISMATCH', ['--scenario', 'normal', '--count', '1', '--plot-id', '2', ...base], TOKEN, 0, '"bad":1'],
  ];
  const results = [];
  for (const [title, args, tok, code, expectText] of checks) {
    const r = await runSim(args, tok);
    results.push({ title, ok: r.code === code && r.out.includes(expectText), detail: r.out.trim().split('\n').slice(-2).join(' | ').slice(0, 300) });
  }
  const stored = await app.inject({ method: 'GET', url: '/api/v1/plots/1/readings?limit=3', headers: { authorization: 'Bearer sim-app-token-fixture' } });
  results.push({ title: 'readings sent by the sim are readable back through the API (from OpenEdge layer)', ok: stored.statusCode === 200 && stored.json().readings.length === 3, detail: `HTTP ${stored.statusCode}` });
  await app.close();
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rs = await runSimAgainstApi();
  let bad = 0;
  for (const r of rs) { console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.title}${r.ok ? '' : '\n      ' + r.detail}`); if (!r.ok) bad++; }
  console.log(`\nsim vs API: ${rs.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}
