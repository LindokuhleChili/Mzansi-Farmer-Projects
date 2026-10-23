#!/usr/bin/env node
'use strict';
// Simulated ESP32: generates readings for a scenario and POSTs them to the API.
// Usage: node esp32-sim.js --scenario normal|drought|stale|invalid [--url URL] [--interval S]
//        [--count N] [--dry-run] [--device-id ID] [--plot-id N] [--seed N]
//        [--stale-after N] [--stale-mode stop|old]
// The device token comes from the DEVICE_TOKEN env var (never a CLI flag).
const { parseArgs } = require('node:util');
const { CONTRACT, buildPayload } = require('./payload');
const { SCENARIOS, SCENARIO_NAMES, makeRng } = require('./scenarios');

const HELP = `esp32-sim.js - simulate the Mzansi ESP32 sensor feed

  --scenario <${SCENARIO_NAMES.join('|')}>   default: normal
  --url <base url>        default: http://localhost:3000   (path ${CONTRACT.path} is appended)
  --interval <seconds>    default: 30 (fractions allowed)
  --count <n>             readings to generate; default 10 (0 = run until Ctrl+C)
  --dry-run               print payloads, send nothing (no token needed)
  --device-id <id>        default: esp32-01
  --plot-id <int>         default: 1
  --seed <int>            default: 1 (deterministic values)
  --stale-after <n>       stale scenario: readings sent before it goes quiet; default 3
  --stale-mode <stop|old> stale: "stop" = go silent (default); "old" = keep sending but with old timestamps
  --max-attempts <n>      send attempts per reading on network error/5xx; default 4
  --help
Env: DEVICE_TOKEN (required unless --dry-run)
Scenarios: normal = plausible fluctuation; drought = soil decays to ~8%, hot, dry air;
           stale = a few readings then stops (or old timestamps); invalid = soilMoisturePct 150 (expect 400).`;

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenario: { type: 'string', default: 'normal' },
      url: { type: 'string', default: 'http://localhost:3000' },
      interval: { type: 'string', default: '30' },
      count: { type: 'string', default: '10' },
      'dry-run': { type: 'boolean', default: false },
      'device-id': { type: 'string', default: 'esp32-01' },
      'plot-id': { type: 'string', default: '1' },
      seed: { type: 'string', default: '1' },
      'stale-after': { type: 'string', default: '3' },
      'stale-mode': { type: 'string', default: 'stop' },
      'max-attempts': { type: 'string', default: '4' },
      help: { type: 'boolean', default: false },
    },
  });
  const o = {
    scenario: values.scenario,
    url: values.url.replace(/\/+$/, ''),
    intervalS: Number(values.interval),
    count: Number(values.count),
    dryRun: values['dry-run'],
    deviceId: values['device-id'],
    plotId: Number(values['plot-id']),
    seed: Number(values.seed),
    staleAfter: Number(values['stale-after']),
    staleMode: values['stale-mode'],
    maxAttempts: Number(values['max-attempts']),
    help: values.help,
  };
  if (o.help) return o;
  if (!SCENARIO_NAMES.includes(o.scenario)) throw new Error(`--scenario must be one of ${SCENARIO_NAMES.join(', ')}`);
  if (!(o.intervalS >= 0)) throw new Error('--interval must be >= 0');
  if (!Number.isInteger(o.count) || o.count < 0) throw new Error('--count must be an integer >= 0');
  if (!Number.isInteger(o.plotId)) throw new Error('--plot-id must be an integer');
  if (!Number.isInteger(o.staleAfter) || o.staleAfter < 0) throw new Error('--stale-after must be an integer >= 0');
  if (!['stop', 'old'].includes(o.staleMode)) throw new Error('--stale-mode must be stop or old');
  if (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1) throw new Error('--max-attempts must be >= 1');
  return o;
}

/**
 * Timestamp for reading `i`. Always unique (strictly increasing, whole seconds) so
 * the server never sees a duplicate (deviceId+timestamp) => no accidental 409s.
 * In stale "old" mode, readings after `staleAfter` are stamped 2h in the past,
 * still unique and counting backwards from there.
 */
function makeTimestampSource(opts, now = () => Date.now()) { // now(i) may use the reading index (dry-run virtual clock)
  let lastMs = 0;
  let oldCursorMs = null;
  return (i) => {
    const asOld = opts.scenario === 'stale' && opts.staleMode === 'old' && i >= opts.staleAfter;
    if (asOld) {
      if (oldCursorMs === null) oldCursorMs = Math.floor(now(i) / 1000) * 1000 - 2 * 3600 * 1000;
      oldCursorMs -= 1000;
      return new Date(oldCursorMs);
    }
    let ms = Math.floor(now(i) / 1000) * 1000;
    if (ms <= lastMs) ms = lastMs + 1000;
    lastMs = ms;
    return new Date(ms);
  };
}

/** Pure: the readings the sim would send, in order. `nextTs(i)` supplies timestamps. */
function* generateReadings(opts, nextTs) {
  const rng = makeRng(opts.seed);
  const gen = SCENARIOS[opts.scenario];
  for (let i = 0; opts.count === 0 || i < opts.count; i++) {
    if (opts.scenario === 'stale' && opts.staleMode === 'stop' && i >= opts.staleAfter) return;
    const v = gen(i, rng, { steps: opts.count >= 10 ? opts.count : 40 });
    yield buildPayload({ deviceId: opts.deviceId, plotId: opts.plotId, timestamp: nextTs(i), ...v });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mirrors firmware policy: 2xx ok, 409 skip, 400/401(+other 4xx) drop, network/5xx/408/429 retry. */
function classify(status) {
  if (status >= 200 && status < 300) return 'success';
  if (status === 409) return 'duplicate';
  if (status === 401) return 'auth';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'bad';
  return 'retry'; // 0 = network error, 5xx, anything unexpected
}

async function send(payload, { url, token, maxAttempts, backoffBaseMs = 500, backoffMaxMs = 8000, log = console.log, fetchImpl = fetch }) {
  const target = url + CONTRACT.path;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let status = 0;
    let text = '';
    try {
      const res = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CONTRACT.authHeader]: token },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = e.cause?.code || e.message;
    }
    const kind = classify(status);
    if (kind === 'success') { log(`  -> ${status} stored ${text}`); return 'success'; }
    if (kind === 'duplicate') { log(`  -> 409 duplicate, treated as success (skip)`); return 'duplicate'; }
    if (kind === 'auth') { log(`  -> 401 unauthorized: check DEVICE_TOKEN; not retrying`); return 'auth'; }
    if (kind === 'bad') {
      let field = '?';
      try { field = JSON.parse(text).field ?? '?'; } catch { /* non-JSON body */ }
      log(`  -> ${status} rejected (field=${field}) ${text}; not retrying`);
      return 'bad';
    }
    const wait = Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt);
    log(`  -> ${status || 'network error'} ${text}; attempt ${attempt + 1}/${maxAttempts}, retry in ${wait} ms`);
    if (attempt + 1 < maxAttempts) await sleep(wait);
  }
  log('  -> giving up on this reading');
  return 'failed';
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let opts;
  try { opts = parseCli(argv); } catch (e) { console.error(`error: ${e.message}\n\n${HELP}`); return 2; }
  if (opts.help) { console.log(HELP); return 0; }
  const token = env.DEVICE_TOKEN;
  if (!opts.dryRun && !token) { console.error('error: set DEVICE_TOKEN in the environment (or use --dry-run)'); return 2; }

  // Dry-run doesn't wait, so use a virtual clock spaced by --interval to look realistic.
  const t0 = Date.now();
  const nextTs = makeTimestampSource(opts, opts.dryRun ? (i) => t0 + i * opts.intervalS * 1000 : () => Date.now());
  const readings = generateReadings(opts, nextTs);
  console.log(`[sim] scenario=${opts.scenario} device=${opts.deviceId} plot=${opts.plotId} interval=${opts.intervalS}s count=${opts.count || '∞'} ${opts.dryRun ? '(dry-run)' : `-> ${opts.url}${CONTRACT.path}`}`);
  let n = 0;
  const tally = {};
  for (const payload of readings) {
    if (n > 0 && opts.intervalS > 0 && !opts.dryRun) await sleep(opts.intervalS * 1000);
    n++;
    console.log(`[${n}] ${JSON.stringify(payload)}`);
    if (!opts.dryRun) {
      const r = await send(payload, { url: opts.url, token, maxAttempts: opts.maxAttempts });
      tally[r] = (tally[r] || 0) + 1;
    }
  }
  if (opts.scenario === 'stale' && opts.staleMode === 'stop') console.log(`[sim] stale scenario: stopped sending after ${n} reading(s); the feed is now silent.`);
  console.log(`[sim] done, ${n} reading(s) generated${opts.dryRun ? '' : ` results=${JSON.stringify(tally)}`}`);
  return opts.dryRun || !(tally.failed || tally.auth) ? 0 : 1;
}

module.exports = { parseCli, makeTimestampSource, generateReadings, classify, send, main };

if (require.main === module) main().then((c) => process.exit(c));
