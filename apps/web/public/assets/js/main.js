// Router, data loading and actions. No framework, no build step.
import { html, raw, $, $$, icon, num, shortName, fmtDayLong, fmtDayNoYear, fmtHM, photoUrl, photoStyle, ageMinutes } from './util.js';
import { t, getLang, setLang, zuHello } from './i18n.js';
import { api, demo, facts as apiFacts, loadSession, getSession, setToken, needsToken, FRESH_MINUTES } from './api.js';
import { plotCardD, plotCardM, plotState, lineChart, readingsTable, sugRow, sugTitle, reviewView, confirmSheet, fmtSecs, langToggle, auditRow, bg, metricsBlock, lvl } from './views.js';

const viewEl = $('#view'), overlay = $('#overlay'), toastRoot = $('#toast-root');
const state = { plots: [], plotsAt: 0, selPlot: null, sugFilter: 'all', auditFilter: 'decisions', pending: null, live: null, nav: 0, timer: null, sheetTimer: null, readings: {}, cur: null, sugs: { at: 0, list: [] } };
const draw = (el, h) => { el.innerHTML = String(h); if (el === viewEl) document.body.classList.toggle('has-actbar', !!$('.actbar', el)); };

// ---------- helpers ----------
class ApiErr extends Error { constructor(r) { super(r.body?.message || 'Request failed'); this.status = r.status; this.code = r.body?.error || 'ERROR'; this.body = r.body; } }
const need = (r) => { if (r.status >= 400) throw new ApiErr(r); return r.body; };
async function pool(tasks, n = 3) { // gentle on PASOE (development licence: 5 concurrent requests)
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => { while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); } }));
  return out;
}
async function getPlots(force = false) {
  if (!force && state.plots.length && Date.now() - state.plotsAt < 60000) return state.plots;
  state.plots = need(await api('GET', '/plots')).plots || []; state.plotsAt = Date.now();
  return state.plots;
}
const getReadings = async (id, limit = 20) => { const r = need(await api('GET', `/plots/${id}/readings?limit=${limit}`)).readings || []; state.readings[id] = r; return r; };
const plotById = (id) => state.plots.find((p) => p.plotId === Number(id));
const errText = (e) => (e && e.network ? t('err_offline') : t('e_' + (e.code || '')) !== 'e_' + (e.code || '') ? t('e_' + e.code) : e.message || t('err_load'));
const cacheKey = (id) => `mf.sug.${id}`;
const readCache = (id) => { try { return JSON.parse(sessionStorage.getItem(cacheKey(id)) || 'null'); } catch { return null; } };
const writeCache = (id, v) => { try { sessionStorage.setItem(cacheKey(id), JSON.stringify(v)); } catch { /* ignore */ } };

function toast(msg, err = false) {
  const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.textContent = msg;
  toastRoot.replaceChildren(el); setTimeout(() => { if (el.parentNode) el.remove(); }, err ? 6000 : 3500);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.html = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${label ? ' ' + label : ''}`; }
  else { btn.disabled = false; if (btn.dataset.html) btn.innerHTML = btn.dataset.html; }
}

// ---------- chrome ----------
const NAV = [['dashboard', '/', 'grid', 'nav_dashboard'], ['plots', '/plots', 'plots', 'nav_plots'], ['suggestions', '/suggestions', 'list', 'nav_suggestions'], ['audit', '/audit', 'book', 'nav_audit'], ['settings', '/settings', 'gear', 'nav_settings']];
function renderChrome(active, plain = true) {
  const s = getSession() || {};
  document.body.classList.toggle('plain', plain);
  const badge = state.pending ? html`<span class="badge">${state.pending}</span>` : '';
  draw($('#sidenav'), html`${NAV.map(([k, h, ic, lbl]) => html`<a href="#${h}" class="${k === active ? 'on' : ''}" ${k === active ? raw('aria-current="page"') : ''}>${icon(ic, 18)}<span>${t(lbl)}</span>${k === 'suggestions' ? badge : ''}</a>`)}`);
  const TAB = [['dashboard', '/', 'home', 'nav_home'], ['plots', '/plots', 'plots', 'nav_plots'], ['suggestions', '/suggestions', 'list', 'nav_suggestions'], ['audit', '/audit', 'book', 'nav_audit'], ['settings', '/settings', 'dots', 'nav_more']];
  draw($('#tabbar'), html`${TAB.map(([k, h, ic, lbl]) => html`<a href="#${h}" class="${k === active ? 'on' : ''}" aria-label="${t(lbl)}" ${k === active ? raw('aria-current="page"') : ''}>${icon(ic, 20)}<span class="tl">${t(lbl)}</span>${k === 'suggestions' ? badge : ''}</a>`)}`);
  const mock = s.oeMode === 'mock';
  draw($('#top'), html`<div class="brand">${icon('leaf', 22)}MZANSI FARMER</div>
    <div class="search d-only" role="search"><label>${icon('search', 18)}<input id="q" type="search" placeholder="${t('search_ph')}" aria-label="${t('search_ph')}" autocomplete="off"></label><div class="sresults" id="sres" hidden></div></div>
    <div class="tright">
      ${state.live !== null ? html`<span class="chip d-only"><span class="dot ${state.live ? '' : 'grey'}"></span>${state.live ? t('chip_esp_live') : t('chip_esp_none')}</span>` : ''}
      <span class="chip d-only"><span class="dot ${mock ? 'amber' : ''}"></span>${mock ? t('chip_oe_mock') : t('chip_oe')}</span>
      <span class="tag-ex d d-only">${t('example_data')}</span>
      ${langToggle()}
      <a class="circ bell d-only" href="#/suggestions" data-act="bell" aria-label="${t('bell')}">${icon('bell', 18)}${state.pending ? html`<span class="pip">${state.pending}</span>` : ''}</a>
      <div class="row g8 who"><div class="avatar" style="${bg('/assets/photos/avatar-nomsa.jpg')}" role="img" aria-label="Nomsa"></div><div class="d-only"><div class="nm">Nomsa Dlamini</div><div class="rl">${t('farmer_role')}</div></div></div></div>`);
  draw($('#farmer-card'), html`<div class="img" style="${bg('/assets/photos/farmer-inspecting-crops.jpg')}" role="img" aria-label=""></div><div class="txt"><b>${t('live_every_side')}</b><span>${t('dash_no_live_sub')}</span></div>`);
  draw($('#logout'), html`${icon('logout', 18)}<span>${t('log_out')}</span>`);
}

// ---------- search (top bar, desktop) ----------
async function searchSuggestions() {
  if (Date.now() - state.sugs.at < 20000) return state.sugs.list;
  try { state.sugs = { at: Date.now(), list: need(await api('GET', '/suggestions')).suggestions || [] }; } catch { /* keep the old list */ }
  return state.sugs.list;
}
async function runSearch(q) {
  const box = $('#sres'); if (!box) return;
  const term = q.trim().toLowerCase();
  if (!term) { box.hidden = true; return; }
  const [plots, sugs] = await Promise.all([getPlots().catch(() => []), searchSuggestions()]);
  const pm = plots.filter((p) => `${p.plotName} ${p.crop}`.toLowerCase().includes(term)).slice(0, 5);
  const sm = sugs.filter((s) => { const p = plots.find((x) => x.plotId === s.plotId); return `${sugTitle(s, p)} ${s.status} ${(s.rejectReasons || []).map((r) => r.code).join(' ')} #${s.suggestionId}`.toLowerCase().includes(term); }).slice(0, 5);
  draw(box, html`${pm.length ? html`<div class="sh lbl">${t('search_plots')}</div>${pm.map((p) => html`<a href="#/plots/${p.plotId}"><span class="ph photo" style="${photoStyle(p.crop)}"></span>${shortName(p.plotName)}</a>`)}` : ''}
    ${sm.length ? html`<div class="sh lbl">${t('search_sugs')}</div>${sm.map((s) => html`<a href="#/suggestions/${s.suggestionId}"><span class="ph photo" style="${photoStyle(plots.find((x) => x.plotId === s.plotId)?.crop)}"></span>${sugTitle(s, plots.find((x) => x.plotId === s.plotId))}</a>`)}` : ''}
    ${pm.length + sm.length ? '' : html`<div class="none">${t('search_none')}</div>`}`);
  box.hidden = false;
}

// ---------- pages ----------
const skeleton = () => draw(viewEl, html`<div class="pg" style="display:grid;gap:12px;padding-top:16px"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`);

async function loadDashboardData() {
  const plots = await getPlots(true);
  const [pend, rej] = await Promise.all([api('GET', '/suggestions?status=pending_approval'), api('GET', '/suggestions?status=rejected')]);
  const readings = await pool(plots.map((p) => () => getReadings(p.plotId, 20)), 3);
  return { plots, readings, pend: need(pend).suggestions || [], rej: need(rej).suggestions || [] };
}
function drawDashboard(d) {
  const now = Date.now();
  const states = d.plots.map((p, i) => plotState(p, d.readings[i], now));
  const live = states.filter((s) => s.fresh).length, dry = states.filter((s) => s.fresh && s.dry).length;
  state.live = live; state.livePlots = Object.fromEntries(states.map((x, i) => [d.plots[i].plotId, x.fresh])); state.pending = d.pend.length;
  // the main screen shows three plots, like the approved screens: live ones first, dry ones first among those; every plot is reachable from "All plots"
  const order = d.plots.map((_, i) => i).sort((a, b) => (states[b].fresh - states[a].fresh) || (states[b].dry - states[a].dry) || (a - b));
  const shown = order.slice(0, 3);
  const ci = shown.find((i) => states[i].fresh && states[i].dry) ?? shown[0] ?? 0;
  const sp = d.plots[ci], sr = d.readings[ci] || [];
  state.selPlot = sp?.plotId ?? null;
  const byNew = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const waiting = [...[...d.pend].sort(byNew), ...[...d.rej].sort(byNew).slice(0, 3)].slice(0, 4);   // waiting first, then recent rule rejections
  const nowIso = new Date().toISOString();
  const title = live === 0 ? t('dash_no_live') : t(live === 1 ? 'dash_title_1' : 'dash_title', { dry, live });
  const more = d.plots.length > 3;
  const askIdx = states.findIndex((s) => s.fresh && s.dry), askPlot = d.plots[askIdx >= 0 ? askIdx : (shown[0] ?? 0)];
  renderChrome('dashboard', false);
  draw(viewEl, html`
    <section class="mhero m-only" style="${bg('/assets/photos/field-header-maize.jpg')}">
      <div class="mh-top"><div class="loc">${icon('pin', 18)}<span>${t('location')}</span></div>${langToggle(true)}<div class="avatar" style="${bg('/assets/photos/avatar-nomsa.jpg')}" role="img" aria-label="Nomsa"></div></div>
      <div class="mh-body"><div class="hello">${zuHello('Nomsa')} · ${fmtDayNoYear(nowIso)}, ${fmtHM(nowIso)}</div>
        ${live === 0 ? html`<div class="big txt"><div class="n">${title}</div></div>` : html`<div class="big"><div class="n">${t('dash_num', { dry, live })}</div><div class="r">${t(live === 1 ? 'dash_rest_1' : 'dash_rest')}</div></div>`}
        <div class="chips"><span class="chip photo"><span class="dot" style="background:#7CE27C"></span>${t('live_every')}</span><span class="chip photo">${live === 0 ? t('chip_esp_none') : t(live === 1 ? 'sensor_online_1' : 'sensors_online', { n: live })}</span><span class="tag-ex m">${t('example_data')}</span></div></div>
    </section>
    <section class="msheet m-only">
      <div class="mh"><h2>${t('your_plots')}</h2><a href="#/plots">${t('all_plots')}${icon('chev', 14)}</a></div>
      <div class="mcards">${shown.map((i) => plotCardM(d.plots[i], d.readings[i]))}</div>
      ${more ? html`<div class="viewall"><a class="btn out sm" href="#/plots">${t('all_n_plots', { n: d.plots.length })}</a></div>` : ''}
      <p class="credit">${t('credits')}</p>
    </section>
    <div class="d-only">
      <div class="dhead"><div><div class="dh">${title}</div><div class="xs mut" style="margin-top:2px">${zuHello('Nomsa')} · ${fmtDayLong(nowIso)}, ${fmtHM(nowIso)}</div></div>${more ? html`<a class="toall" href="#/plots">${t('all_n_plots', { n: d.plots.length })}${icon('chev', 14)}</a>` : ''}</div>
      <div class="cards3">${shown.map((i) => plotCardD(d.plots[i], d.readings[i]))}</div>
      <div class="row2">
        <div class="card chartcard">
          <div class="row sp"><div><a class="dtitle" href="#/plots/${sp?.plotId}">${t('chart_title', { plot: shortName(sp?.plotName) })}</a>
            <div class="row g8" style="margin-top:2px"><span class="pj" style="font-size:30px;font-weight:700">${num(sr[0]?.soilMoisturePct)}<span style="font-size:16px">%</span></span><span class="xs mut">${t('chart_sub', { n: sr.length })}</span></div></div><span class="chip sm2">${t('live_30')}</span></div>
          ${sp ? lineChart(sr, sp.dryThresholdPct) : ''}
          ${readingsTable(sr, 5, true)}
        </div>
        <div class="card waitcard"><div class="wh"><div class="dh">${t('waiting_for_you')}</div><span class="xs mut">${waiting.length === 1 ? t('n_sug_1') : t('n_sug', { n: waiting.length })}</span></div>
          ${waiting.length ? html`<div>${waiting.map((x) => sugRow(x, d.plots.find((p) => p.plotId === x.plotId)))}</div>` : html`<p class="empty">${t('nothing_waiting')}</p>${askPlot ? html`<button class="btn dk sm" data-act="ask" data-plot="${askPlot.plotId}">${icon('spark', 15)}${t('ask_plot', { plot: shortName(askPlot.plotName) })}</button>` : ''}`}
          <div class="note">${icon('shield', 16)}<span>${t('ai_note_foot')}</span></div></div>
      </div>
      <p class="credit">${t('credits')}</p>
    </div>`);
  dashData = d;
}
let dashData = null;
async function dashboardPage(alive, silent) {
  if (!silent) { skeleton(); renderChrome('dashboard', false); }
  const d = await loadDashboardData();
  if (!alive()) return;
  drawDashboard(d);
  state.timer = setInterval(() => { if (!document.hidden && alive() && !overlay.firstChild) loadDashboardData().then((x) => alive() && drawDashboard(x)).catch(() => {}); }, 30000);
}

async function plotsPage(alive) {
  skeleton(); renderChrome('plots');
  const plots = await getPlots(true);
  const readings = await pool(plots.map((p) => () => getReadings(p.plotId, 20)), 3);
  if (!alive()) return;
  state.livePlots = Object.fromEntries(plots.map((p, i) => [p.plotId, plotState(p, readings[i]).fresh])); state.live = Object.values(state.livePlots).filter(Boolean).length; renderChrome('plots');
  draw(viewEl, html`<div class="pg"><div class="pagehead"><div><h1>${t('plots_title')}</h1><div class="sub">${t('ai_note_foot')}</div></div></div>
    <div class="plotsgrid d-only">${plots.map((p, i) => plotCardD(p, readings[i], { limits: true }))}</div>
    <div class="mcards m-only">${plots.map((p, i) => plotCardM(p, readings[i], { limits: true }))}</div></div>`);
}

const PRESETS = { dry: { soil: 18.5, temp: 29.4, hum: 41, rain: false }, wet: { soil: 62, temp: 24.2, hum: 70, rain: false }, rain: { soil: 55, temp: 20.1, hum: 92, rain: true } };
function drawPlotLive(plot, readings) {
  const s = plotState(plot, readings);
  { const lp = (state.livePlots ||= {}); const was = state.live; lp[plot.plotId] = s.fresh; const n = Object.values(lp).filter(Boolean).length; if (was !== null || n) { state.live = Math.max(n, 0); if ((was === 0) !== (n === 0) || was === null) renderChrome('plots'); } }
  draw($('#plot-live'), html`<div class="card"><div class="row sp wrap g8"><div><div class="lbl">${t('chart_title', { plot: shortName(plot.plotName) })}</div><div class="xs mut">${t('chart_sub', { n: readings.length })}</div></div>${s.latest ? html`<span class="chip">${s.fresh ? t('live_every') : t('sensor_offline')}</span>` : ''}</div>
      <div style="margin:10px 0">${metricsBlock(plot, s)}</div>${lineChart(readings, plot.dryThresholdPct)}</div>
    <div class="card" style="margin-top:12px"><div class="lbl" style="margin-bottom:6px">${t('history')}</div>${readingsTable(readings, 20)}</div>`);
}
async function plotPage(id, alive) {
  skeleton(); renderChrome('plots');
  const plots = await getPlots();
  const plot = plots.find((p) => p.plotId === id);
  if (!plot) { draw(viewEl, html`<div class="errbox">Plot ${id} not found. <a href="#/plots" class="b">${t('nav_plots')}</a></div>`); return; }
  const readings = await getReadings(id, 20);
  if (!alive()) return;
  const sess = getSession() || {}, dm = sess.demo;
  const canSim = !!dm && dm.simulateReadingPlots.includes(id);
  const P = PRESETS.dry;
  draw(viewEl, html`<div class="pg"><a class="back" href="#/plots">${icon('back', 16)}${t('nav_plots')}</a>
    <div class="phead" style="${bg(photoUrl(plot.crop))}"><div class="row sp"><span></span><span class="tag-ex on-photo">${t('example_data')}</span></div>
      <div><h1>${shortName(plot.plotName)}</h1><div class="sub"><span>${plot.crop} · ${t('plot_area', { ha: plot.areaHa })}</span></div><div class="sub" style="margin-top:4px">${t('plot_limits', { t: plot.dryThresholdPct, max: plot.maxIrrigationLitres, b: plot.weeklyWaterBudgetL })}</div></div></div>
    <div class="row g8 wrap" style="margin:12px 0"><button class="btn dk" data-act="ask" data-plot="${id}">${icon('spark', 16)}${t('ask_ai')}</button></div>
    <div class="two"><div id="plot-live"></div>
      <div class="col g12">${canSim ? html`<form class="card demo" id="sim-form" data-plot="${id}" novalidate>
          <div class="lbl">${icon('sensor', 14)}${t('demo_tools')} · ${t('sim_title')}</div><p class="xs mut" style="margin:4px 0 10px">${t('sim_hint')} ${t('demo_only_local')}</p>
          <div class="form">
            <div class="presets"><button type="button" data-act="preset" data-preset="dry">${t('sim_dry')}</button><button type="button" data-act="preset" data-preset="wet">${t('sim_wet')}</button><button type="button" data-act="preset" data-preset="rain">${t('sim_rainy')}</button></div>
            <div class="field"><label for="f-soil">${t('sim_soil')}</label><input id="f-soil" name="soil" type="number" step="0.1" min="0" max="100" inputmode="decimal" value="${P.soil}"></div>
            <div class="field"><label for="f-temp">${t('sim_temp')}</label><input id="f-temp" name="temp" type="number" step="0.1" min="-20" max="60" inputmode="decimal" value="${P.temp}"></div>
            <div class="field"><label for="f-hum">${t('sim_hum')}</label><input id="f-hum" name="hum" type="number" step="1" min="0" max="100" inputmode="decimal" value="${P.hum}"></div>
            <label class="check"><input id="f-rain" name="rain" type="checkbox">${t('sim_rain')}</label>
            <button class="btn lime full" type="submit">${icon('send', 16)}${t('sim_send')}</button>
          </div></form>` : dm ? html`<div class="card demo"><div class="lbl">${icon('sensor', 14)}${t('demo_tools')}</div><p class="sm mut" style="margin-top:6px">${t('sim_none')}</p></div>` : ''}
        ${dm?.aiBehaviour ? html`<div class="card demo"><div class="lbl">${icon('spark', 14)}${t('demo_tools')} · ${t('ai_mode_title')}</div>
          <div class="seg" style="margin:10px 0 6px" role="group"><button data-act="ai-mode" data-mode="normal" aria-pressed="${String(dm.aiBehaviour.current === 'normal')}">${t('ai_normal')}</button><button data-act="ai-mode" data-mode="greedy" aria-pressed="${String(dm.aiBehaviour.current === 'greedy')}">${t('ai_greedy')}</button></div>
          <p class="xs mut">${t('ai_greedy_hint')}</p></div>` : ''}
      </div></div></div>`);
  drawPlotLive(plot, readings);
  state.timer = setInterval(async () => { if (document.hidden || !alive()) return; try { drawPlotLive(plot, await getReadings(id, 20)); } catch { /* keep the old data */ } }, 30000);
}

async function suggestionsPage(alive) {
  skeleton(); renderChrome('suggestions');
  const [plots, r] = await Promise.all([getPlots(), api('GET', '/suggestions')]);
  const list = (need(r).suggestions || []).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (!alive()) return;
  state.pending = list.filter((s) => s.status === 'pending_approval').length; renderChrome('suggestions');
  const F = { all: () => true, waiting: (s) => s.status === 'pending_approval', approved: (s) => s.status === 'approved', rejected: (s) => s.status === 'rejected', declined: (s) => s.status === 'declined' };
  const shown = list.filter(F[state.sugFilter] || F.all);
  draw(viewEl, html`<div class="pg"><div class="pagehead"><div><h1>${t('suggestions_title')}</h1><div class="sub">${t('ai_note_foot')}</div></div></div>
    <div class="chipsel" role="group" style="margin-bottom:12px">${Object.keys(F).map((k) => html`<button data-act="sug-filter" data-f="${k}" aria-pressed="${String(state.sugFilter === k)}">${t('filter_' + k)} (${list.filter(F[k]).length})</button>`)}</div>
    <div class="card pad">${shown.length ? shown.map((s) => sugRow(s, plots.find((p) => p.plotId === s.plotId), { when: true })) : html`<p class="empty">${t('nothing_waiting')}</p>`}</div></div>`);
}

function localFacts(plot, readings) {
  const l = readings[0];
  return { dryThresholdPct: plot.dryThresholdPct, maxIrrigationLitres: plot.maxIrrigationLitres, weeklyWaterBudgetL: plot.weeklyWaterBudgetL, staleLimitMinutes: FRESH_MINUTES,
    soilMoisturePct: l?.soilMoisturePct ?? null, raining: !!l?.raining, readingAgeMinutes: l ? ageMinutes(l.readAt) : null, usedLast7DaysL: null };
}
async function reviewPage(id, alive) {
  skeleton(); renderChrome('suggestions', false);
  const r = await api('GET', `/suggestions/${id}`);
  if (r.status === 404) { renderChrome('suggestions'); draw(viewEl, html`<div class="errbox">Suggestion ${id} not found. <a href="#/suggestions" class="b">${t('nav_suggestions')}</a></div>`); return; }
  const s = need(r);
  const plots = await getPlots();
  const plot = plots.find((p) => p.plotId === s.plotId);
  const cached = readCache(id);
  let f = null, asOf = 'then';
  if (cached?.facts && (s.status === 'pending_approval' || s.status === 'rejected')) f = cached.facts;
  else { asOf = 'now'; f = await apiFacts(s.plotId).catch(() => null); if (!f) f = localFacts(plot, await getReadings(s.plotId, 1).catch(() => [])); }
  if (!alive()) return;
  state.cur = { s, plot };
  renderChrome('suggestions', false);
  draw(viewEl, reviewView(s, plot, f, { factsAsOf: asOf }));
  window.scrollTo(0, 0);
}

async function auditPage(alive) {
  skeleton(); renderChrome('audit');
  const events = need(await api('GET', '/audit?limit=200')).events || [];
  if (!alive()) return;
  const F = { decisions: (e) => e.event !== 'tool_call', all: () => true, calls: (e) => e.event === 'tool_call' };
  const shown = events.filter(F[state.auditFilter] || F.all).slice(0, 60);
  draw(viewEl, html`<div class="pg"><div class="pagehead"><div><h1>${t('audit_title')}</h1><div class="sub">${t('audit_sub')}</div></div></div>
    <div class="chipsel" role="group" style="margin-bottom:12px">${['decisions', 'all', 'calls'].map((k) => html`<button data-act="audit-filter" data-f="${k}" aria-pressed="${String(state.auditFilter === k)}">${t('audit_f_' + k)} (${events.filter(F[k]).length})</button>`)}</div>
    <div class="card pad">${shown.length ? shown.map(auditRow) : html`<p class="empty">${t('audit_none')}</p>`}</div></div>`);
}

function settingsPage() {
  renderChrome('settings');
  const s = getSession() || {};
  draw(viewEl, html`<div class="pg"><div class="pagehead"><div><h1>${t('settings_title')}</h1><div class="sub">${t('settings_sub')}</div></div></div>
    <div class="two">
      <div class="card pad"><div class="lbl" style="margin-bottom:8px">${t('set_lang')}</div>${langToggle()}<p class="xs mut" style="margin-top:10px">${t('set_lang_hint')}</p></div>
      <div class="card pad"><div class="lbl" style="margin-bottom:6px">${t('set_data')}</div>
        <div class="kv"><span>${t('set_oe')}</span><b>${s.oeMode === 'mock' ? t('set_oe_mock') : t('set_oe_real')}</b></div>
        <div class="kv"><span>${t('set_ai')}</span><b>${s.aiProvider === 'mock' ? t('set_ai_mock') : t('set_ai_real')}</b></div>
        <div class="kv"><span>${t('set_session')}</span><b style="text-align:right;max-width:60%">${s.mode === 'token' ? t('set_session_token') : t('set_session_proxy')}</b></div></div>
    </div></div>`);
}

function loginPage(msg = '') {
  renderChrome('');
  draw(viewEl, html`<form class="card login" id="login" novalidate><h2>${t('login_title')}</h2><p class="sm mut" style="margin:6px 0 12px">${t('login_hint')}</p>
    <div class="field"><label for="tok">APP_TOKEN</label><input id="tok" type="password" autocomplete="off"></div>
    ${msg ? html`<p class="sm" style="color:#8c2a18;margin-top:8px" role="alert">${msg}</p>` : ''}
    <button class="btn dk block" style="margin-top:12px" type="submit">${t('login_btn')}</button></form>`);
}

// ---------- router ----------
async function route() {
  clearInterval(state.timer);
  const me = ++state.nav, alive = () => me === state.nav;
  const [, a, b] = (location.hash.replace(/^#/, '') || '/').split('/');
  closeSheet();
  try {
    if (needsToken()) return loginPage();
    if (!a) await dashboardPage(alive);
    else if (a === 'plots') await (b ? plotPage(Number(b), alive) : plotsPage(alive));
    else if (a === 'suggestions') await (b ? reviewPage(Number(b), alive) : suggestionsPage(alive));
    else if (a === 'audit') await auditPage(alive);
    else if (a === 'settings') settingsPage();
    else { location.hash = '#/'; }
  } catch (e) {
    if (!alive()) return;
    if (e.status === 401 && getSession()?.mode === 'token') { setToken(''); return loginPage(t('login_bad')); }
    renderChrome(a || 'dashboard');
    draw(viewEl, html`<div class="errbox" role="alert"><b>${t('err_load')}</b><br>${errText(e)}${e.body?.requestId ? html`<br><span class="reqid">${e.body.requestId}</span>` : ''}<div style="margin-top:10px"><button class="btn dk sm" data-act="retry">${t('err_retry')}</button></div></div>`);
  }
}

// ---------- actions ----------
function closeSheet() { clearInterval(state.sheetTimer); overlay.replaceChildren(); }
const visible = (el) => el.getClientRects().length > 0;
function openSheet({ summary, token, secs, id }) {
  const cur = state.cur && state.cur.s.suggestionId === id ? state.cur : null;
  draw(overlay, confirmSheet({ summary, secs, id, crop: cur?.plot?.crop, reqId: cur?.s.requestId }));
  const goBtns = $$('[data-act=confirm]', overlay); goBtns.forEach((b) => { b.dataset.token = token; });
  (goBtns.find(visible) || goBtns[0]).focus();
  let left = secs;
  state.sheetTimer = setInterval(() => {
    left -= 1;
    $$('[data-timer]', overlay).forEach((el) => { el.textContent = fmtSecs(Math.max(0, left)); });
    const bar = $('[data-bar]', overlay); if (bar) bar.style.width = `${Math.max(0, left) / secs * 100}%`;
    if (left <= 0) { clearInterval(state.sheetTimer); goBtns.forEach((b) => { b.disabled = true; }); toast(t('confirm_expired'), true); }
  }, 1000);
}

async function ask(plotId, btn) {
  busy(btn, true, t('asking_ai'));
  try {
    const r = await api('POST', `/plots/${plotId}/advise`, { lang: getLang() });
    if (r.status !== 200) { toast(r.body?.message || t('err_load'), true); return; }
    writeCache(r.body.suggestionId, { facts: r.body.facts, lang: getLang(), ai: r.body.ai });
    location.hash = `#/suggestions/${r.body.suggestionId}`;
  } catch (e) { toast(errText(e), true); }
  finally { busy(btn, false); }
}
async function approve(id, btn) {
  busy(btn, true);
  try {
    const r = await api('POST', `/suggestions/${id}/approve`, {});
    if (r.status === 202) { openSheet({ summary: r.body.summary, token: r.body.confirmToken, secs: r.body.expiresInSeconds || 120, id }); }
    else { toast(errText({ code: r.body.error, message: r.body.message }), true); await route(); }
  } catch (e) { toast(errText(e), true); }
  finally { busy(btn, false); }
}
async function confirm(id, token, btn) {
  busy(btn, true, '');
  try {
    const r = await api('POST', `/suggestions/${id}/approve`, { confirmToken: token });
    closeSheet();
    if (r.status === 200) toast(t('approved_banner')); else toast(errText({ code: r.body.error, message: r.body.message }), true);
    await route();
  } catch (e) { closeSheet(); toast(errText(e), true); }
}
async function decline(id, btn) {
  busy(btn, true);
  try {
    const r = await api('POST', `/suggestions/${id}/reject`, {});
    if (r.status === 200) toast(t('declined_banner')); else toast(errText({ code: r.body.error, message: r.body.message }), true);
    await route();
  } catch (e) { toast(errText(e), true); busy(btn, false); }
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  if (a === 'sheet-bg') { if (ev.target === el) closeSheet(); return; }
  if (a === 'sheet-cancel') return closeSheet();
  if (a === 'lang') { setLang(el.dataset.lang); return route(); }
  if (a === 'ask') return ask(Number(el.dataset.plot), el);
  if (a === 'approve') return approve(Number(el.dataset.id), el);
  if (a === 'confirm') return confirm(Number(el.dataset.id), el.dataset.token, el);
  if (a === 'decline') return decline(Number(el.dataset.id), el);
  if (a === 'dismiss') { location.hash = '#/'; return; }
  if (a === 'retry') return route();
  if (a === 'logout') { setToken(''); try { sessionStorage.clear(); } catch { /* ignore */ } toast(t('set_signed_out')); if (getSession()?.mode === 'token') return route(); location.hash = '#/'; return; }
  if (a === 'bell') { state.sugFilter = 'waiting'; return; }
  if (a === 'sug-filter') { state.sugFilter = el.dataset.f; return route(); }
  if (a === 'audit-filter') { state.auditFilter = el.dataset.f; return route(); }
  if (a === 'preset') { const p = PRESETS[el.dataset.preset]; $('#f-soil').value = p.soil; $('#f-temp').value = p.temp; $('#f-hum').value = p.hum; $('#f-rain').checked = p.rain; return; }
  if (a === 'ai-mode') {
    const r = await demo('demo/ai-behaviour', { behaviour: el.dataset.mode });
    if (r.status === 200) { getSession().demo.aiBehaviour.current = r.body.behaviour; $$('[data-act=ai-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === r.body.behaviour))); toast(t(r.body.behaviour === 'greedy' ? 'ai_greedy' : 'ai_normal')); }
    else toast(r.body.message || t('err_load'), true);
  }
});
document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (ev.target.id === 'login') {
    setToken($('#tok').value.trim());
    return route();
  }
  if (ev.target.id === 'sim-form') {
    const f = ev.target, plotId = Number(f.dataset.plot), btn = $('button[type=submit]', f);
    const val = (n) => (f[n].value === '' ? undefined : Number(f[n].value));
    busy(btn, true);
    try {
      const r = await demo('demo/reading', { plotId, soilMoisturePct: val('soil'), temperatureC: val('temp'), humidityPct: val('hum'), raining: f.rain.checked });
      if (r.status === 201) { toast(t('sim_ok', { id: r.body.id })); const plot = plotById(plotId); drawPlotLive(plot, await getReadings(plotId, 20)); }
      else toast(r.body.message || t('err_load'), true);
    } catch (e) { toast(errText(e), true); }
    finally { busy(btn, false); }
  }
});
document.addEventListener('keydown', (ev) => {
  if (!overlay.firstChild) return;
  if (ev.key === 'Escape') return closeSheet();
  if (ev.key === 'Tab') { const b = $$('button:not(:disabled)', overlay).filter(visible); if (!b.length) return; const i = b.indexOf(document.activeElement); const n = ev.shiftKey ? (i <= 0 ? b.length - 1 : i - 1) : (i + 1) % b.length; b[n].focus(); ev.preventDefault(); }
});
document.addEventListener('input', (ev) => { if (ev.target.id === 'q') runSearch(ev.target.value); });
document.addEventListener('focusin', (ev) => { if (ev.target.id === 'q' && ev.target.value) runSearch(ev.target.value); });
document.addEventListener('keydown', (ev) => {
  if (ev.target.id !== 'q') return;
  const box = $('#sres');
  if (ev.key === 'Escape') { box.hidden = true; ev.target.blur(); }
  if (ev.key === 'Enter') { const first = $('a', box); if (first && !box.hidden) { location.hash = first.getAttribute('href'); box.hidden = true; ev.target.value = ''; ev.target.blur(); } }
});
document.addEventListener('click', (ev) => { const box = $('#sres'); if (box && !ev.target.closest('.search')) box.hidden = true; else if (box && ev.target.closest('#sres a')) { box.hidden = true; const q = $('#q'); if (q) q.value = ''; } });
window.addEventListener('hashchange', route);
await loadSession();
route();
