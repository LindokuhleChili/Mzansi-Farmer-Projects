// Pure rendering: data in, HTML out (every value is escaped by html``). Event handling lives in main.js via data-act attributes.
// Layout, sizes and copy follow the approved demo screens; the desktop and phone layouts are both rendered and the CSS shows one (d-only / m-only).
import { html, raw, icon, fmtTime, fmtHM, fmtDay, fmtShortDay, fmtDateTime, ageMinutes, num, shortName, cap, photoUrl, photoStyle } from './util.js';
import { t, tEn, tx, getLang, LANGS, zuIrrigateLine, zuSoilDryLine, ZU_RAIN_BANNER, ZU_RAIN_WAIT, stripDraftNote, looksZulu } from './i18n.js';
import { FRESH_MINUTES } from './api.js';

export const bg = (url) => `background-image:url(${url})`;
export const agoText = (min) => (min === null ? '—' : min < 1 ? t('ago_now') : min < 60 ? t('ago_min', { n: min }) : min < 48 * 60 ? t('ago_h', { n: Math.round(min / 60) }) : t('ago_d', { n: Math.round(min / 1440) }));

export function plotState(plot, readings, now = Date.now()) {
  const latest = readings?.[0] || null;
  const age = latest ? ageMinutes(latest.readAt, now) : null;
  const fresh = age !== null && age <= FRESH_MINUTES;
  const dry = !!latest && latest.soilMoisturePct < plot.dryThresholdPct;
  return { latest, age, fresh, dry };
}
export const lvl = (cls, ic, text) => html`<span class="lvl ${cls}">${ic ? icon(ic, 11) : ''}${text}</span>`;
const statusLvl = (s) => !s.latest ? lvl('z', '', t('no_data')) : !s.fresh ? lvl('z', '', t('sensor_offline')) : s.dry ? lvl('w', 'drop', t('dry_soil')) : lvl('n', 'check', t('moisture_ok'));
const rainBit = (s) => !s.latest || !s.fresh ? '' : s.latest.raining ? html`<span class="raintxt on">${icon('rain', 14)}${t('rain_detected')}</span>` : html`<span class="raintxt">${icon('sun', 14)}${t('no_rain')}</span>`;

export function metricsBlock(plot, s, tank = null) {
  const l = s.latest;
  const soil = l ? l.soilMoisturePct : null;
  const w = soil === null ? 0 : Math.max(0, Math.min(100, soil));
  const dim = s.fresh ? '' : 'opacity:.6';
  const tankAge = tank?.readAt ? ageMinutes(tank.readAt) : null;
  const tankFresh = tankAge !== null && tankAge <= FRESH_MINUTES;
  const water = tank && tank.calibrated && typeof tank.waterLevelPct === 'number' ? tank.waterLevelPct : null;
  const waterDim = tank && !tankFresh ? 'opacity:.6' : '';
  return html`<div class="metrics">
    <div class="metric"><div class="k">${icon('drop', 12)}${t('soil_moisture')}</div>
      <div class="v" style="${dim}">${num(soil)}<small>%</small></div>
      <div class="limbar" title="${t('dry_limit', { t: plot.dryThresholdPct })}"><i class="${s.dry ? 'dry' : ''}" style="width:${w}%"></i><u style="left:${plot.dryThresholdPct}%"></u></div></div>
    <div class="metric"><div class="k">${icon('drop', 12)}${t('water_level')}</div>
      <div class="v" style="${waterDim}">${water === null ? '—' : num(water)}<small>${water === null ? '' : '%'}</small></div>
      <div class="xs mut">${tank && tank.calibrated === false ? t('water_uncal') : tank ? (tankFresh ? '' : t('sensor_offline')) : ''}</div></div>
    <div class="metric"><div class="k">${icon('temp', 12)}${t('temperature')}</div><div class="v" style="${dim}">${num(l?.temperatureC)}<small>°C</small></div></div>
    <div class="metric"><div class="k">${icon('cloud', 12)}${t('humidity')}</div><div class="v" style="${dim}">${num(l?.humidityPct, 0)}<small>%</small></div></div>
  </div>`;
}
const limitsLine = (plot) => html`<div class="lim">${t('plot_limits', { t: plot.dryThresholdPct, max: plot.maxIrrigationLitres, b: plot.weeklyWaterBudgetL })}</div>`;
const agoLine = (s) => html`<div class="ago">${icon('clock', 12)}${s.latest ? t('reading_ago', { ago: agoText(s.age) }) : t('no_readings')}</div>`;

/** Desktop plot card: photo on top with the status badge on it. */
export function plotCardD(plot, readings, { limits = false, tank = null } = {}) {
  const s = plotState(plot, readings);
  return html`<a class="pc" href="#/plots/${plot.plotId}" data-plot="${plot.plotId}" aria-label="${shortName(plot.plotName)}">
    <div class="ph photo" style="${photoStyle(plot.crop)}" role="img" aria-label="${plot.crop}">${statusLvl(s)}</div>
    <div class="bd">
      <div class="row sp"><div><div class="nm">${shortName(plot.plotName)}</div><div class="xs mut" style="margin-top:2px">${plot.crop} · ${t('plot_area', { ha: plot.areaHa })}${s.latest ? ' · ' + s.latest.deviceId : ''}</div></div>${rainBit(s)}</div>
      ${metricsBlock(plot, s, tank)}${limits ? limitsLine(plot) : ''}${agoLine(s)}
    </div></a>`;
}
/** Phone plot card: thumbnail, name and meta on the left, badges on the right, then the three tiles. */
export function plotCardM(plot, readings, { limits = false, tank = null } = {}) {
  const s = plotState(plot, readings);
  return html`<a class="mc" href="#/plots/${plot.plotId}" data-plot="${plot.plotId}" aria-label="${shortName(plot.plotName)}">
    <div class="row g12"><div class="th photo" style="${photoStyle(plot.crop)}" role="img" aria-label="${plot.crop}"></div>
      <div class="grow"><div class="nm">${shortName(plot.plotName)}</div><div class="xs mut" style="margin-top:2px">${plot.crop} · ${t('plot_area', { ha: plot.areaHa })}</div>
        <div class="xs mut" style="margin-top:1px">${s.latest ? t('reading_ago_dev', { dev: s.latest.deviceId, ago: agoText(s.age) }) : t('no_readings')}</div></div>
      <div class="st">${statusLvl(s)}${rainBit(s)}</div></div>
    ${metricsBlock(plot, s, tank)}${limits ? html`<div class="xs mut" style="margin-top:8px">${t('plot_limits', { t: plot.dryThresholdPct, max: plot.maxIrrigationLitres, b: plot.weeklyWaterBudgetL })}</div>` : ''}
  </a>`;
}

// ---------- chart + table ----------
export function lineChart(readings, thr) {
  const pts = [...readings].reverse().filter((r) => typeof r.soilMoisturePct === 'number');
  if (pts.length < 2) return html`<p class="empty">${t('no_readings')}</p>`;
  const W = 640, H = 150, T = 25;
  const times = pts.map((p) => Date.parse(p.readAt));
  const t0 = times[0], t1 = times[times.length - 1] || t0 + 1;
  const vals = pts.map((p) => p.soilMoisturePct);
  const top = Math.max(thr, ...vals), bot = Math.min(thr, ...vals);
  const unit = Math.min(5, (H - T - 10) / Math.max(1, top - bot));   // 5 px per percentage point, squeezed only when the readings span a wide range
  const x = (tm) => ((tm - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v) => T + (top - v) * unit;
  let line = `M${x(times[0]).toFixed(1)},${y(vals[0]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) { const a = x(times[i - 1]), b = x(times[i]), m = (a + b) / 2; line += ` C${m.toFixed(1)},${y(vals[i - 1]).toFixed(1)} ${m.toFixed(1)},${y(vals[i]).toFixed(1)} ${b.toFixed(1)},${y(vals[i]).toFixed(1)}`; }
  const area = `${line} L${W},${H} L0,${H} Z`;
  const ticks = [0, 1, 2, 3, 4].map((i) => t0 + ((t1 - t0) * i) / 4);
  return html`<div class="chartbox"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('soil_moisture')}">
    <defs><linearGradient id="ln1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1D6246" stop-opacity=".25"/><stop offset="1" stop-color="#1D6246" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#ln1)"/>
    <line x1="0" x2="${W}" y1="${y(thr).toFixed(1)}" y2="${y(thr).toFixed(1)}" stroke="#E0573F" stroke-width="1.3" stroke-dasharray="4 3"/>
    <path d="${line}" fill="none" stroke="#1D6246" stroke-width="2.4" stroke-linecap="round"/>
  </svg><div class="lim" style="top:${(y(thr) / H * 100 - 17).toFixed(1)}%">${t('dry_limit', { t: thr })}</div></div>
  <div class="chartx">${ticks.map((tm) => html`<span>${fmtHM(new Date(tm).toISOString())}</span>`)}</div>`;
}

export function readingsTable(readings, n = 8, raw_ = false) {
  if (!readings.length) return html`<p class="empty">${t('no_readings')}</p>`;
  return html`<div class="tbl-wrap"><table class="t"><thead><tr><th>${raw_ ? 'readAt' : t('col_time')}</th><th class="c-dev">${raw_ ? 'deviceId' : t('col_device')}</th><th>${t('col_soil')}</th><th>${t('col_temp')}</th><th>${t('col_hum')}</th><th>${t('col_rain')}</th></tr></thead><tbody>
    ${readings.slice(0, n).map((r) => html`<tr><td class="n">${fmtTime(r.readAt)}</td><td class="c-dev">${r.deviceId}</td><td><b>${num(r.soilMoisturePct)}%</b></td><td>${num(r.temperatureC)} °C</td><td>${num(r.humidityPct, 0)}%</td><td>${r.raining ? t('raining') : t('dry')}</td></tr>`)}
  </tbody></table></div>`;
}

// ---------- suggestions ----------
export const STATUS_CHIP = {
  pending_approval: () => lvl('n', 'check', t('chip_can_approve')),
  rejected: () => lvl('o', 'x', t('chip_rejected')),
  approved: () => lvl('d', 'check', t('st_approved')),
  declined: () => lvl('z', '', t('st_declined')),
  deleted: () => lvl('z', '', t('st_deleted')),
};
export const sugTitle = (s, plot) => {
  const n = shortName(plot?.plotName || `plot ${s.plotId}`);
  return s.action === 'irrigate' ? t('act_irrigate', { plot: n, l: s.litres }) : s.action === 'hold' ? t('act_hold', { plot: n }) : t('act_notify', { plot: n });
};
export const sugTitleEn = (s, plot) => {
  const n = shortName(plot?.plotName || `plot ${s.plotId}`);
  return s.action === 'irrigate' ? tEn('act_irrigate', { plot: n, l: s.litres }) : s.action === 'hold' ? tEn('act_hold', { plot: n }) : tEn('act_notify', { plot: n });
};
export function sugRow(s, plot, { when = false } = {}) {
  const codes = (s.rejectReasons || []).map((r) => r.code);
  const meta = s.status === 'rejected' ? t('blocked_by_rule', { codes: codes.join(', ') }) : s.status === 'pending_approval' ? t('passed_all') : t('st_' + s.status);
  return html`<a class="srow" href="#/suggestions/${s.suggestionId}">
    <span class="ph photo" style="${photoStyle(plot?.crop)}"></span>
    <span class="grow"><span class="tt">${sugTitle(s, plot)}</span><span class="meta">${meta}${when ? ' · ' + fmtDateTime(s.createdAt) : ''}</span></span>
    ${(STATUS_CHIP[s.status] || (() => ''))(s)}
    <span class="go">${icon('chev', 14)}</span></a>`;
}

const RULES = ['ACTION_NOT_ALLOWED', 'LITRES_OUT_OF_RANGE', 'SENSOR_STALE', 'SOIL_NOT_DRY', 'RAIN_DETECTED', 'WATER_BUDGET_EXCEEDED'];
export function ruleRows(s, f) {
  const failing = new Set((s.rejectReasons || []).map((r) => r.code));
  const irrigate = s.action === 'irrigate';
  const val = (code) => {
    switch (code) {
      case 'ACTION_NOT_ALLOWED': return { v: cap(s.action), sub: '' };
      case 'LITRES_OUT_OF_RANGE': return { v: `${s.litres} L`, sub: f?.maxIrrigationLitres != null ? t('v_max', { n: f.maxIrrigationLitres }) : '' };
      case 'SENSOR_STALE': return { v: f?.readingAgeMinutes != null ? t('v_min', { n: f.readingAgeMinutes }) : '—', sub: t('v_limit', { n: f?.staleLimitMinutes ?? FRESH_MINUTES }) };
      case 'SOIL_NOT_DRY': return { v: f?.soilMoisturePct != null ? `${num(f.soilMoisturePct)}%` : '—', sub: f?.dryThresholdPct != null ? t('v_dry_limit', { n: f.dryThresholdPct }) : '' };
      case 'RAIN_DETECTED': return failing.has(code) || f?.raining ? { v: t('rain_word'), sub: t('v_raining', { b: String(!!f?.raining) }) } : { v: t('dry'), sub: '' };
      case 'WATER_BUDGET_EXCEEDED': return { v: `${s.litres} L`, sub: f?.weeklyWaterBudgetL != null ? t('v_budget', { used: num(f.usedLast7DaysL ?? 0, 0), budget: num(f.weeklyWaterBudgetL, 0) }) : '' };
      default: return { v: '', sub: '' };
    }
  };
  const rows = RULES.map((code) => {
    const state = failing.has(code) ? 'no' : (!irrigate && code !== 'ACTION_NOT_ALLOWED') ? 'na' : 'ok';
    return { code, state, ...val(code), sub: state === 'na' ? t('rules_irrigation_only') : val(code).sub };
  });
  for (const code of ['NO_SENSOR_DATA', 'PLOT_NOT_FOUND']) if (failing.has(code)) rows.push({ code, state: 'no', v: '', sub: '' });
  return rows;
}
const ruleHtml = (r) => html`<div class="rrow ${r.state === 'no' ? 'bad' : ''}">
  <span class="ico ${r.state}">${icon(r.state === 'ok' ? 'check' : r.state === 'no' ? 'x' : 'lock', 14)}</span>
  <div><div class="nm">${t('r_' + r.code)}</div><div class="cd">${r.code}</div></div>
  <div class="vl">${r.v}${r.sub ? html`<small>${r.sub}</small>` : ''}</div></div>`;

// The advice reason comes from the API in English (or isiZulu). For isiZulu the hand-written lines (zuBlock) come first;
// for every other language the English reason goes through the AI translate pipeline (tx), numbers / litres kept.
function reasonText(s, plot, f) {
  const r = reasonEn(s, plot, f);
  const l = getLang();
  if (l === 'en' || (l === 'zu' && zuLines(s, plot, f).lines.length)) return r;
  return tx(r);
}
export const reasonTextFor = reasonText;
function reasonEn(s, plot, f) {
  if (!looksZulu(s.reason)) return String(s.reason || '').replace(/\s*\(example\)/gi, '');
  const m = f?.soilMoisturePct != null ? num(f.soilMoisturePct) : '—', th = f?.dryThresholdPct ?? plot?.dryThresholdPct ?? '—';
  return tEn('reason_' + (s.action === 'irrigate' ? 'irrigate' : s.action === 'hold' ? 'hold' : 'notify'), { m, t: th, l: s.litres });
}
function zuLines(s, plot, f) {
  const codes = (s.rejectReasons || []).map((r) => r.code);
  const out = [];
  if (s.status === 'rejected' && codes.includes('RAIN_DETECTED')) return { lines: [], rain: true };   // the isiZulu rain line is inside the red banner
  if (s.action === 'irrigate') {
    const a = zuIrrigateLine(plot, s.litres);
    if (a) { out.push(a); if (f?.soilMoisturePct != null && f?.dryThresholdPct != null && f.soilMoisturePct < f.dryThresholdPct) out.push(zuSoilDryLine(f.soilMoisturePct, f.dryThresholdPct)); return { lines: out }; }
  }
  if (looksZulu(s.reason)) return { lines: [stripDraftNote(s.reason)] };
  return { lines: [] };
}
const zuBlock = (z, mobile) => !z.lines.length ? '' : html`<div class="zu" lang="zu" style="margin-top:${mobile ? 9 : 12}px"><div class="lbl">${t('isizulu')}</div>${z.lines.map((l, i) => html`<div class="${i === 0 ? 'b' : ''}" style="font-size:${mobile ? (i === 0 ? 12.5 : 12) : (i === 0 ? 13.5 : 13)}px;margin-top:2px;line-height:1.3${i ? ';color:#33463b' : ''}">${l}</div>`)}</div>`;

/** Three-step bar of the approved screens: AI suggested - Rules checked - You decide. */
function stepper(s) {
  const st = s.status;
  const third = st === 'pending_approval' ? 'cur' : st === 'rejected' ? 'off' : 'done';
  const b2 = st === 'rejected' ? 'bad' : 'done';
  return html`<div class="stp"><span class="s"><b class="done">${icon('check', 12)}</b>${t('step_ai')}</span>
    <span class="s"><b class="${b2}">${icon(st === 'rejected' ? 'x' : 'check', 12)}</b>${t('step_rules')}</span>
    <span class="s"><b class="${third}">${third === 'done' ? icon('check', 12) : '3'}</b>${st === 'pending_approval' || st === 'rejected' ? t('step_you') : t('step_done')}</span></div>`;
}

export function reviewView(s, plot, f, meta = {}) {
  const lang = getLang();
  const rejected = s.status === 'rejected';
  const pending = s.status === 'pending_approval';
  const reasons = s.rejectReasons || [];
  const rain = reasons.some((r) => r.code === 'RAIN_DETECTED');
  const rows = ruleRows(s, f);
  const z = zuLines(s, plot, f);
  const plotName = shortName(plot?.plotName);
  const heroPhoto = rain ? '/assets/photos/rain-wheat-storm-kenya.jpg' : '/assets/photos/field-header-maize.jpg';
  const title = rejected ? t('blocked_title') : t('review_title');
  const verdictLine = rejected ? html`<span class="verdict no">${icon('x', 14)}${t('rejected_rules')}</span>` : html`<span class="verdict ok">${icon('check', 14)}${t('passed_rules')}</span>`;
  const factsNote = meta.factsAsOf === 'now' ? t('nums_now') : t('nums_used');
  const zFirst = lang === 'zu';
  const when = `${fmtDay(s.createdAt)}, ${fmtHM(s.createdAt)}`;
  const lng = (onPhoto) => langToggle(onPhoto);

  // --- rule card
  const shown = rejected ? [...rows.filter((r) => r.state === 'no'), ...rows.filter((r) => r.state === 'ok' && r.code === 'SOIL_NOT_DRY').slice(0, 1)] : rows;
  const passedHidden = rows.filter((r) => r.state === 'ok').length - shown.filter((r) => r.state === 'ok').length;
  const banners = rejected ? reasons.map((r) => html`<div class="banner red rej" role="alert"><div class="bt">${icon('lock', 18)}${t('rej_title_' + r.code)}</div><div class="bd">${t('rej_why_' + r.code)}</div>
      ${r.code === 'RAIN_DETECTED' ? html`<div class="bz" lang="zu">${ZU_RAIN_BANNER}</div>` : ''}</div>`) : '';
  const statusBanner = s.status === 'approved' ? html`<div class="banner mint stat" role="status"><span>${icon('check', 20)}</span><div><h3>${t('approved_banner')}</h3><div>${t('approved_text')}</div></div></div>`
    : s.status === 'declined' ? html`<div class="banner blue stat" role="status"><span>${icon('x', 20)}</span><div><h3>${t('declined_banner')}</h3><div>${t('declined_text')}</div></div></div>`
    : s.status === 'deleted' ? html`<div class="banner blue stat"><div>${t('deleted_text')}</div></div>` : '';
  const ruleCard = (cls) => html`<div class="${cls}">
    <div class="row sp" style="margin-bottom:2px"><span class="lbl">${t('rule_check')}</span>${verdictLine}</div>
    ${banners}
    <div style="${rejected ? 'margin-top:4px' : ''}">${shown.map(ruleHtml)}</div>
    ${rejected ? html`<div class="foot2"><span class="ok">${icon('check', 12)}${t('other_rules_passed', { n: passedHidden })}</span><span>${t('verdict_word')} ${s.verdict || ''}</span></div>`
      : html`<div class="foot2"><span>${t('verdict_word')} ${s.verdict || ''}<span class="d-only"> · ${s.requestId || ''}</span></span><span>${t('numbers_from_oe')}</span></div>`}</div>`;

  // --- numbers card (desktop)
  const nums = f ? html`<div class="dcard"><div class="lbl" style="margin-bottom:4px">${factsNote}</div>
      ${rejected && f.raining ? html`<div class="kv"><span>${t('n_rain')}</span><b>true</b></div>` : ''}
      <div class="kv"><span>${t('n_soil')}</span><b>${f.soilMoisturePct != null ? num(f.soilMoisturePct) + '%' : '—'}</b></div>
      ${rejected && f.raining ? '' : html`<div class="kv"><span>${t('n_dry')}</span><b>${f.dryThresholdPct != null ? f.dryThresholdPct + '%' : '—'}</b></div>`}
      <div class="kv"><span>${t('n_age')}</span><b>${f.readingAgeMinutes != null ? f.readingAgeMinutes + ' min' : '—'}</b></div>
      <div class="kv"><span>${t('n_used')}</span><b>${f.usedLast7DaysL != null ? num(f.usedLast7DaysL, 0) + ' L' : '—'}</b></div>
      <div class="kv"><span>${t('n_budget')}</span><b>${f.weeklyWaterBudgetL != null ? num(f.weeklyWaterBudgetL, 0) + ' L' : '—'}</b></div></div>` : '';

  const reason = reasonText(s, plot, f);
  const reqId = s.requestId || '';
  const sugLabel = html`<div class="row sp"><span class="lbl">${t('sug_written_by_ai')}</span><span class="reqid">${reqId}</span></div>`;

  // --- desktop decision / what you can do
  const desktopDecision = pending ? html`<div class="dcard"><div class="dh17">${t('your_decision')}</div><p class="sm mut" style="margin-top:3px;line-height:1.4">${t('decision_hint')}</p>
      <div class="dbtns"><button class="btn out" data-act="decline" data-id="${s.suggestionId}">${icon('x', 16)}${t('decline')}</button><button class="btn dk" data-act="approve" data-id="${s.suggestionId}">${icon('check', 16)}${t('approve')}</button></div></div>`
    : rejected ? html`<div class="dcard"><div class="dh17">${t('what_you_can_do')}</div>
      <div class="dtodo"><span class="circ">${icon('clock', 16)}</span><div class="grow"><div class="b" style="font-size:13.5px">${t('wait_ask_d')}</div><div class="xs mut" style="margin-top:2px">${t('wait_ask_sub')}${rain ? html` <span lang="zu">${ZU_RAIN_WAIT}</span>` : ''}</div></div></div>
      <div class="dtodo"><span class="circ">${icon('book', 16)}</span><div class="grow"><div class="b" style="font-size:13.5px">${t('dismiss_d')}</div><div class="xs mut" style="margin-top:2px">${t('dismiss_sub_d')}</div></div></div>
      <div class="dbtns"><button class="btn out" data-act="dismiss">${icon('x', 16)}${t('dismiss')}</button><button class="btn dk" data-act="ask" data-plot="${s.plotId}">${icon('refresh', 16)}${t('ask_new')}</button></div></div>`
    : html`<div class="dcard row g8 wrap"><a class="btn out sm" href="#/">${t('back_dashboard')}</a><a class="btn out sm" href="#/audit">${t('open_audit')}</a></div>`;

  const mobileTodo = rejected ? html`<div class="card"><div class="lbl" style="margin-bottom:6px">${t('what_you_can_do')}</div>
      <div class="todo"><span class="circ">${icon('clock', 15)}</span><div class="grow" style="font-size:12.5px;line-height:1.3"><span class="b">${t('wait_ask')}</span> <span class="mut">${t('wait_ask_sub')}${rain ? html` <span lang="zu">${ZU_RAIN_WAIT}</span>` : ''}</span></div></div>
      <div class="todo"><span class="circ">${icon('book', 15)}</span><div class="grow" style="font-size:12.5px;line-height:1.3"><span class="b">${t('dismiss_it')}</span> <span class="mut">${t('dismiss_sub')}</span></div></div></div>`
    : !pending ? html`<div class="card row g8 wrap"><a class="btn out sm" href="#/">${t('back_dashboard')}</a><a class="btn out sm" href="#/audit">${t('open_audit')}</a></div>` : '';

  const bar = pending ? html`<div class="actbar m-only"><button class="a" data-act="decline" data-id="${s.suggestionId}">${icon('x', 16)}${t('decline')}</button><button class="a go" data-act="approve" data-id="${s.suggestionId}">${icon('check', 16)}${t('approve')}</button></div>`
    : rejected ? html`<div class="actbar m-only"><button class="a" data-act="dismiss">${icon('x', 16)}${t('dismiss')}</button><button class="a go" data-act="ask" data-plot="${s.plotId}">${icon('refresh', 16)}${t('ask_again')}</button></div>` : '';

  // ================= desktop
  const dHead = html`<div class="rvh"><div class="row g12"><a class="circ" href="#/suggestions" aria-label="${t('nav_suggestions')}">${icon('back', 18)}</a>
      <div><div class="dh" style="font-size:24px">${rejected ? t('blocked_head') : t('review_title')}</div><div class="xs mut" style="margin-top:2px">${plotName} · ${rejected ? t('oe_refused') : when}</div></div></div>
      <div class="stpw">${stepper(s)}</div></div>`;
  const dSugFull = html`<div class="dcard flush"><div class="photo" style="height:170px;${photoStyle(plot?.crop, 'background-position:50% 42%')}"></div>
      <div class="dsugbody">${sugLabel}<div class="sugtitle" style="font-size:24px;margin-top:6px;letter-spacing:-.4px">${sugTitle(s, plot)}</div>
        ${zFirst ? zuBlock(z) : ''}<div style="font-size:13.5px;line-height:1.45;margin-top:${zFirst && z.lines.length ? 12 : 6}px;color:#33463b">${reason}</div>${zFirst ? '' : zuBlock(z)}
        ${String(s.provider || '').includes('fallback') ? html`<div class="note">${icon('shield', 14)}<span>${t('fb_note')}</span></div>` : ''}</div></div>`;
  const dSugSmall = html`<div class="dcard">${sugLabel}<div class="row g12" style="margin-top:10px"><div class="photo" style="width:56px;height:56px;border-radius:16px;${photoStyle(plot?.crop)}"></div><div class="sugtitle" style="font-size:22px;letter-spacing:-.4px">${sugTitle(s, plot)}</div></div>
      <div style="font-size:13.5px;line-height:1.45;margin-top:10px;color:#33463b">${reason}</div>${zuBlock(z)}</div>`;
  const desktop = rejected ? html`<div class="d-only">${dHead}<div class="dsug">
      <div class="col w560"><div class="dhero" style="${bg(heroPhoto)};background-position:50% 62%"><div class="t"><h1>${title}</h1><div class="sm" style="opacity:.92;margin-top:3px">${plotName} · ${when}</div></div></div>${dSugSmall}${desktopDecision}</div>
      <div class="col w600"><div class="dcard rc">${ruleCard('')}</div>${nums}</div></div></div>`
    : html`<div class="d-only">${dHead}<div class="dsug">
      <div class="col w600">${dSugFull}${nums}</div>
      <div class="col w560">${statusBanner}<div class="dcard rc">${ruleCard('')}</div>${desktopDecision}</div></div></div>`;

  // ================= phone
  const mSug = html`<div class="card">${html`<div class="row sp"><span class="lbl">${t('sug_written_by_ai')}</span><span class="reqid" style="font-size:9.5px">${reqId}</span></div>`}
      <div class="row g12" style="margin-top:${rejected ? 8 : 9}px"><div class="photo" style="width:${rejected ? 40 : 48}px;height:${rejected ? 40 : 48}px;border-radius:${rejected ? 12 : 14}px;${photoStyle(plot?.crop)}"></div><div class="sugtitle" style="font-size:${rejected ? 16 : 18}px">${sugTitle(s, plot)}</div></div>
      ${rejected ? '' : html`${zFirst ? zuBlock(z, true) : ''}<div class="sm" style="margin-top:${zFirst && z.lines.length ? 9 : 9}px;line-height:1.4;color:#33463b">${reason}</div>${zFirst ? '' : zuBlock(z, true)}`}</div>`;
  const mobile = rejected ? html`<div class="m-only"><div class="mrv-hero" style="${bg(heroPhoto)};background-position:50% 45%"><div class="mh-top"><a class="circ" href="#/suggestions" aria-label="${t('nav_suggestions')}">${icon('back', 20)}</a>${lng(true)}</div>
      <div class="mh-t"><h1>${title}</h1><div class="row g8" style="margin-top:6px"><span class="sm" style="opacity:.92">${plotName} · ${fmtDay(s.createdAt).replace(/ \d{4}$/, '')}, ${fmtHM(s.createdAt)}</span><span class="tag-ex m">${t('example_data')}</span></div></div></div>
      <div class="mrv-sheet"><div class="mrv-body">${stepper(s)}${mSug}<div class="card rc">${ruleCard('')}</div>${mobileTodo}</div></div></div>`
    : html`<div class="m-only"><div class="mrv-head"><a class="circ" href="#/suggestions" aria-label="${t('nav_suggestions')}">${icon('back', 20)}</a><div class="t"><div class="dh">${title}</div><div class="xs mut" style="margin-top:2px">${plotName} · ${t('example_data')}</div></div>${lng(false)}</div>
      <div class="mrv-body">${stepper(s)}${statusBanner}${mSug}<div class="card rc">${ruleCard('')}</div>${mobileTodo}</div></div>`;
  return html`${desktop}${mobile}${bar}`;
}

export function langToggle(onPhoto = false) {
  const l = getLang();
  // one native <select> with all 11 official languages, each written in its own language (flat style, no highlighted border)
  return html`<label class="lang ${onPhoto ? '' : 'd'}"><span class="sr">${t('set_lang')}</span><select data-act="lang-pick" aria-label="Language / Ulimi / Taal">${LANGS.map(([c, n]) => html`<option value="${c}" lang="${c}" ${c === l ? raw('selected') : ''}>${n}</option>`)}</select></label>`;
}

export function confirmSheet({ summary, secs, id, crop, reqId }) {
  const btns = (desk) => desk
    ? html`<div class="dbtns d-only" style="margin-top:18px"><button class="btn out" data-act="sheet-cancel">${icon('back', 16)}${t('go_back')}</button><button class="btn dk" style="flex:1.4" data-act="confirm" data-id="${id}">${icon('check', 16)}${t('confirm_go')}</button></div>`
    : html`<div class="actbar m-only"><button class="a" data-act="sheet-cancel">${icon('back', 16)}${t('go_back')}</button><button class="a go" data-act="confirm" data-id="${id}">${icon('check', 16)}${t('confirm_go')}</button></div>`;
  return html`<div class="scrim" data-act="sheet-bg" role="presentation"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-h">
    <div class="grab"></div>
    <div class="sh-t"><h2 id="sheet-h">${t('confirm_title')}</h2><span class="chip sm2 grey">${icon('clock', 12)}<span>${t('expires_in', { t: '' }).trim()}</span> <span class="timer" data-timer>${fmtSecs(secs)}</span></span></div>
    ${getLang() === 'zu' ? '' : html`<div class="zl" lang="zu">Qinisekisa isinqumo sakho.</div>`}
    <div class="appr"><div class="th photo" style="${photoStyle(crop)}"></div><div><div class="lbl">${t('you_approving')}</div><div class="s">${String(summary || "").replace(/ \(example\)/gi, "")}</div></div></div>
    <div class="infos"><div>${icon('shield', 16)}<span>${t('confirm_hint')}</span></div><div>${icon('book', 16)}<span>${t('confirm_audit', { id: reqId || '' })}</span></div></div>
    <div class="pbar"><i data-bar style="width:100%"></i></div>
    ${btns(true)}${btns(false)}
  </div></div>`;
}
export const fmtSecs = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;

// ---------- audit ----------
export function parseDetail(d) {
  if (d && typeof d === 'object') return d;
  if (typeof d === 'string' && d.trim().startsWith('{')) { try { return JSON.parse(d); } catch { /* plain text */ } }
  return d;
}
export function auditRow(e) {
  const d = parseDetail(e.detail);
  const name = e.event === 'tool_call' ? `${t('ev_tool_call')}: ${d?.tool || ''}` : (t('ev_' + e.event) !== 'ev_' + e.event ? t('ev_' + e.event) : e.event.replace(/_/g, ' '));
  const summary = typeof d === 'string' ? d : d?.tool ? `${d.ok === false ? 'failed' : 'ok'} · ${d.ms ?? 0} ms${d.error ? ' · ' + d.error : ''}` : '';
  const sid = typeof d === 'string' ? /suggestion (\d+)/.exec(d)?.[1] : null;
  const chip = e.event === 'rule_check' ? (/rejected_by_rules/.test(String(d)) ? lvl('o', 'x', t('chip_rejected')) : lvl('n', 'check', t('passed_rules')))
    : e.event === 'suggestion_approved' ? lvl('d', 'check', t('st_approved')) : e.event === 'suggestion_declined' ? lvl('z', '', t('st_declined')) : '';
  return html`<div class="aud"><div class="when">${fmtTime(e.at)}<br>${fmtShortDay(e.at)}</div><div class="grow">
    <div class="row g8 wrap"><span class="ev">${name}</span>${chip}</div>
    <div class="sm mut">${e.actor}${summary ? ' · ' : ''}${summary}${sid ? html` · <a href="#/suggestions/${sid}" class="b" style="color:var(--f7)">#${sid}</a>` : ''}</div>
    <div class="reqid">${t('audit_request')} ${e.requestId || '—'}</div>
    <details><summary>${t('audit_show')}</summary><pre>${JSON.stringify({ auditId: e.auditId, at: e.at, requestId: e.requestId, actor: e.actor, event: e.event, detail: d }, null, 2)}</pre></details></div></div>`;
}
