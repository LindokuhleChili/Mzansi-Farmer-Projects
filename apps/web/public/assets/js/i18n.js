// English / isiZulu. English is the source of truth. The isiZulu lines below are ONLY the lines in the approved demo-screen table
// (docs/screens/api-fields.md). Nothing else is translated: any key without an approved isiZulu line falls back to English.
// All isiZulu text still needs native-speaker review before the demo (see docs/UI.md; that note is deliberately not shown to farmers).
const KEY = 'mf.lang';
let lang = 'en';
try { lang = localStorage.getItem(KEY) === 'zu' ? 'zu' : 'en'; } catch { /* storage may be blocked */ }
export const getLang = () => lang;
export const setLang = (l) => { lang = l === 'zu' ? 'zu' : 'en'; try { localStorage.setItem(KEY, lang); } catch { /* ignore */ } document.documentElement.lang = lang === 'zu' ? 'zu' : 'en'; };

const en = {
  nav_dashboard: 'Dashboard', nav_plots: 'Plots', nav_suggestions: 'Suggestions', nav_audit: 'Audit log', nav_home: 'Home',
  hello: 'Hello, {name}', example_data: 'Example data', farmer_role: 'Farmer · Greytown',
  chip_sensors_live: '{n} sensors live', chip_sensor_live_1: '1 sensor live', chip_sensors_none: 'No live sensors', chip_oe: 'OpenEdge connected', chip_oe_mock: 'Mock OpenEdge', chip_ai_mock: 'AI: stand-in', chip_ai_live: 'AI: live model',
  live_every: 'Live · every 30 s',
  dash_dry: '{dry} of {live} live plots have dry soil', dash_dry_1: '1 live plot has dry soil', dash_none_dry: 'No dry plots right now', dash_no_live: 'Waiting for live sensor data',
  dash_no_live_sub: 'Readings older than 15 minutes are not used for advice.',
  your_plots: 'Your plots', waiting_for_you: 'Waiting for you', nothing_waiting: 'Nothing is waiting for you. Ask the AI for advice on a plot.',
  see_all: 'See all', soil_moisture: 'Soil moisture', temperature: 'Temperature', humidity: 'Humidity',
  dry_soil: 'Dry soil', moisture_ok: 'Moisture OK', sensor_offline: 'Sensor offline', no_data: 'No data yet',
  rain_detected: 'Rain detected', no_rain: 'No rain', raining: 'Raining', dry: 'Dry',
  reading_ago: 'Reading {ago}', ago_now: 'just now', ago_min: '{n} min ago', ago_h: '{n} h ago', ago_d: '{n} d ago',
  ask_ai: 'Ask AI for advice', asking_ai: 'Asking the AI…', ask_again: 'Ask again', details: 'Details',
  ai_note_foot: 'The AI suggests, OpenEdge rules check it. Nothing runs until you approve.',
  chart_title: 'Soil moisture · {plot}', chart_sub: 'last {n} readings', dry_limit: 'Dry limit {t}%', readings: 'Readings', no_readings: 'No readings for this plot yet.',
  col_time: 'Time', col_device: 'Device', col_soil: 'Soil', col_temp: 'Temp.', col_hum: 'Humidity', col_rain: 'Rain',
  plots_title: 'Plots', plot_area: '{ha} ha', plot_limits: 'Dry limit {t}% · max {max} L per irrigation · weekly budget {b} L',
  history: 'Reading history',
  suggestions_title: 'Suggestions', filter_all: 'All', filter_waiting: 'Waiting', filter_approved: 'Approved', filter_rejected: 'Blocked by rules', filter_declined: 'Declined',
  st_pending_approval: 'Waiting for you', st_approved: 'Approved', st_rejected: 'Blocked by a rule', st_declined: 'Declined', st_deleted: 'Deleted',
  chip_can_approve: 'Can approve', chip_rejected: 'Rejected', passed_all: 'Passed all rules, ready to approve',
  review_title: 'Irrigation suggestion', blocked_title: 'Blocked by a rule',
  step_ai: 'AI suggested', step_rules: 'Rules checked', step_you: 'You decide', step_done: 'Done',
  sug_written_by_ai: 'Suggestion · written by AI', isizulu: 'isiZulu', english: 'English',
  act_irrigate: 'Irrigate {plot} with {l} L', act_hold: 'Hold irrigation on {plot}', act_notify: 'Check {plot}',
  reason_irrigate: 'Soil moisture is {m}%, below the {t}% dry limit. About {l} L should bring it back up.',
  reason_hold: 'Soil moisture is {m}%, not below the {t}% dry limit. No irrigation needed.',
  reason_notify: 'The AI could not rely on the sensor data. Please check the sensor for this plot.',
  rule_check: 'OpenEdge rule check', passed_rules: 'Passed all rules', rejected_rules: 'Rejected by rules', numbers_from_oe: 'Numbers come from OpenEdge', verdict_word: 'Verdict',
  rules_irrigation_only: 'checked for irrigation only',
  r_ACTION_NOT_ALLOWED: 'Action is allowed', r_LITRES_OUT_OF_RANGE: 'Amount within limit', r_SENSOR_STALE: 'Sensor reading is fresh', r_SOIL_NOT_DRY: 'Soil is dry enough',
  r_RAIN_DETECTED: 'No rain detected', r_WATER_BUDGET_EXCEEDED: 'Weekly water budget', r_NO_SENSOR_DATA: 'Sensor data exists', r_PLOT_NOT_FOUND: 'Plot exists',
  v_max: 'max {n} L', v_limit: 'limit {n} min', v_dry_limit: 'dry limit {n}%', v_raining: 'raining: {b}', v_budget: '{used} L used of {budget} L', v_min: '{n} min',
  other_rules_passed: '{n} other rules passed',
  nums_used: 'Numbers used · from OpenEdge', nums_now: 'Numbers used · current values from OpenEdge',
  n_soil: 'Soil moisture (soilMoisturePct)', n_dry: 'Dry limit (dryThresholdPct)', n_age: 'Reading age (readingAgeMinutes)', n_used: 'Used in last 7 days (usedLast7DaysL)', n_budget: 'Weekly budget (weeklyWaterBudgetL)',
  your_decision: 'Your decision', decision_hint: 'Approving asks you to confirm once more. Declining needs no confirmation.',
  decline: 'Decline', approve: 'Approve', dismiss: 'Dismiss',
  confirm_title: 'Confirm your decision', confirm_hint: 'The rules run again when you confirm.', confirm_expires: 'Expires in', confirm_go: 'Confirm and approve', confirm_cancel: 'Cancel', confirm_expired: 'This confirmation expired. Press Approve to start again.',
  approved_banner: 'Approved', approved_text: 'Approved by you. This irrigation now counts toward the weekly water budget.', declined_banner: 'Declined', declined_text: 'You declined this suggestion. Nothing was applied. It stays in the audit log.',
  deleted_text: 'This suggestion was deleted. It stays in the audit log.',
  back_dashboard: 'Back to dashboard', open_audit: 'Open audit log',
  rej_title_RAIN_DETECTED: 'Not allowed while it is raining', rej_why_RAIN_DETECTED: 'The rain sensor on this plot is wet right now. Watering in the rain wastes water, so irrigation stays locked until the rain stops.',
  rej_title_SOIL_NOT_DRY: 'The soil is not dry enough', rej_why_SOIL_NOT_DRY: 'Soil moisture is at or above the dry limit for this plot.',
  rej_title_SENSOR_STALE: 'The sensor reading is too old', rej_why_SENSOR_STALE: 'The newest reading is older than 15 minutes. Check the sensor, then ask again.',
  rej_title_NO_SENSOR_DATA: 'No sensor data for this plot', rej_why_NO_SENSOR_DATA: 'This plot has no readings yet.',
  rej_title_WATER_BUDGET_EXCEEDED: 'Over the weekly water budget', rej_why_WATER_BUDGET_EXCEEDED: 'This amount would take the plot over its weekly water budget.',
  rej_title_LITRES_OUT_OF_RANGE: 'The amount is outside the allowed range', rej_why_LITRES_OUT_OF_RANGE: "The suggested litres are above the plot's maximum or not a valid amount.",
  rej_title_ACTION_NOT_ALLOWED: 'This action is not allowed', rej_why_ACTION_NOT_ALLOWED: 'The suggested action is not one the rules allow.',
  rej_title_PLOT_NOT_FOUND: 'Plot not found', rej_why_PLOT_NOT_FOUND: 'The suggestion points to a plot that no longer exists.',
  what_you_can_do: 'What you can do', wait_ask: 'Wait, then ask again.', wait_ask_sub: 'Readings update every 30 s.', dismiss_it: 'Dismiss it.', dismiss_sub: 'It stays in the audit log. Approve is locked.',
  fb_note: 'The AI model did not answer in time, so a safe rule-based proposal was used. OpenEdge still checked it.',
  audit_title: 'Audit log', audit_sub: 'Every rule check, decision and tool call, newest first. Kept in OpenEdge.', audit_f_decisions: 'Rules & decisions', audit_f_all: 'Everything', audit_f_calls: 'Tool calls',
  audit_none: 'No events to show.', audit_show: 'Details', audit_request: 'Request',
  ev_rule_check: 'Rules checked a suggestion', ev_suggestion_declined: 'Farmer declined', ev_suggestion_approved: 'Farmer approved', ev_suggestion_rejected: 'Rejected by rules', ev_tool_call: 'Tool call', ev_suggestion_deleted: 'Suggestion deleted',
  demo_tools: 'Demo tools', demo_only_local: 'Only on this computer. Not part of the farmer app.',
  sim_title: 'Simulate a sensor reading', sim_hint: 'Posts a reading as this plot’s sensor, like the ESP32 would.', sim_soil: 'Soil moisture %', sim_temp: 'Temperature °C', sim_hum: 'Humidity %', sim_rain: 'Raining',
  sim_dry: 'Dry soil', sim_wet: 'Wet soil', sim_rainy: 'Raining', sim_send: 'Send reading', sim_ok: 'Reading stored (id {id}).', sim_none: 'No sensor device is registered for this plot, so a reading cannot be simulated here.',
  ai_mode_title: 'AI behaviour (stand-in AI only)', ai_normal: 'Normal', ai_greedy: 'Over-eager', ai_greedy_hint: 'The over-eager AI always asks for the maximum irrigation, so you can watch the rules say no.',
  login_title: 'Enter the app token', login_hint: 'This page is not on the computer that runs the API, so it needs the app token. It is kept only in this browser tab.', login_btn: 'Open the app', login_bad: 'That token was not accepted.',
  err_load: 'Could not load data.', err_retry: 'Try again', err_offline: 'The API did not answer.',
  e_UNAUTHORIZED: 'The app token was not accepted.', e_OE_UNAVAILABLE: 'OpenEdge is not reachable right now. Nothing was changed.', e_OE_TIMEOUT: 'OpenEdge took too long to answer. Nothing was changed.',
  e_CONFIRMATION_INVALID: 'The confirmation expired or was already used. Press Approve to start again.', e_NOT_APPROVABLE: 'The rules blocked this suggestion, so it cannot be approved.', e_ALREADY_DECIDED: 'This suggestion was already decided.',
  e_WATER_BUDGET_EXCEEDED: 'The weekly water budget would be exceeded.',
  credits: 'Photos: Pexels (free licence). See the photo credits in the docs. Names, plots and readings are fictional example data.',
  how_title: 'How this works', how_1: 'Sensors send readings to the API.', how_2: 'The AI proposes an action.', how_3: 'OpenEdge rules approve or reject it.', how_4: 'You approve in two steps.',
};

// Approved isiZulu lines (docs/screens/api-fields.md). {…} are filled with numbers from OpenEdge.
const zu = {
  hello: 'Sawubona, {name}',
  confirm_title: 'Qinisekisa isinqumo sakho.',
  isizulu: 'isiZulu',
};
export const t = (key, vars = {}) => {
  const s = (lang === 'zu' && zu[key]) || en[key] || key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
};
export const tEn = (key, vars = {}) => (en[key] || key).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
export const hasZu = (key) => key in zu;
export const missingZuKeys = () => Object.keys(en).filter((k) => !(k in zu));

// ---- approved isiZulu sentences that carry numbers or plot names. Return null when no approved sentence applies.
const fmt = (n) => String(n);
export function zuIrrigateLine(plot, litres) {
  // Approved: "Chelela isiqephu sombila A ngamalitha angu-300." (only maize plots have an approved crop word)
  const m = /^Maize Plot ([A-Z])\b/.exec(plot?.plotName || '');
  return m ? `Chelela isiqephu sombila ${m[1]} ngamalitha angu-${fmt(litres)}.` : null;
}
export const zuSoilDryLine = (soil, dry) => `Umhlabathi womile. Umswakama ungu-${fmt(soil)}%, ngaphansi kuka-${fmt(dry)}%.`;
export const zuHello = (name) => zu.hello.replace('{name}', name);
export const ZU_RAIN_BANNER = 'Akuvunyelwe. Imvula iyana manje.';
export const ZU_RAIN_WAIT = 'Linda kuze kuyeke imvula.';
/** The API's own isiZulu advice carries a draft-review note in brackets. Farmers should not see it (it is documented in docs/UI.md instead). */
export const stripDraftNote = (s) => String(s || '').replace(/\s*\(Umbhalo wesiZulu uyidrafti[^)]*\)\s*$/i, '').trim();
export const looksZulu = (s) => /\b(Umswakama|Kuphakanyiswa|Nisela|Kuyana|ukunisela|Chelela|Hlola|Asikho|Akudingeki|Unganiseli)\b/.test(String(s || ''));
setLang(lang);
