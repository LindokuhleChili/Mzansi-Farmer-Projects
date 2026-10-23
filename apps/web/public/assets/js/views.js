// Pure rendering: data in, HTML out (every value is escaped by html``). Event handling lives in main.js via data-act attributes.
import { html, raw, icon, fmtTime, fmtHM, fmtDay, fmtShortDay, fmtDateTime, ageMinutes, num, shortName, cap, photoUrl } from './util.js';
import { t, tEn, getLang, zuIrrigateLine, zuSoilDryLine, ZU_RAIN_BANNER, ZU_RAIN_WAIT, stripDraftNote, looksZulu } from './i18n.js';
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
const statusPill = (s) => !s.latest ? html`<span class="chip sm2 grey">${t('no_data')}</span>` : !s.fresh ? html`<span class="chip sm2 grey"><span class="dot grey"></span>${t('sensor_offline')}</span>`
  : s.dry ? html`<span class="chip sm2 amber">${icon('drop', 12)}${t('dry_soil')}</span>` : html`<span class="chip sm2 ok">${icon('check', 12)}${t('moisture_ok')}</span>`;
const rainBit = (s) => !s.latest || !s.fresh ? '' : s.latest.raining ? html`<span class="chip sm2 blue">${icon('rain', 12)}${t('rain_detected')}</span>` : html`<span class="chip sm2">${icon('sun', 12)}${t('no_rain')}</span>`;

export function metricsBlock(plot, s) {
  const l = s.latest;
  const soil = l ? l.soilMoisturePct : null;
  const w = soil === null ? 0 : Math.max(0, Math.min(100, soil));
  return html`<div class="metrics">
    <div class="metric"><div class="k">${icon('drop', 13)}${t('soil_moisture')}</div>
      <div class="v num" style="${s.fresh ? '' : 'opacity:.6'}">${num(soil)}<small>%</small></div>
      <div class="limbar" title="${t('dry_limit', { t: plot.dryThresholdPct })}"><i class="${s.dry ? 'dry' : ''}" style="width:${w}%"></i><u style="left:${plot.dryThresholdPct}%"></u></div></div>
    <div class="metric"><div class="k">${icon('temp', 13)}${t('temperature')}</div><div class="v num" style="${s.fresh ? '' : 'opacity:.6'}">${num(l?.temperatureC)}<small>°C</small></div></div>
    <div class="metric"><div class="k">${icon('cloud', 13)}${t('humidity')}</div><div class="v num" style="${s.fresh ? '' : 'opacity:.6'}">${num(l?.humidityPct, 0)}<small>%</small></div></div>
  </div>`;
}

export function plotCard(plot, readings, { limits = false } = {}) {
  const s = plotState(plot, readings);
  const meta = `${plot.crop} · ${t('plot_area', { ha: plot.areaHa })}${s.latest ? ' · ' + s.latest.deviceId : ''}`;
  return html`<article class="pcard" data-plot="${plot.plotId}">
    <div class="head">
      <div class="ph" style="${bg(photoUrl(plot.crop))}" role="img" aria-label="${plot.crop}"></div>
      <div class="t"><div class="nm">${shortName(plot.plotName)}</div><div class="meta">${meta}</div></div>
      <div class="stwrap"><div class="st">${statusPill(s)}${rainBit(s)}</div></div>
    </div>
    <div class="body">
      ${metricsBlock(plot, s)}
      ${limits ? html`<div class="xs mut">${t('plot_limits', { t: plot.dryThresholdPct, max: plot.maxIrrigationLitres, b: plot.weeklyWaterBudgetL })}</div>` : ''}
      <div class="foot">
        <span class="xs mut row g4">${icon('clock', 13)}${s.latest ? t('reading_ago', { ago: agoText(s.age) }) : t('no_readings')}</span>
        <span class="row g8">
          <a class="btn out sm" href="#/plots/${plot.plotId}">${t('details')}</a>
          <button class="btn dk sm" data-act="ask" data-plot="${plot.plotId}">${icon('spark', 15)}${t('ask_ai')}</button>
        </span>
      </div>
    </div>
  </article>`;
}

// ---------- chart ----------
export function lineChart(readings, thr) {
  const pts = [...readings].reverse().filter((r) => typeof r.soilMoisturePct === 'number');
  if (pts.length < 2) return html`<p class="empty">${t('no_readings')}</p>`;
  const W = 640, Hh = 190, L = 34, R = 10, T = 12, B = 24;
  const times = pts.map((p) => Date.parse(p.readAt));
  const t0 = times[0], t1 = times[times.length - 1] || t0 + 1;
  const vals = pts.map((p) => p.soilMoisturePct).concat([thr]);
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 5) / 5) * 5), hi = Math.min(100, Math.ceil((Math.max(...vals) + 5) / 5) * 5);
  const x = (tm) => L + ((tm - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (Hh - T - B);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(p.soilMoisturePct).toFixed(1)}`).join(' ');
  const area = `${line} L${x(t1).toFixed(1)},${(Hh - B)} L${x(t0).toFixed(1)},${(Hh - B)} Z`;
  const ticks = [0, 1, 2, 3, 4].map((i) => t0 + ((t1 - t0) * i) / 4);
  const yt = [lo, Math.round((lo + hi) / 2), hi];
  return html`<div class="chartbox"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${t('soil_moisture')}">
    ${raw(yt.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#E3EAE0" stroke-width="1"/><text class="chart-axis" x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}%</text>`).join(''))}
    <path d="${area}" fill="#1D6246" fill-opacity=".10"/>
    <line x1="${L}" x2="${W - R}" y1="${y(thr)}" y2="${y(thr)}" stroke="#D9573F" stroke-width="1.2" stroke-dasharray="4 4"/>
    <text class="chart-axis" x="${W - R}" y="${y(thr) - 4}" text-anchor="end" fill="#D9573F" style="fill:#D9573F;font-weight:600">${t('dry_limit', { t: thr })}</text>
    <path d="${line}" fill="none" stroke="#0E3626" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    ${raw(pts.length <= 40 ? pts.map((p, i) => `<circle cx="${x(times[i]).toFixed(1)}" cy="${y(p.soilMoisturePct).toFixed(1)}" r="2.4" fill="#0E3626"/>`).join('') : '')}
    ${raw(ticks.map((tm) => `<text class="chart-axis" x="${x(tm).toFixed(1)}" y="${Hh - 6}" text-anchor="middle">${fmtHM(new Date(tm).toISOString())}</text>`).join(''))}
  </svg></div>`;
}

export function readingsTable(readings, n = 8) {
  if (!readings.length) return html`<p class="empty">${t('no_readings')}</p>`;
  return html`<div class="tbl-wrap"><table class="t"><thead><tr><th>${t('col_time')}</th><th class="c-dev">${t('col_device')}</th><th>${t('col_soil')}</th><th>${t('col_temp')}</th><th>${t('col_hum')}</th><th>${t('col_rain')}</th></tr></thead><tbody>
    ${readings.slice(0, n).map((r) => html`<tr><td class="n">${fmtTime(r.readAt)}</td><td class="c-dev">${r.deviceId}</td><td class="n"><b>${num(r.soilMoisturePct)}%</b></td><td class="n">${num(r.temperatureC)} °C</td><td class="n">${num(r.humidityPct, 0)}%</td><td>${r.raining ? t('raining') : t('dry')}</td></tr>`)}
  </tbody></table></div>`;
}

// ---------- suggestions ----------
export const STATUS_CHIP = {
  pending_approval: (s) => html`<span class="chip sm2 ok">${icon('check', 12)}${t('chip_can_approve')}</span>`,
  rejected: () => html`<span class="chip sm2 red">${icon('x', 12)}${t('chip_rejected')}</span>`,
  approved: () => html`<span class="chip sm2 dark">${icon('check', 12)}${t('st_approved')}</span>`,
  declined: () => html`<span class="chip sm2 grey">${t('st_declined')}</span>`,
  deleted: () => html`<span class="chip sm2 grey">${t('st_deleted')}</span>`,
};
export const sugTitle = (s, plot) => {
  const n = shortName(plot?.plotName || `plot ${s.plotId}`);
  return s.action === 'irrigate' ? t('act_irrigate', { plot: n, l: s.litres }) : s.action === 'hold' ? t('act_hold', { plot: n }) : t('act_notify', { plot: n });
};
export const sugTitleEn = (s, plot) => {
  const n = shortName(plot?.plotName || `plot ${s.plotId}`);
  return s.action === 'irrigate' ? tEn('act_irrigate', { plot: n, l: s.litres }) : s.action === 'hold' ? tEn('act_hold', { plot: n }) : tEn('act_notify', { plot: n });
};
export function sugRow(s, plot) {
  const codes = (s.rejectReasons || []).map((r) => r.code);
  const meta = s.status === 'rejected' ? `${t('rej_title_' + (codes[0] || 'ACTION_NOT_ALLOWED'))} · ${codes.join(', ')}` : s.status === 'pending_approval' ? t('passed_all') : t('st_' + s.status);
  return html`<a class="srow" href="#/suggestions/${s.suggestionId}">
    <span class="ph" style="${bg(photoUrl(plot?.crop))}"></span>
    <span class="grow"><span class="tt">${sugTitle(s, plot)}</span><span class="meta">${meta}</span><span class="meta">${fmtDateTime(s.createdAt)}</span>
      <span class="chipline">${(STATUS_CHIP[s.status] || (() => ''))(s)}</span></span>
    <span class="go">${icon('next', 16)}</span></a>`;
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
      case 'RAIN_DETECTED': return { v: f?.raining ? t('raining') : t('dry'), sub: t('v_raining', { b: String(!!f?.raining) }) };
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
const ruleHtml = (r) => html`<div class="rule ${r.state === 'no' ? 'fail' : ''}">
  <span class="ico ${r.state}">${icon(r.state === 'ok' ? 'check' : r.state === 'no' ? 'x' : 'lock', 14)}</span>
  <span><span class="nm">${t('r_' + r.code)}</span><br><span class="dt">${r.code}</span></span>
  <span class="val">${r.v}${r.sub ? html`<small>${r.sub}</small>` : ''}</span></div>`;

function reasonText(s, plot, f) {
  if (!looksZulu(s.reason)) return s.reason;
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

function zuBlock(z) {
  if (!z.lines.length) return '';
  return html`<div class="zuBlock" lang="zu"><div class="lbl">${t('isizulu')}</div>${z.lines.map((l, i) => html`<div class="${i === 0 ? 'l1' : ''}">${l}</div>`)}</div>`;
}

function stepper(s) {
  const st = s.status;
  const third = st === 'pending_approval' ? 'cur' : st === 'rejected' ? '' : 'done';
  return html`<div class="stepper">
    <div class="s done"><b>${icon('check', 14)}</b>${t('step_ai')}</div>
    <div class="s ${st === 'rejected' ? 'bad' : 'done'}"><b>${icon(st === 'rejected' ? 'x' : 'check', 14)}</b>${t('step_rules')}</div>
    <div class="s ${third}"><b>${third === 'done' ? icon('check', 14) : '3'}</b>${st === 'rejected' ? t('step_you') : st === 'pending_approval' ? t('step_you') : t('step_done')}</div></div>`;
}

export function reviewView(s, plot, f, meta = {}) {
  const lang = getLang();
  const rejected = s.status === 'rejected';
  const reasons = s.rejectReasons || [];
  const rain = reasons.some((r) => r.code === 'RAIN_DETECTED');
  const rows = ruleRows(s, f);
  const z = zuLines(s, plot, f);
  const passedN = rows.filter((r) => r.state === 'ok').length;
  const headPhoto = rejected && rain ? '/assets/photos/rain-wheat-storm-kenya.jpg' : '/assets/photos/field-header-maize.jpg';
  const title = rejected ? t('blocked_title') : t('review_title');
  const verdictLine = rejected ? html`<span class="verdict no">${icon('x', 14)}${t('rejected_rules')}</span>` : s.status === 'pending_approval' || s.status === 'approved' || s.status === 'declined' ? html`<span class="verdict ok">${icon('check', 14)}${t('passed_rules')}</span>` : '';
  const factsNote = meta.factsAsOf === 'now' ? t('nums_now') : t('nums_used');

  const banners = rejected ? reasons.map((r, i) => html`<div class="banner red" role="alert"><span>${icon('lock', 20)}</span><div>
      <h3>${t('rej_title_' + r.code)}</h3><div>${t('rej_why_' + r.code)}</div>
      ${r.code === 'RAIN_DETECTED' ? html`<div class="b" lang="zu" style="margin-top:6px">${ZU_RAIN_BANNER}</div>` : ''}
      <div class="srv">${r.code}: ${r.message}</div></div></div>`) : '';

  const statusBanner = s.status === 'approved' ? html`<div class="banner mint" role="status"><span>${icon('check', 20)}</span><div><h3>${t('approved_banner')}</h3><div>${t('approved_text')}</div></div></div>`
    : s.status === 'declined' ? html`<div class="banner blue" role="status"><span>${icon('x', 20)}</span><div><h3>${t('declined_banner')}</h3><div>${t('declined_text')}</div></div></div>`
    : s.status === 'deleted' ? html`<div class="banner blue"><div>${t('deleted_text')}</div></div>` : '';

  const decision = s.status === 'pending_approval' ? html`<div class="card desk-only"><div class="lbl" style="margin-bottom:6px">${t('your_decision')}</div><p class="sm mut" style="margin-bottom:12px">${t('decision_hint')}</p>
      <div class="decide"><button class="btn out" data-act="decline" data-id="${s.suggestionId}">${icon('x', 16)}${t('decline')}</button><button class="btn dk" data-act="approve" data-id="${s.suggestionId}">${icon('check', 16)}${t('approve')}</button></div></div>`
    : rejected ? html`<div class="card"><div class="lbl" style="margin-bottom:4px">${t('what_you_can_do')}</div>
      <div class="todo"><span class="ico">${icon('clock', 18)}</span><div><b>${t('wait_ask')}</b> <span class="mut">${t('wait_ask_sub')}</span>${rain && lang === 'zu' ? html` <span lang="zu">${ZU_RAIN_WAIT}</span>` : rain ? html`<br><span class="mut" lang="zu">${ZU_RAIN_WAIT}</span>` : ''}</div></div>
      <div class="todo"><span class="ico">${icon('book', 18)}</span><div><b>${t('dismiss_it')}</b> <span class="mut">${t('dismiss_sub')}</span></div></div>
      <div class="decide desk-only" style="margin-top:8px"><button class="btn out" data-act="dismiss">${icon('x', 16)}${t('dismiss')}</button><button class="btn dk" data-act="ask" data-plot="${s.plotId}">${icon('refresh', 16)}${t('ask_again')}</button></div></div>`
    : html`<div class="card row g8 wrap"><a class="btn out sm" href="#/">${t('back_dashboard')}</a><a class="btn out sm" href="#/audit">${t('open_audit')}</a></div>`;

  const bar = s.status === 'pending_approval' ? html`<div class="actbar mob-only"><button class="a" data-act="decline" data-id="${s.suggestionId}">${icon('x', 16)}${t('decline')}</button><button class="a go" data-act="approve" data-id="${s.suggestionId}">${icon('check', 16)}${t('approve')}</button></div>`
    : rejected ? html`<div class="actbar mob-only"><button class="a" data-act="dismiss">${icon('x', 16)}${t('dismiss')}</button><button class="a go" data-act="ask" data-plot="${s.plotId}">${icon('refresh', 16)}${t('ask_again')}</button></div>` : '';

  const nums = f ? html`<div class="card"><div class="lbl" style="margin-bottom:6px">${factsNote}</div>
      <div class="kv"><span>${t('n_soil')}</span><b>${f.soilMoisturePct != null ? num(f.soilMoisturePct) + '%' : '—'}</b></div>
      <div class="kv"><span>${t('n_dry')}</span><b>${f.dryThresholdPct != null ? f.dryThresholdPct + '%' : '—'}</b></div>
      <div class="kv"><span>${t('n_age')}</span><b>${f.readingAgeMinutes != null ? f.readingAgeMinutes + ' min' : '—'}</b></div>
      <div class="kv"><span>${t('n_used')}</span><b>${f.usedLast7DaysL != null ? num(f.usedLast7DaysL, 0) + ' L' : '—'}</b></div>
      <div class="kv"><span>${t('n_budget')}</span><b>${f.weeklyWaterBudgetL != null ? num(f.weeklyWaterBudgetL, 0) + ' L' : '—'}</b></div></div>` : '';

  const zFirst = lang === 'zu';
  return html`<a class="back desk-only" href="#/suggestions">${icon('back', 16)}${t('nav_suggestions')}</a>
    <div class="rhead" style="${bg(headPhoto)}">
      <div class="row sp"><a class="circ mob-only" href="#/suggestions" aria-label="${t('nav_suggestions')}" style="color:var(--ink)">${icon('back', 20)}</a><span></span></div>
      <div><h1>${title}</h1><div class="sub"><span>${shortName(plot?.plotName)}</span><span>·</span><span>${fmtDay(s.createdAt)}, ${fmtHM(s.createdAt)}</span><span class="tag-ex on-photo">${t('example_data')}</span></div></div>
    </div>
    <div class="stepper-slot" style="max-width:560px">${stepper(s)}</div>
    <div class="reviewgrid">
      <div class="col-l">
        <div class="card rv-a">
          <div class="desk-only sugphoto" style="${bg(photoUrl(plot?.crop))}"></div>
          <div class="row sp"><span class="lbl">${t('sug_written_by_ai')}</span><span class="reqid">${s.requestId || ''}</span></div>
          <div class="sugtitle">${sugTitle(s, plot)}</div>
          ${zFirst ? zuBlock(z) : ''}
          <p class="sm" style="${zFirst && z.lines.length ? 'margin-top:12px' : ''}">${reasonText(s, plot, f)}</p>
          ${zFirst ? '' : zuBlock(z)}
          ${String(s.provider || '').includes('fallback') ? html`<div class="note">${icon('shield', 14)}<span>${t('fb_note')}</span></div>` : ''}
        </div>
        <div class="rv-c">${nums}</div>
      </div>
      <div class="col-r">
        <div class="rv-b">
          ${statusBanner}
          <div class="card">
            <div class="row sp"><span class="lbl">${t('rule_check')}</span>${verdictLine}</div>
            ${banners}
            <div>${rows.map(ruleHtml)}</div>
            <div class="row sp xs mut" style="margin-top:8px"><span>${t('verdict_word')} ${s.verdict || ''} · ${s.requestId || ''}</span><span>${t('numbers_from_oe')}</span></div>
            ${rejected ? html`<div class="xs mut" style="margin-top:6px">${t('other_rules_passed', { n: passedN })}</div>` : ''}
          </div>
        </div>
        <div class="rv-d">${decision}</div>
      </div>
    </div>
    <div class="mobspace"></div>${bar}`;
}

export function langToggle(onPhoto = false) {
  const l = getLang();
  return html`<div class="lang ${onPhoto ? 'on-photo' : ''}" role="group" aria-label="Language"><button data-act="lang" data-lang="zu" aria-pressed="${String(l === 'zu')}">ZU</button><button data-act="lang" data-lang="en" aria-pressed="${String(l === 'en')}">EN</button></div>`;
}

export function confirmSheet({ summary, secs, id }) {
  return html`<div class="scrim" data-act="sheet-bg" role="presentation"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-h">
    <div class="grab"></div>
    <h2 id="sheet-h">${t('confirm_title')}</h2>
    ${getLang() === 'zu' ? '' : html`<p class="sm mut" lang="zu" style="margin-top:2px">Qinisekisa isinqumo sakho.</p>`}
    <div class="card" style="margin:14px 0;background:#F3F6F0;box-shadow:none"><div class="lbl">${t('approve')}</div><div class="sugtitle" style="font-size:18px;margin:4px 0 0">${summary}</div></div>
    <p class="sm mut">${t('confirm_hint')}</p>
    <p class="sm" style="margin:8px 0 14px">${t('confirm_expires')} <span class="timer" id="timer">${fmtSecs(secs)}</span></p>
    <div class="decide"><button class="btn out" data-act="sheet-cancel">${t('confirm_cancel')}</button><button class="btn lime" id="confirm-go" data-act="confirm" data-id="${id}">${icon('check', 16)}${t('confirm_go')}</button></div>
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
  const chip = e.event === 'rule_check' ? (/rejected_by_rules/.test(String(d)) ? html`<span class="chip sm2 red">${t('chip_rejected')}</span>` : html`<span class="chip sm2 ok">${icon('check', 12)}${t('passed_rules')}</span>`)
    : e.event === 'suggestion_approved' ? html`<span class="chip sm2 dark">${t('st_approved')}</span>` : e.event === 'suggestion_declined' ? html`<span class="chip sm2 grey">${t('st_declined')}</span>` : '';
  return html`<div class="aud"><div class="when">${fmtTime(e.at)}<br>${fmtShortDay(e.at)}</div><div class="grow">
    <div class="row g8 wrap"><span class="ev">${name}</span>${chip}</div>
    <div class="sm mut">${e.actor}${summary ? ' · ' : ''}${summary}${sid ? html` · <a href="#/suggestions/${sid}" class="b" style="color:var(--f7)">#${sid}</a>` : ''}</div>
    <div class="reqid">${t('audit_request')} ${e.requestId || '—'}</div>
    <details><summary>${t('audit_show')}</summary><pre>${JSON.stringify({ auditId: e.auditId, at: e.at, requestId: e.requestId, actor: e.actor, event: e.event, detail: d }, null, 2)}</pre></details></div></div>`;
}
