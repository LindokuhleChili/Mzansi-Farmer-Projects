// Proactive check-ins (docs/ASSISTANT.md). A cron-like job in the Node API looks at the sensors, the forecast alerts and the
// open case files, and adds a message to the farmer's assistant inbox ONLY when something changed since the last look
// (a new frost or heat alert, a plot that just went dry, a case follow-up that just came due). Quiet otherwise.
// Read-only: it never proposes or changes anything; the farmer opens the chat to act.
import { FARM_ID } from './tools.js';

export function createCheckIns({ call, clock, max = 50 }) {
  let seen = null;            // keys already reported (null = first look: remember the state, say nothing)
  const inbox = [];
  let seq = 0;
  async function snapshot() {
    const keys = new Map();
    const [al, plots, cases] = await Promise.all([call('oe.weather_alerts', 'GET', `/farm/alerts?farmId=${FARM_ID}&status=open`), call('oe.list_plots', 'GET', '/farm/plots'),
      call('oe.assistant_cases', 'GET', '/farm/assistant/cases?status=open&limit=50')]);
    for (const a of al.body.alerts || []) if (a.alertType === 'frost' || a.alertType === 'heat')
      keys.set(`alert:${a.alertType}:${a.forecastDate}`, { kind: a.alertType, text: a.alertType === 'frost' ? `Frost is forecast for ${a.forecastDate} (${a.value} ${a.unit}). Want me to check which plots to cover?` : `Heat is forecast for ${a.forecastDate} (${a.value} ${a.unit}). Want me to check your plots?`, problem: a.alertType });
    for (const p of (plots.body.plots || []).filter((x) => x.farmId === FARM_ID)) {
      const r = await call('oe.get_readings', 'GET', `/farm/plots/${p.plotId}/readings?limit=1`);
      const l = (r.body.readings || [])[0];
      if (l && l.soilMoisturePct < p.dryThresholdPct && clock() - Date.parse(l.readAt) <= 15 * 60000)
        keys.set(`dry:${p.plotId}`, { kind: 'dry_soil', plotId: p.plotId, text: `${p.plotName} has dry soil (${l.soilMoisturePct}%, below ${p.dryThresholdPct}%). Want me to look at it?`, problem: 'dry_soil' });
    }
    const now = clock().getTime();
    for (const c of cases.body.cases || []) for (const f of c.followUps) if (f.status === 'due' && Date.parse(f.dueAt) <= now)
      keys.set(`followup:${f.followUpId}`, { kind: 'follow_up', caseId: c.caseId, followUpId: f.followUpId, text: `Follow-up on "${c.title}": ${f.question}` });
    return keys;
  }
  async function run() {
    const keys = await snapshot();
    const first = seen === null;
    const fresh = first ? [] : [...keys].filter(([k]) => !seen.has(k));
    seen = new Set(keys.keys());   // a key that goes away and comes back is new again
    for (const [key, m] of fresh) inbox.push({ id: ++seq, at: clock().toISOString(), key, ...m });
    while (inbox.length > max) inbox.shift();
    return { first, added: fresh.length };
  }
  return { run, list: (after = 0) => inbox.filter((m) => m.id > after), get primed() { return seen !== null; } };
}
