// English / isiZulu. English is the source of truth. The isiZulu lines below are ONLY the lines in the approved demo-screen table
// (docs/screens/api-fields.md). Nothing else is translated: any key without an approved isiZulu line falls back to English.
// All isiZulu text still needs native-speaker review before the demo (see docs/UI.md; that note is deliberately not shown to farmers).
// Other languages (and any isiZulu line not in the tables) are translated dynamically by the AI through POST /translate (see
// docs/TRANSLATION.md). AI text is cached in localStorage and shown with a small "Translated by AI" note and a "Show original" switch.
const KEY = 'mf.lang';
const AI_KEY = 'mf.ai-tr.v1';
// The 11 official South African languages, each named in its own language. Order: English first, then alphabetical by code.
export const LANGS = [['en', 'English'], ['af', 'Afrikaans'], ['nr', 'isiNdebele'], ['xh', 'isiXhosa'], ['zu', 'isiZulu'], ['nso', 'Sepedi'],
  ['st', 'Sesotho'], ['tn', 'Setswana'], ['ss', 'siSwati'], ['ve', 'Tshivenda'], ['ts', 'Xitsonga']];
export const LANG_CODES = LANGS.map(([c]) => c);
// No saved choice => English (deliberately no device-language detection). A manual pick is saved and wins from then on.
export const pickLang = (saved) => (LANG_CODES.includes(saved) ? saved : 'en');
let lang = 'en';
try { lang = pickLang(localStorage.getItem(KEY)); } catch { /* storage may be blocked */ }
export const getLang = () => lang;
export const setLang = (l) => { lang = pickLang(l); try { localStorage.setItem(KEY, lang); } catch { /* ignore */ } if (typeof document !== 'undefined') document.documentElement.lang = lang; };

// ---- AI translation cache and queue. aiCache[lang][english] = translated text.
let aiCache = {};
try { aiCache = JSON.parse(localStorage.getItem(AI_KEY) || '{}') || {}; } catch { aiCache = {}; }
const missing = new Set();          // English strings seen on this render with no translation yet
const failed = new Set();           // `${lang}|${english}` the AI could not translate this session (not retried, so no render loop)
let usedAi = false;                 // did the current render show any AI text?
let showOriginal = false;
export const isShowingOriginal = () => showOriginal;
export const toggleOriginal = () => { showOriginal = !showOriginal; };
export const beginRender = () => { usedAi = false; };
export const renderUsedAi = () => usedAi;
const fromAi = (s) => {
  if (lang === 'en' || showOriginal || !s) return null;
  const v = aiCache[lang]?.[s];
  if (v) { usedAi = true; return v; }
  if (!failed.has(lang + '|' + s)) missing.add(s);
  return null;
};
/** Translate user-typed content (market day names, notes, item labels, crop names). English is shown until the AI answers. */
export const tx = (s) => { const str = String(s ?? ''); if (!str.trim()) return str; return fromAi(str) || str; };
export const takeMissing = () => { const a = [...missing]; missing.clear(); return a; };
export function storeAi(target, pairs) {   // pairs: [english, translated|null]
  aiCache[target] = aiCache[target] || {};
  for (const [s, v] of pairs) { if (v) aiCache[target][s] = v; else failed.add(target + '|' + s); }
  try { localStorage.setItem(AI_KEY, JSON.stringify(aiCache)); } catch { /* quota: keep in memory only */ }
}

const en = {
  nav_dashboard: 'Dashboard', nav_plots: 'Plots', nav_suggestions: 'Suggestions', nav_audit: 'Audit log', nav_home: 'Home', nav_settings: 'Settings', nav_more: 'More', log_out: 'Log out', search_ph: 'Search plot or suggestion', search_none: 'Nothing found.', search_plots: 'Plots', search_sugs: 'Suggestions', bell: 'Suggestions waiting for you',
  hello: 'Hello, {name}', example_data: 'Example data', farmer_role: 'Farmer · Greytown',
  chip_esp_live: 'ESP32 live', chip_esp_none: 'No live sensors', chip_oe: 'OpenEdge connected', chip_oe_mock: 'OpenEdge: test mode', location: 'Greytown, KZN', sensors_online: '{n} sensors online', sensor_online_1: '1 sensor online',
  live_every: 'Live · every 30 s', live_every_side: 'Live every 30 s', live_30: 'Live · 30 s',
  dash_title: '{dry} of {live} plots have dry soil', dash_title_1: '{dry} of {live} plot has dry soil', dash_num: '{dry} of {live}', dash_rest: 'plots have dry soil', dash_rest_1: 'plot has dry soil', dash_no_live: 'Waiting for live sensor data',
  dash_no_live_sub: 'Readings older than 15 min block new suggestions.',
  your_plots: 'Your plots', all_plots: 'All plots', all_n_plots: 'View all {n} plots', waiting_for_you: 'Waiting for you', n_sug: '{n} suggestions', n_sug_1: '1 suggestion', nothing_waiting: 'Nothing is waiting for you. Ask the AI for advice on a plot.', ask_plot: 'Ask AI about {plot}',
  see_all: 'See all', soil_moisture: 'Soil moisture', temperature: 'Temperature', humidity: 'Humidity',
  dry_soil: 'Dry soil', moisture_ok: 'Moisture OK', sensor_offline: 'Sensor offline', no_data: 'No data yet',
  rain_detected: 'Rain detected', no_rain: 'No rain', raining: 'Raining', rain_word: 'Rain', dry: 'Dry',
  reading_ago: 'Reading {ago}', reading_ago_dev: '{dev} · {ago}', ago_now: 'just now', ago_min: '{n} min ago', ago_h: '{n} h ago', ago_d: '{n} d ago',
  ask_ai: 'Ask AI for advice', asking_ai: 'Asking the AI…', ask_again: 'Ask again', details: 'Details',
  ai_note_foot: 'The AI suggests, OpenEdge rules check it. Nothing runs until you approve.',
  chart_title: 'Soil moisture · {plot}', chart_sub: 'last {n} readings', dry_limit: 'Dry limit {t}%', readings: 'Readings', no_readings: 'No readings for this plot yet.',
  col_time: 'Time', col_device: 'Device', col_soil: 'Soil', col_temp: 'Temp.', col_hum: 'Humidity', col_rain: 'Rain',
  plots_title: 'Plots', plot_area: '{ha} ha', plot_limits: 'Dry limit {t}% · max {max} L per irrigation · weekly budget {b} L',
  history: 'Reading history',
  suggestions_title: 'Suggestions', filter_all: 'All', filter_waiting: 'Waiting', filter_approved: 'Approved', filter_rejected: 'Blocked by rules', filter_declined: 'Declined',
  st_pending_approval: 'Waiting for you', st_approved: 'Approved', st_rejected: 'Blocked by a rule', st_declined: 'Declined', st_deleted: 'Deleted',
  chip_can_approve: 'Can approve', chip_rejected: 'Rejected', passed_all: 'Passed all rules · ready to approve', blocked_by_rule: 'Blocked by rule {codes}',
  review_title: 'Irrigation suggestion', blocked_title: 'Blocked by a rule', blocked_head: 'Suggestion blocked', oe_refused: 'OpenEdge refused it',
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
  confirm_title: 'Confirm your decision', confirm_hint: 'The rules run again when you confirm, because readings may have changed.', confirm_audit: 'Your decision is saved to the audit log with request {id}.', you_approving: 'You are approving', expires_in: 'Expires in {t}', go_back: 'Go back', confirm_expires: 'Expires in', confirm_go: 'Confirm and approve', confirm_cancel: 'Cancel', confirm_expired: 'This confirmation expired. Press Approve to start again.',
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
  what_you_can_do: 'What you can do', wait_ask: 'Wait, then ask again.', wait_ask_d: 'Wait, then ask again', wait_ask_sub: 'Readings update every 30 s.', dismiss_it: 'Dismiss it.', dismiss_d: 'Dismiss this suggestion', dismiss_sub: 'It stays in the audit log. Approve is locked.', dismiss_sub_d: 'It stays in the audit log. Approve is locked for this one.', ask_new: 'Ask for new advice', n_rain: 'Raining (raining)',
  fb_note: 'The AI model did not answer in time, so a safe rule-based proposal was used. OpenEdge still checked it.',
  audit_title: 'Audit log', audit_sub: 'Every rule check, decision and tool call, newest first. Kept in OpenEdge.', audit_f_decisions: 'Rules & decisions', audit_f_all: 'Everything', audit_f_calls: 'Tool calls',
  audit_chain_t: 'Tamper check', audit_chain_ok: 'Chain intact: all {n} hashed events link up and match their content.', audit_chain_bad: 'Chain broken at event #{id}: it was changed after it was written ({why}).', audit_chain_legacy: '{n} older events were written before the hash chain and are not covered.', audit_chain_na: 'The hash chain check is not available on this OpenEdge database yet.', audit_chain_head: 'Latest hash', audit_chain_why_ROW_HASH_MISMATCH: 'content does not match its hash', audit_chain_why_PREV_HASH_MISMATCH: 'link to the previous event is broken',
  audit_none: 'No events to show.', audit_show: 'Details', audit_request: 'Request',
  ev_rule_check: 'Rules checked a suggestion', ev_suggestion_declined: 'Farmer declined', ev_suggestion_approved: 'Farmer approved', ev_suggestion_rejected: 'Rejected by rules', ev_tool_call: 'Tool call', ev_suggestion_deleted: 'Suggestion deleted',
  demo_tools: 'Demo tools', demo_only_local: 'Only on this computer. Not part of the farmer app.',
  sim_title: 'Simulate a sensor reading', sim_hint: 'Posts a reading as this plot’s sensor, like the ESP32 would.', sim_soil: 'Soil moisture %', sim_temp: 'Temperature °C', sim_hum: 'Humidity %', sim_rain: 'Raining',
  sim_dry: 'Dry soil', sim_wet: 'Wet soil', sim_rainy: 'Raining', sim_send: 'Send reading', sim_ok: 'Reading stored (id {id}).', sim_none: 'No sensor device is registered for this plot, so a reading cannot be simulated here.',
  ai_mode_title: 'AI behaviour (stand-in AI only)', ai_normal: 'Normal', ai_greedy: 'Over-eager', ai_greedy_hint: 'The over-eager AI always asks for the maximum irrigation, so you can watch the rules say no.',
  settings_title: 'Settings', settings_sub: 'This app runs on example data.', set_lang: 'Language', set_lang_hint: 'Reviewed isiZulu lines are used where they exist. Everything else is translated by AI and may contain mistakes.', ai_note: 'Translated by AI', ai_show_orig: 'Show original', ai_show_tr: 'Show translation', set_data: 'Data and AI', set_oe: 'OpenEdge', set_ai: 'AI', set_oe_mock: 'Test stand-in (no real OpenEdge)', set_oe_real: 'Connected', set_ai_mock: 'Stand-in AI', set_ai_real: 'Live model', set_session: 'Session', set_session_proxy: 'You are on the computer that runs the app. There is no account to sign out of.', set_session_token: 'The app token is kept in this browser tab only.', set_signed_out: 'Signed out of this browser tab.',
  login_title: 'Enter the app token', login_hint: 'This page is not on the computer that runs the API, so it needs the app token. It is kept only in this browser tab.', login_btn: 'Open the app', login_bad: 'That token was not accepted.',
  err_load: 'Could not load data.', err_retry: 'Try again', err_offline: 'The API did not answer.',
  e_UNAUTHORIZED: 'The app token was not accepted.', e_OE_UNAVAILABLE: 'OpenEdge is not reachable right now. Nothing was changed.', e_OE_TIMEOUT: 'OpenEdge took too long to answer. Nothing was changed.',
  e_CONFIRMATION_INVALID: 'The confirmation expired or was already used. Press Approve to start again.', e_NOT_APPROVABLE: 'The rules blocked this suggestion, so it cannot be approved.', e_ALREADY_DECIDED: 'This suggestion was already decided.',
  e_WATER_BUDGET_EXCEEDED: 'The weekly water budget would be exceeded.',
  // ---- harvest-day market (docs/MARKET.md)
  // ---- plant doctor (docs/DOCTOR.md)
  dr_nav: 'Plant doctor', dr_title: 'Plant doctor', dr_sub: 'Add photos of a sick plant. The AI suggests what it may be; chemical doses are never shown.',
  dr_hero: 'What is wrong with my plant?', dr_hero_sub: 'Up to 3 photos, cheapest steps first, and when to call an expert.', dr_photo_credit: 'Photo:',
  dr_ask: 'Check a plant', dr_photos: 'Photos (up to {n})', dr_crop: 'Crop', dr_part: 'Part of the plant', dr_stage: 'Growth stage', dr_province: 'Province',
  dr_part_leaf: 'Leaf', dr_part_stem: 'Stem', dr_part_fruit: 'Fruit', dr_part_root: 'Root', dr_part_flower: 'Flower', dr_part_whole_plant: 'Whole plant',
  dr_stage_seedling: 'Seedling', dr_stage_vegetative: 'Growing', dr_stage_flowering: 'Flowering', dr_stage_fruiting: 'Fruiting', dr_stage_mature: 'Mature',
  dr_privacy: 'Photos are sent to the AI only for this check. They are not stored.', dr_check: 'Check plant', dr_checking: 'Checking…',
  dr_empty: 'Add photos and press Check plant.', dr_likely: 'Likely condition', dr_conf_low: 'Low confidence', dr_conf_medium: 'Medium confidence', dr_conf_high: 'High confidence',
  dr_steps: 'What to do, cheapest first', dr_cost_free: 'Free', dr_cost_low: 'Low cost', dr_cost_medium: 'Medium cost', dr_cost_high: 'High cost',
  dr_monitor: 'Watch for', dr_risk: 'Risk to neighbouring farms', dr_risk_low: 'Low', dr_risk_medium: 'Medium', dr_risk_high: 'High', dr_expert: 'When to call an expert',
  dr_nodose: 'No chemical doses are shown. For any spray, ask your extension officer.', dr_save: 'Save to farm record', dr_dismiss: 'Dismiss',
  dr_saved: 'Saved to the farm record.', dr_dismissed: 'Dismissed.', dr_st_pending_review: 'Waiting for you', dr_st_saved: 'Saved to the farm record', dr_st_dismissed: 'Dismissed',
  dr_removed: '{n} step(s) with a chemical dose were removed.', dr_fallback_tag: 'safe general advice',
  dr_fb_dose_blocked: 'The AI answer gave a chemical dose, so OpenEdge blocked it. This is safe general advice instead.',
  dr_fb_dose_removed: 'The AI answer gave chemical doses, so it was not used. This is safe general advice instead.',
  dr_fb_ai_timeout: 'The AI took too long. This is safe general advice instead.', dr_fb_ai_unavailable: 'The AI could not be reached. This is safe general advice instead.',
  dr_fb_invalid_json: 'The AI answer could not be read. This is safe general advice instead.', dr_fb_invalid_shape: 'The AI answer was incomplete. This is safe general advice instead.',
  dr_fb_rejected_by_openedge: 'OpenEdge did not accept the AI answer. This is safe general advice instead.',
  dr_history: 'Recent checks', dr_history_none: 'No checks yet.', dr_words: 'No-doses word list ({n} active)',
  dr_words_hint: 'OpenEdge blocks any sentence with a dose word and a chemical word. Tap a word to turn it off or on.', dr_word_new: 'New word', dr_word_kind: 'Kind',
  dr_kind_chemical: 'Chemical', dr_kind_dose: 'Dose', dr_word_add: 'Add', dr_word_added: 'Word added.', dr_word_off: 'Turn off', dr_word_on: 'Turn on',
  dr_word_turned_on: 'Word turned on.', dr_word_turned_off: 'Word turned off.', dr_need_photo: 'Add at least one photo.', dr_too_many: 'Only the first {n} photos are used.',
  dr_bad_type: 'Use JPEG, PNG or WebP photos.',
  e_PHOTO_TOO_LARGE: 'A photo is too large.', e_PHOTO_TYPE_NOT_ALLOWED: 'Use JPEG, PNG or WebP photos.', e_TERM_EXISTS: 'That word is already in the list.',
  e_BLOCKED_TERM_INVALID: 'Use 1 to 40 letters, digits or spaces.', e_DIAGNOSIS_NOT_FOUND: 'That check was not found.',
  // ---- weather alerts (docs/WEATHER.md)
  wx_nav: 'Weather', wx_title: 'Weather alerts', wx_sub: 'OpenEdge checks the 7-day forecast against your alert levels. No AI is used.',
  wx_refresh: 'Check forecast', wx_week: 'Next 7 days', wx_example: 'Example forecast data', wx_day: 'Day {n}', wx_rain_mm: 'Rain {mm} mm',
  wx_type_rain: 'Heavy rain', wx_type_heat: 'Heat', wx_type_frost: 'Frost', wx_lvl_watch: 'Watch', wx_lvl_warning: 'Warning', wx_lvl_severe: 'Severe',
  wx_open_0: 'No open weather alerts', wx_open_1: '1 open weather alert', wx_open_n: '{n} open weather alerts', wx_rules: 'Alerts come from the OpenEdge rules, not from AI.',
  wx_alerts: 'Alerts', wx_none: 'No alerts. Press Check forecast.', wx_ack: 'Acknowledge', wx_acked: 'Acknowledged',
  wx_thresholds: 'Alert levels', wx_th_hint: 'OpenEdge checks every change. Frost must stay below heat.', wx_save: 'Save', wx_saved: 'Alert level saved.',
  wx_nodata: 'No forecast for this province. Nothing was guessed.', wx_refreshed: '{a} new alert(s), {b} no longer expected.',
  e_ALERT_THRESHOLD_INVALID: 'OpenEdge did not accept that alert level.', e_ALERT_NOT_FOUND: 'That alert was not found.',
  mk_nav: 'Market', mk_title: 'Harvest-day market', mk_sub: 'Sell straight to your community on market day, below what big retail buyers pay you.',
  mk_new: 'New market day', mk_edit: 'Edit market day', mk_none: 'No market days here yet.', mk_hero_t: 'Your next market day', mk_hero_none: 'Plan a market day and tell your community.',
  mk_f_upcoming: 'Upcoming', mk_f_waiting: 'Waiting for you', mk_f_blocked: 'Blocked by rules', mk_f_past: 'Past & cancelled',
  mk_st_pending_approval: 'Waiting for you', mk_st_published: 'Published', mk_st_rejected: 'Blocked by a rule', mk_st_declined: 'Declined', mk_st_cancelled: 'Cancelled',
  mk_items_n: '{n} items', mk_items_1: '1 item', mk_kg_total: '{kg} kg on sale', mk_reserved_kg: '{kg} kg reserved',
  mk_when: 'When', mk_where: 'Where', mk_notes: 'Notes', mk_produce: 'Produce on sale', mk_time: '{a} – {b}',
  mk_col_item: 'Item', mk_col_kg: 'Kg', mk_col_price: 'Your price', mk_col_retail: 'Retail buyer pays', mk_col_reserve: 'Can reserve', mk_col_walk: 'Not reserved yet',
  mk_below: 'R{d} below', mk_per_kg: 'R{p}/kg', mk_lot: 'Co-op lot {id}', mk_no_ref: 'no reference price',
  mk_rules: 'OpenEdge rule check', mk_rules_ok: 'Passed all rules', mk_rules_bad: 'Blocked by rules', mk_item_n: 'Item {n}',
  mk_publish: 'Publish', mk_decline: 'Decline', mk_cancel_event: 'Cancel market day', mk_edit_btn: 'Edit',
  mk_publish_hint: 'Publishing asks you to confirm once more. The rules run again when you confirm.',
  mk_has_res: 'This market day has reservations, so it cannot be edited. Cancel it and make a new one.',
  mk_confirm_publish: 'Confirm and publish', mk_confirm_cancel: 'Confirm and cancel', mk_you_publishing: 'You are publishing', mk_you_cancelling: 'You are cancelling',
  mk_published: 'Published. Your community can see it now.', mk_cancelled: 'Market day cancelled. Reservations were cancelled too.', mk_declined: 'Declined. It stays in the audit log.',
  mk_res_title: 'Reservations', mk_res_hint: 'Optional. Up to {cap} kg per buyer, and at most half of each item, so walk-up buyers always find produce.',
  mk_res_none: 'No reservations yet. Buyers can still just walk up on the day.', mk_res_closed: 'Reservations are closed. Walk up on the day.',
  mk_res_buyer: 'Buyer name', mk_res_item: 'Item', mk_res_kg: 'Kg', mk_res_add: 'Reserve', mk_res_ok: 'Reserved {kg} kg for {name}.', mk_res_cancel: 'Cancel reservation', mk_res_cancelled: 'Reservation cancelled.',
  mk_form_name: 'Name of the market day', mk_form_venue: 'Place', mk_form_area: 'Area (optional)', mk_form_date: 'Date', mk_form_start: 'Starts', mk_form_end: 'Ends', mk_form_notes: 'Notes for buyers (optional)',
  mk_form_items: 'Produce', mk_form_crop: 'Crop', mk_form_label: 'Label (optional)', mk_form_kg: 'Kg', mk_form_price: 'Price per kg (R)', mk_form_lot: 'Co-op lot (optional)',
  mk_form_ref: 'Retail buyer pays R{p}/kg. Your price must be lower.', mk_form_add: 'Add produce', mk_form_remove: 'Remove', mk_form_save: 'Save and check the rules', mk_form_hint: 'OpenEdge checks every price against the retail buyer price and every lot against its free stock. Then you publish.',
  mk_saved_ok: 'Saved. The rules passed. Publish it when you are ready.', mk_saved_bad: 'Saved, but the rules blocked it. See why below.',
  mk_back: 'All market days', mk_example: 'Prices and events are example data.',
  r_EVENT_NOT_IN_FUTURE: 'Starts in the future', r_NO_REFERENCE_PRICE: 'Has a retail reference price', r_PRICE_NOT_BELOW_RETAIL: 'Below the retail buyer price', r_LOT_CROP_MISMATCH: 'Same crop as the lot', r_LOT_STOCK_EXCEEDED: 'Within the lot’s free stock',
  r_EVENT_NOT_OPEN: 'Market day is published', r_RESERVATIONS_CLOSED: 'Reservations still open', r_RESERVE_CAP_EXCEEDED: 'Within the per-buyer limit', r_RESERVE_STOCK_EXCEEDED: 'Enough left to reserve',
  e_HAS_RESERVATIONS: 'This market day has reservations, so it cannot be edited.', e_NOT_CANCELLABLE: 'This market day cannot be cancelled.', e_EVENT_NOT_FOUND: 'Market day not found.', e_ITEM_NOT_FOUND: 'That item is not on this market day.', e_LOT_NOT_FOUND: 'That co-op lot does not exist.', e_VALIDATION_ERROR: 'Please check the form.',
  ev_market_rule_check: 'Rules checked a market day', ev_market_event_published: 'Farmer published a market day', ev_market_event_declined: 'Farmer declined a market day', ev_market_event_cancelled: 'Market day cancelled', ev_market_event_edited: 'Market day edited', ev_market_publish_blocked_by_rules: 'Publishing blocked by rules', ev_reservation_rule_check: 'Rules checked a reservation', ev_reservation_cancelled: 'Reservation cancelled',
  credits: 'Photos: Pexels (free licence). See the photo credits in the docs. Names, plots and readings are fictional example data.',
  how_title: 'How this works', how_1: 'Sensors send readings to the API.', how_2: 'The AI proposes an action.', how_3: 'OpenEdge rules approve or reject it.', how_4: 'You approve in two steps.',
};

// Approved isiZulu lines (docs/screens/api-fields.md). {…} are filled with numbers from OpenEdge.
const zu = {
  hello: 'Sawubona, {name}',
  confirm_title: 'Qinisekisa isinqumo sakho.',
  isizulu: 'isiZulu',
};
// Harvest-day market lines in isiZulu. DRAFT: written for this feature and not yet in the approved table, so they are kept apart
// from `zu` above and must be reviewed by a native speaker before any demo (docs/MARKET.md lists every line). Keys not here stay in English.
const zuMarket = {
  mk_nav: 'Imakethe',
  mk_title: 'Imakethe yosuku lokuvuna',
  mk_new: 'Usuku olusha lwemakethe',
  mk_f_upcoming: 'Ezizayo',
  mk_st_published: 'Kushicilelwe',
  mk_when: 'Nini',
  mk_where: 'Kuphi',
  mk_produce: 'Okuthengiswayo',
  mk_publish: 'Shicilela',
  mk_res_title: 'Ukubekisa',
  mk_res_add: 'Bekisa',
  mk_res_closed: 'Ukubekisa kuvaliwe. Woza ngosuku lwemakethe.',
  mk_res_none: 'Akekho osebekisile. Abathengi bangafika nje ngosuku.',
};
export const t = (key, vars = {}) => {
  // hand-written isiZulu first; otherwise the AI translation of the English template (placeholders kept), otherwise English
  const hand = !showOriginal && lang === 'zu' && (zu[key] || zuMarket[key]);
  const s = hand || (en[key] ? fromAi(en[key]) || en[key] : key);
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
};
export const tEn = (key, vars = {}) => (en[key] || key).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
export const hasZu = (key) => key in zu || key in zuMarket;
export const ZU_MARKET_KEYS = Object.keys(zuMarket);
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
