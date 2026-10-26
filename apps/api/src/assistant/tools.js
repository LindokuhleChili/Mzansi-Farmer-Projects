// Farm Assistant tool registry (docs/ASSISTANT.md). Every tool wraps an existing OpenEdge endpoint. The same registry is used
// by the Gemini function-calling loop and by the offline rule-based planner, and every call is written into the case file as a
// "what I checked" step. Tools that would change something (propose_action) never execute anything: OpenEdge checks the proposal
// first and the farmer gets an approval card. Nothing runs until the farmer taps approve; a rules rejection is final.
export const FARM_ID = 1;
export const STEP_LIMIT = 6;
export const PROPOSAL_KINDS = ['irrigate', 'hold', 'notify', 'step', 'contact_expert', 'list_harvest_day'];

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const int = { type: 'integer' }, str = (d) => ({ type: 'string', description: d });

export const TOOL_DEFS = [
  { name: 'get_farm_profile', description: 'What I remember about this farm: plots and crops, province, open case files and saved preferences.', parameters: S({}) },
  { name: 'get_sensor_readings', description: 'Latest ESP32 soil moisture, temperature, humidity and rain readings for one plot, with the dry threshold.', parameters: S({ plotId: int }, ['plotId']) },
  { name: 'get_forecast', description: 'The 7-day forecast and open frost, heat and rain alerts for the farm (Open-Meteo or example data).', parameters: S({}) },
  { name: 'run_plant_doctor', description: 'The latest plant doctor diagnoses (from photos the farmer took). New photos are taken on the Plant doctor page.', parameters: S({ diagnosisId: int }) },
  { name: 'search_guides', description: 'Search the openly licensed farming guide passages stored in OpenEdge. Returns the top 3 passages with ids to cite.', parameters: S({ query: str('a short search, e.g. "tomato leaf spots"') }, ['query']) },
  { name: 'get_nearby_reports', description: 'What the other plots on this co-op farm show: latest readings and recent plant doctor reports.', parameters: S({ plotId: int }) },
  { name: 'get_case', description: 'One case file with its actions and follow-ups.', parameters: S({ caseId: int }, ['caseId']) },
  { name: 'list_harvest_days', description: 'Upcoming harvest-day markets on this farm.', parameters: S({}) },
  { name: 'propose_action', description: 'Propose ONE action for the farmer to approve. irrigate/hold/notify are checked by the OpenEdge irrigation rules first. step = a free or cheap cultural step. contact_expert = suggest calling the extension officer. list_harvest_day = suggest listing produce. Never chemicals or doses. Cite guide passage ids.',
    parameters: S({ plotId: int, kind: { type: 'string', enum: PROPOSAL_KINDS }, litres: int, text: str('one short sentence for the farmer'), cost: { type: 'string', enum: ['free', 'low', 'medium', 'high'] }, citations: { type: 'array', items: int } }, ['plotId', 'kind', 'text', 'citations']) },
  { name: 'remember', description: 'Save a farmer preference or fact the farmer told you (e.g. water_source, preferred_call_time).', parameters: S({ key: str('lower_case_key'), value: str('short value') }, ['key', 'value']) },
];

/** ctx: { call(name, method, path, body) -> {status, body}, clock, state } ; state collects passages, proposals, steps */
export function createTools(ctx) {
  const st = ctx.state;
  const remember = (p) => { for (const x of p) if (!st.passages.some((y) => y.passageId === x.passageId)) st.passages.push(x); };
  const T = {
    async get_farm_profile() {
      const [plots, mem, cases, farm] = await Promise.all([ctx.call('oe.list_plots', 'GET', '/farm/plots'), ctx.call('oe.assistant_memory', 'GET', `/farm/assistant/memory?farmId=${FARM_ID}`),
        ctx.call('oe.assistant_cases', 'GET', '/farm/assistant/cases?status=open&limit=5'), ctx.call('oe.farm', 'GET', `/farm/farms/${FARM_ID}`)]);
      st.plots = plots.body.plots || [];
      st.province = farm.body.province || 'KwaZulu-Natal';
      const out = { farm: { name: farm.body.farmName, province: st.province }, plots: st.plots.map((p) => ({ plotId: p.plotId, name: p.plotName, crop: p.crop, dryThresholdPct: p.dryThresholdPct })),
        openCases: (cases.body.cases || []).map((c) => ({ caseId: c.caseId, plotId: c.plotId, title: c.title, problemType: c.problemType })), preferences: mem.body.items || [] };
      return { result: out, summary: `${out.plots.length} plots, ${out.openCases.length} open case(s), ${out.preferences.length} saved preference(s)` };
    },
    async get_sensor_readings({ plotId }) {
      const plot = (st.plots || []).find((p) => p.plotId === plotId) || (await ctx.call('oe.get_plot', 'GET', `/farm/plots/${plotId}`)).body;
      if (!plot || !plot.plotId) return { result: { error: 'PLOT_NOT_FOUND' }, summary: `plot ${plotId} not found` };
      const r = await ctx.call('oe.get_readings', 'GET', `/farm/plots/${plotId}/readings?limit=3`);
      const last = (r.body.readings || [])[0] || null;
      const ageMin = last ? Math.round((ctx.clock() - Date.parse(last.readAt)) / 60000) : null;
      const out = { plotId, plotName: plot.plotName, crop: plot.crop, dryThresholdPct: plot.dryThresholdPct, latest: last && { soilMoisturePct: last.soilMoisturePct, temperatureC: last.temperatureC, humidityPct: last.humidityPct, raining: last.raining, ageMinutes: ageMin } };
      st.sensor[plotId] = out;
      return { result: out, summary: last ? `${plot.plotName}: soil ${last.soilMoisturePct}% (dry below ${plot.dryThresholdPct}%), ${last.temperatureC} °C, humidity ${last.humidityPct}%${last.raining ? ', raining' : ''}, ${ageMin} min old` : `${plot.plotName}: no readings yet` };
    },
    async get_forecast() {
      const province = st.province || 'KwaZulu-Natal';
      const [fc, al] = await Promise.all([ctx.call('oe.forecast', 'GET', `/farm/forecast?province=${encodeURIComponent(province)}`), ctx.call('oe.weather_alerts', 'GET', `/farm/alerts?farmId=${FARM_ID}&status=open`)]);
      const alerts = (al.body.alerts || []).map((a) => ({ type: a.alertType, date: a.forecastDate, value: a.value, unit: a.unit, level: a.level }));
      st.alerts = alerts;
      const days = (fc.body.days || []).slice(0, 3).map((d) => ({ date: d.date, minC: d.tempMinC, maxC: d.tempMaxC, rainMm: d.rainMm }));
      return { result: { province, source: fc.body.source, days, alerts }, summary: alerts.length ? `${alerts.length} open alert(s): ${alerts.map((a) => `${a.type} ${a.date}`).join(', ')}` : 'no frost, heat or rain alerts' };
    },
    async run_plant_doctor({ diagnosisId } = {}) {
      const r = Number.isInteger(diagnosisId) ? await ctx.call('oe.doctor_get', 'GET', `/farm/doctor/diagnoses/${diagnosisId}`) : await ctx.call('oe.doctor_list', 'GET', '/farm/doctor/diagnoses?limit=1');
      const d = Number.isInteger(diagnosisId) ? (r.status === 200 ? r.body : null) : (r.body.diagnoses || [])[0] || null;
      st.diagnosis = d;
      if (!d) return { result: { none: true, hint: 'Ask the farmer to add photos on the Plant doctor page.' }, summary: 'no plant doctor diagnosis yet' };
      return { result: { diagnosisId: d.diagnosisId, crop: d.crop, condition: d.condition, confidence: d.confidence, observations: d.observations, callExpert: d.callExpert }, summary: `diagnosis ${d.diagnosisId}: ${d.condition} (${d.confidence} confidence)` };
    },
    async search_guides({ query }) {
      const r = await ctx.call('oe.guide_search', 'POST', '/farm/guide/search', { q: String(query || '').slice(0, 200), limit: 3 });
      const p = r.status === 200 ? r.body.passages : [];
      remember(p);
      return { result: { passages: p.map((x) => ({ id: x.passageId, source: `${x.sourceTitle} · ${x.section}`, text: x.text })) }, summary: p.length ? `${p.length} guide passage(s): ${p.map((x) => `[${x.passageId}] ${x.sourceTitle.replace(/^Wikipedia: /, '')}`).join(', ')}` : 'no guide passage found' };
    },
    async get_nearby_reports({ plotId } = {}) {
      const plots = st.plots || (await ctx.call('oe.list_plots', 'GET', '/farm/plots')).body.plots || [];
      const others = plots.filter((p) => p.plotId !== plotId && p.farmId === FARM_ID).slice(0, 4);
      const rs = await Promise.all(others.map((p) => ctx.call('oe.get_readings', 'GET', `/farm/plots/${p.plotId}/readings?limit=1`)));
      const dg = await ctx.call('oe.doctor_list', 'GET', '/farm/doctor/diagnoses?limit=3');
      const out = { plots: others.map((p, i) => { const l = (rs[i].body.readings || [])[0]; return { plotName: p.plotName, crop: p.crop, soilMoisturePct: l ? l.soilMoisturePct : null, dry: l ? l.soilMoisturePct < p.dryThresholdPct : null }; }),
        diagnoses: (dg.body.diagnoses || []).map((d) => ({ crop: d.crop, condition: d.condition, status: d.status })) };
      return { result: out, summary: `${out.plots.filter((p) => p.dry).length} of ${out.plots.length} other plot(s) dry; ${out.diagnoses.length} recent plant doctor report(s)` };
    },
    async get_case({ caseId }) {
      const r = await ctx.call('oe.assistant_case', 'GET', `/farm/assistant/cases/${caseId}`);
      return r.status === 200 ? { result: r.body, summary: `case ${caseId}: ${r.body.title} (${r.body.status})` } : { result: { error: 'CASE_NOT_FOUND' }, summary: `case ${caseId} not found` };
    },
    async list_harvest_days() {
      const r = await ctx.call('oe.market_events', 'GET', '/farm/market/events?status=published');
      const ev = (r.body.events || []).map((e) => ({ eventId: e.eventId, name: e.eventName, startsAt: e.startsAt }));
      return { result: { events: ev }, summary: `${ev.length} published harvest day(s)` };
    },
    // never executes: irrigation kinds become an OpenEdge-checked suggestion (pending the farmer's two-step approval or rejected, final);
    // other kinds become case actions the farmer accepts or declines.
    async propose_action(a) {
      const kind = PROPOSAL_KINDS.includes(a.kind) ? a.kind : 'step';
      const cites = (Array.isArray(a.citations) ? a.citations : []).filter(Number.isInteger).slice(0, 3);
      const text = String(a.text || '').slice(0, 300);
      if (['irrigate', 'hold', 'notify'].includes(kind)) {
        const litres = kind === 'irrigate' && Number.isInteger(a.litres) ? a.litres : 0;
        const r = await ctx.call('oe.create_suggestion', 'POST', '/farm/suggestions', { plotId: a.plotId, action: kind, litres, reason: text, provider: `assistant:${ctx.providerName}`, requestId: ctx.requestId, asOf: ctx.clock().toISOString() });
        if (r.status !== 201) return { result: { error: r.body.error }, summary: `OpenEdge refused the proposal: ${r.body.error}` };
        const s = r.body;
        st.proposals.push({ kind, text, citations: cites, suggestionId: s.suggestionId, verdict: s.verdict, rejectReasons: (s.rejectReasons || []).map((x) => x.code), litres });
        return { result: { suggestionId: s.suggestionId, verdict: s.verdict, rejectReasons: (s.rejectReasons || []).map((x) => x.code) }, summary: `OpenEdge rules: ${kind}${litres ? ` ${litres} L` : ''} => ${s.verdict === 'approved_by_rules' ? 'passed, waiting for your approval' : 'rejected (' + (s.rejectReasons || []).map((x) => x.code).join(', ') + ')'}` };
      }
      const cost = ['free', 'low', 'medium', 'high'].includes(a.cost) ? a.cost : 'free';
      const chk = await ctx.call('oe.dose_check', 'POST', '/farm/doctor/check', { texts: [text || 'x'] });
      if (chk.body.verdict === 'blocked') return { result: { error: 'DOSE_BLOCKED' }, summary: 'OpenEdge blocked a step that gave a chemical dose' };
      st.proposals.push({ kind: 'step', subKind: kind, text, cost, citations: cites });
      return { result: { ok: true, needsFarmerApproval: true }, summary: `proposed (${kind === 'step' ? cost : kind.replace(/_/g, ' ')}): ${text}` };
    },
    async remember({ key, value }) {
      const r = await ctx.call('oe.assistant_memory_save', 'POST', '/farm/assistant/memory', { farmId: FARM_ID, key: String(key || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '').slice(0, 40) || 'note', value: String(value || '').slice(0, 300), actor: 'assistant', requestId: ctx.requestId });
      return { result: r.status === 200 ? { saved: true } : { error: r.body.error }, summary: r.status === 200 ? `remembered ${r.body.key}` : `could not save (${r.body.error})` };
    },
  };
  return T;
}
