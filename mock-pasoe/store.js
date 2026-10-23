// In-memory stand-in for the OpenEdge database (same tables as openedge/schema/002-farm-ops.df). EXAMPLE DATA ONLY.
import { readFileSync } from 'node:fs';
import { parseIso } from './time.js';

const SEED_PATH = new URL('../openedge/data/seed.json', import.meta.url);

export function createStore(seedPath = SEED_PATH) {
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  const store = {
    farms: seed.farms.map((f) => ({ ...f })),
    plots: seed.plots.map((p) => ({ ...p })),
    readings: [], suggestions: [], audit: [],
    seq: { reading: 1000, suggestion: 0, audit: 0 },
    latestReading(plotId) {
      let best = null;
      for (const r of this.readings) if (r.plotId === plotId && (!best || r.readAt > best.readAt)) best = r;
      return best;
    },
  };
  for (const r of seed.readings) {
    store.readings.push({ readingId: ++store.seq.reading, plotId: r.plotId, deviceId: r.deviceId, readAt: parseIso(r.timestamp),
      soilMoisturePct: r.soilMoisturePct, temperatureC: r.temperatureC, humidityPct: r.humidityPct, raining: !!r.raining });
  }
  for (const s of seed.suggestions) {
    store.suggestions.push({ suggestionId: ++store.seq.suggestion, plotId: s.plotId, createdAt: parseIso(s.createdAt), decidedAt: parseIso(s.decidedAt),
      action: s.action, litres: s.litres, reason: s.reason, provider: s.provider, status: s.status, verdict: s.verdict, rejectReasons: [], requestId: 'seed' });
  }
  return store;
}
