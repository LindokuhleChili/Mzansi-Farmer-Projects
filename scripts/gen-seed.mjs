// Generates openedge/data/seed.json: FICTIONAL EXAMPLE DATA ONLY (no real farmers, plots or sensors).
// Deterministic: same output every run. Reference time for the demo/tests: 2026-10-23T08:10:00Z.
import { writeFileSync } from 'node:fs';
const t = (iso) => iso;
const mk = (plotId, deviceId, lastIso, soilSeries, temp, hum, raining = false) => {
  const last = Date.parse(lastIso);
  return soilSeries.map((soil, i) => ({
    plotId, deviceId,
    timestamp: new Date(last - (soilSeries.length - 1 - i) * 10 * 60000).toISOString().replace('.000Z', 'Z'),
    soilMoisturePct: soil, temperatureC: temp + (i % 3) * 0.3, humidityPct: hum - (i % 2),
    raining: raining && i === soilSeries.length - 1,
  }));
};
const seed = {
  label: 'EXAMPLE DATA: fictional farm, plots and readings for the hackathon demo',
  referenceTime: '2026-10-23T08:10:00Z',
  farms: [{ farmId: 1, farmName: 'Ubuntu Co-op Demo Farm (EXAMPLE DATA)', location: 'Greytown, KZN (example)', acreage: 12.5 }],
  plots: [
    { plotId: 1, farmId: 1, plotName: 'Maize Plot A (example)', crop: 'Maize', areaHa: 1.2, maxIrrigationLitres: 500, dryThresholdPct: 35, weeklyWaterBudgetL: 1500 },
    { plotId: 2, farmId: 1, plotName: 'Beans Plot B (example)', crop: 'Beans', areaHa: 0.8, maxIrrigationLitres: 300, dryThresholdPct: 40, weeklyWaterBudgetL: 900 },
    { plotId: 3, farmId: 1, plotName: 'Spinach Plot C (example)', crop: 'Spinach', areaHa: 0.4, maxIrrigationLitres: 200, dryThresholdPct: 45, weeklyWaterBudgetL: 600 },
    { plotId: 4, farmId: 1, plotName: 'Tomato Plot D (example)', crop: 'Tomato', areaHa: 0.5, maxIrrigationLitres: 250, dryThresholdPct: 40, weeklyWaterBudgetL: 400 },
    { plotId: 5, farmId: 1, plotName: 'Cabbage Plot E (example)', crop: 'Cabbage', areaHa: 0.6, maxIrrigationLitres: 300, dryThresholdPct: 40, weeklyWaterBudgetL: 900 },
  ],
  readings: [
    // P1: dry (18.5%), fresh (4 min old at reference time), falling
    ...mk(1, 'esp32-01', '2026-10-23T08:06:00Z', [27.0, 25.1, 23.4, 21.0, 19.8, 18.5], 29.0, 41),
    // P2: wet (62%), fresh
    ...mk(2, 'seed-sim-02', '2026-10-23T08:05:00Z', [60.0, 60.5, 61.2, 61.8, 62.0], 24.0, 55),
    // P3: dry (30%) but the last reading is two days old => stale
    ...mk(3, 'seed-sim-03', '2026-10-21T08:00:00Z', [34.0, 33.0, 32.1, 31.0, 30.0], 26.0, 48),
    // P4: dry (22%), fresh
    ...mk(4, 'seed-sim-04', '2026-10-23T08:08:00Z', [30.0, 28.0, 26.5, 24.0, 22.0], 30.0, 38),
    // P5: dry (25%) but raining right now
    ...mk(5, 'seed-sim-05', '2026-10-23T08:07:00Z', [33.0, 31.0, 29.0, 27.0, 25.0], 21.0, 80, true),
  ],
  suggestions: [
    // history used by the weekly water budget rule (approved within 7 days of the reference time)
    { plotId: 1, createdAt: '2026-10-21T06:00:00Z', decidedAt: '2026-10-21T06:05:00Z', action: 'irrigate', litres: 1000, reason: 'Example history: irrigate Plot A', provider: 'seed', status: 'approved', verdict: 'approved_by_rules' },
    { plotId: 1, createdAt: '2026-10-10T06:00:00Z', decidedAt: '2026-10-10T06:05:00Z', action: 'irrigate', litres: 800, reason: 'Example history older than 7 days (must NOT count)', provider: 'seed', status: 'approved', verdict: 'approved_by_rules' },
    { plotId: 4, createdAt: '2026-10-20T06:00:00Z', decidedAt: '2026-10-20T06:04:00Z', action: 'irrigate', litres: 350, reason: 'Example history: irrigate Plot D', provider: 'seed', status: 'approved', verdict: 'approved_by_rules' },
  ],
};
writeFileSync(new URL('../openedge/data/seed.json', import.meta.url), JSON.stringify(seed, null, 2) + '\n');
console.log('seed.json written');
