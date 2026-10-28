// Live field sensors. The browser reads the ESP32 (GET /data, /history, /calibrate).
// The server cannot reach the board. See docs/ESP32.md.
import { html, icon } from './util.js';
import { t } from './i18n.js';
import { getSession } from './api.js';
import {
  ESP32_DASHBOARD_URL_DEFAULT, ESP32_HISTORY_POINTS, ESP32_POLL_MS,
  clearEsp32UrlOverride, displayPct, esp32CalibrateUrl, fetchEsp32Json,
  normalizeEsp32DashboardUrl, parseEsp32Data, parseEsp32History,
  readEsp32UrlOverride, resolveEsp32DashboardUrl, toSensorPct, writeEsp32UrlOverride,
} from './esp32-url.js';

const CAL_MODES = ['wempty', 'wfull', 'sdry', 'swet'];
const WATER = '#3B87BD';
const SOIL = '#1D6246';

let generation = 0;
let pollTimer = null;
let pulling = false;
let panelEl = null;
let drawFn = null;
let aliveFn = () => false;
let liveUrl = '';
let phase = 'checking';
let reading = null;
let histW = [];
let histS = [];
let histTried = false;

export function stopSensorsLive() {
  generation += 1;
  pulling = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  panelEl = null;
  drawFn = null;
  aliveFn = () => false;
}

function frame(url) {
  // allow-same-origin keeps the device's own origin so its page can fetch /data on itself.
  // allow-modals lets its calibration confirm() run. No allow-top-navigation: it cannot leave this app.
  return html`<iframe class="esp-frame" title="${t('esp_iframe_title')}" src="${url}" sandbox="allow-scripts allow-same-origin allow-modals" referrerpolicy="no-referrer"></iframe>`;
}

function levelText(pct, low, mid, high) {
  if (pct < 0) return t('esp_not_cal');
  if (pct <= 20) return t(low);
  if (pct < 70) return t(mid);
  return t(high);
}

function calHint(loSet, hiSet, first, second) {
  if (loSet && hiSet) return { ok: true, text: t('esp_hint_ok') };
  if (!loSet && !hiSet) return { ok: false, text: t('esp_hint_start', { first, second }) };
  return { ok: false, text: t('esp_hint_next', { which: loSet ? second : first }) };
}

function gauge(pct, raw, color, label) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const frac = pct >= 0 ? pct / 100 : Math.max(0, Math.min(1, Number(raw) / 4095));
  const big = pct >= 0 ? `${pct}%` : String(Math.round(raw));
  const unit = pct >= 0 ? t('esp_pct_unit') : t('esp_raw_unit');
  return html`<div class="esp-gauge" role="img" aria-label="${label}: ${big}">
    <svg viewBox="0 0 140 140" width="120" height="120" aria-hidden="true">
      <circle cx="70" cy="70" r="${r}" fill="none" stroke="#E3EAE0" stroke-width="12"/>
      <circle cx="70" cy="70" r="${r}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(2)}" transform="rotate(-90 70 70)"/>
    </svg>
    <div class="esp-gauge-val"><b>${big}</b><span>${unit}</span></div>
  </div>`;
}

/** SVG line chart. Calibrated samples are mapped to percent; otherwise the axis is raw ADC. */
export function sensorHistoryChart(raws, { lo, hi, loSet, hiSet, color, label, gradId }) {
  const nums = (Array.isArray(raws) ? raws : []).map(Number).filter((n) => Number.isFinite(n)).slice(-ESP32_HISTORY_POINTS);
  const cal = !!(loSet && hiSet && lo !== hi);
  const values = nums.map((raw) => (cal ? toSensorPct(raw, lo, hi, true, true) : raw)).filter((v) => v >= 0);
  if (values.length < 2) return html`<p class="empty">${t('esp_hist_wait')}</p>`;
  const max = cal ? 100 : 4095;
  const W = 640, H = 150, L = 36, R = 8, T = 8, B = 4;
  const pw = W - L - R, ph = H - T - B - 4;
  const x = (i) => L + (pw * i) / (values.length - 1);
  const y = (v) => T + ph * (1 - Math.max(0, Math.min(max, v)) / max);
  let d = '';
  values.forEach((v, i) => { d += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  const baseY = (T + ph).toFixed(1);
  const area = `${d} L${x(values.length - 1).toFixed(1)},${baseY} L${x(0).toFixed(1)},${baseY} Z`;
  const grids = [0, 1, 2, 3, 4].map((k) => {
    const yy = (T + (ph * k) / 4).toFixed(1);
    const lab = Math.round(max * (1 - k / 4));
    return html`<line x1="${L}" x2="${L + pw}" y1="${yy}" y2="${yy}" stroke="#E3EAE0" stroke-width="1"/><text x="2" y="${(Number(yy) + 3).toFixed(1)}" fill="#6B7C72" font-size="10">${lab}</text>`;
  });
  return html`<div class="chartbox"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".28"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${grids}
    <path d="${area}" fill="url(#${gradId})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg></div>
  <div class="chartx"><span>${cal ? t('esp_hist_pct') : t('esp_hist_raw')}</span><span>${t('esp_hist_last', { n: values.length })}</span></div>`;
}

function probeCard({ title, pct, raw, status, loLabel, hiLabel, lo, hi, loSet, hiSet, hint, modeLo, modeHi, color }) {
  const point = (set, value) => (set && Number.isFinite(value) ? String(Math.round(value)) : '-');
  return html`<div class="card pad">
    <div class="lbl">${title}</div>
    <div class="esp-read">
      ${gauge(pct, raw, color, title)}
      <div>
        <div class="esp-st">${status}</div>
        <div class="esp-meta">${t('esp_raw_label')} <b>${Math.round(raw)}</b><br>${loLabel} <b>${point(loSet, lo)}</b> · ${hiLabel} <b>${point(hiSet, hi)}</b></div>
      </div>
    </div>
    <div class="esp-hint${hint.ok ? ' ok' : ''}">${hint.text}</div>
    <div class="esp-actions">
      <button class="btn out sm" type="button" data-act="esp-cal" data-mode="${modeLo}" aria-pressed="${loSet ? 'true' : 'false'}">${modeLo === 'wempty' ? t('esp_set_empty') : t('esp_set_dry')}</button>
      <button class="btn ${modeHi === 'wfull' ? 'dk' : 'lime'} sm" type="button" data-act="esp-cal" data-mode="${modeHi}" aria-pressed="${hiSet ? 'true' : 'false'}">${modeHi === 'wfull' ? t('esp_set_full') : t('esp_set_wet')}</button>
    </div>
  </div>`;
}

export function sensorsPanel({ phase: panelPhase, url, reading: data, water, soil }) {
  const device = normalizeEsp32DashboardUrl(url) || ESP32_DASHBOARD_URL_DEFAULT;
  if (panelPhase === 'live' && data) {
    const wPct = displayPct(data.wPct, data.wRaw, data.wE, data.wF, data.wEs, data.wFs);
    const sPct = displayPct(data.sPct, data.sRaw, data.sD, data.sW, data.sDs, data.sWs);
    const wifi = data.sta
      ? t('esp_wifi', { ip: data.staIp || '—', rssi: data.rssi == null ? '—' : String(Math.round(data.rssi)) })
      : t('esp_wifi_off');
    return html`<div class="row g8 wrap">
        <span class="chip"><span class="dot"></span>${t('esp_live')}</span>
        <span class="chip"><span class="dot ${data.sta ? '' : 'red'}"></span>${wifi}</span>
        <span class="chip">${t('esp_cloud', { status: data.cloud || '—' })}</span>
        <button class="btn out sm" type="button" data-act="esp-retry">${t('esp_retry')}</button>
      </div>
      <div class="esp-grid">
        ${probeCard({
          title: t('esp_water'), pct: wPct, raw: data.wRaw,
          status: levelText(wPct, 'esp_water_low', 'esp_water_mid', 'esp_water_full'),
          loLabel: t('esp_empty'), hiLabel: t('esp_full'), lo: data.wE, hi: data.wF, loSet: data.wEs, hiSet: data.wFs,
          hint: calHint(data.wEs, data.wFs, 'EMPTY', 'FULL'),
          modeLo: 'wempty', modeHi: 'wfull', color: WATER,
        })}
        ${probeCard({
          title: t('esp_soil'), pct: sPct, raw: data.sRaw,
          status: levelText(sPct, 'esp_soil_dry', 'esp_soil_ok', 'esp_soil_wet'),
          loLabel: t('esp_dry'), hiLabel: t('esp_wet'), lo: data.sD, hi: data.sW, loSet: data.sDs, hiSet: data.sWs,
          hint: calHint(data.sDs, data.sWs, 'DRY', 'WET'),
          modeLo: 'sdry', modeHi: 'swet', color: SOIL,
        })}
        <div class="card pad"><div class="lbl">${t('esp_hist_water')}</div>${sensorHistoryChart(water, { lo: data.wE, hi: data.wF, loSet: data.wEs, hiSet: data.wFs, color: WATER, label: t('esp_hist_water'), gradId: 'esp-w-fill' })}</div>
        <div class="card pad"><div class="lbl">${t('esp_hist_soil')}</div>${sensorHistoryChart(soil, { lo: data.sD, hi: data.sW, loSet: data.sDs, hiSet: data.sWs, color: SOIL, label: t('esp_hist_soil'), gradId: 'esp-s-fill' })}</div>
      </div>`;
  }
  if (panelPhase === 'blocked') {
    return html`<div class="errbox" role="alert"><b>${t('esp_offline_title')}</b><p style="margin-top:6px">${t('esp_offline')}</p><p style="margin-top:6px">${t('esp_browser_block')}</p><div class="row g8 wrap" style="margin-top:10px"><button class="btn dk sm" type="button" data-act="esp-retry">${t('esp_retry')}</button></div></div><p class="sm" style="margin-top:10px">${t('esp_embed_note')}</p>${frame(device)}`;
  }
  return html`<span class="chip"><span class="dot grey"></span>${t('esp_checking')}</span>`;
}

/** phase: checking | live | blocked */
export function sensorsView({ url, serverUrl, phase: viewPhase, overridden, reading: data, water, soil }) {
  const device = normalizeEsp32DashboardUrl(url) || ESP32_DASHBOARD_URL_DEFAULT;
  const server = normalizeEsp32DashboardUrl(serverUrl) || ESP32_DASHBOARD_URL_DEFAULT;
  const open = html`<a class="btn dk sm" href="${device}" target="_blank" rel="noopener noreferrer">${icon('sensor', 16)}${t('esp_open')}</a>`;
  return html`<div class="pg">
    <div class="pagehead"><div><h1>${t('esp_title')}</h1><div class="sub">${t('esp_sub')}</div></div>${open}</div>
    <form class="card pad" id="esp-form" novalidate>
      <div class="esp-url">
        <div class="field grow"><label for="esp-url">${t('esp_url_label')}</label><input id="esp-url" name="esp32url" type="url" inputmode="url" autocomplete="off" spellcheck="false" value="${device}"></div>
        <button class="btn dk sm" type="submit">${t('esp_save')}</button>
        <button class="btn out sm" type="button" data-act="esp-reset">${t('esp_reset')}</button>
      </div>
      <p class="xs mut" style="margin-top:8px">${t('esp_url_hint', { url: server })}</p>
      <p class="xs mut">${overridden ? t('esp_using_saved') : t('esp_using_default')}</p>
    </form>
    <div class="esp-status" id="esp-panel">${sensorsPanel({ phase: viewPhase, url: device, reading: data, water, soil })}</div>
    <div class="card pad esp-notes"><p>${t('esp_pins')}</p><p>${t('esp_read')}</p><p>${t('esp_net')}</p></div>
  </div>`;
}

export function sensorsDashLink() {
  return html`<a class="card pad row sp esp-dash" href="#/sensors"><span class="row g8">${icon('sensor', 18)}<span><b>${t('esp_title')}</b><span class="xs mut" style="display:block">${t('esp_dash_hint')}</span></span></span>${icon('chev', 18)}</a>`;
}

function paintPanel() {
  if (!panelEl || !drawFn || !aliveFn()) return;
  drawFn(panelEl, sensorsPanel({ phase, url: liveUrl, reading, water: histW, soil: histS }));
}

async function pull() {
  if (pulling || !aliveFn() || !liveUrl) return;
  const gen = generation;
  pulling = true;
  try {
    const data = await fetchEsp32Json(liveUrl, `/data?t=${Date.now()}`);
    if (gen !== generation || !aliveFn()) return;
    const next = data.ok ? parseEsp32Data(data.json) : null;
    if (!next) {
      if (phase !== 'blocked') { phase = 'blocked'; reading = null; paintPanel(); }
      return;
    }
    if (!histTried) {
      histTried = true;
      const hist = await fetchEsp32Json(liveUrl, '/history');
      if (gen !== generation || !aliveFn()) return;
      const parsed = hist.ok ? parseEsp32History(hist.json) : null;
      if (parsed && !histW.length) { histW = parsed.w; histS = parsed.s; }
    }
    histW = histW.concat(next.wRaw).slice(-ESP32_HISTORY_POINTS);
    histS = histS.concat(next.sRaw).slice(-ESP32_HISTORY_POINTS);
    reading = next;
    phase = 'live';
    paintPanel();
  } finally {
    if (gen === generation) pulling = false;
  }
}

export async function sensorsPage(alive, renderChrome, draw, viewEl) {
  stopSensorsLive();
  renderChrome('sensors');
  const serverUrl = normalizeEsp32DashboardUrl(getSession()?.esp32DashboardUrl) || ESP32_DASHBOARD_URL_DEFAULT;
  const url = resolveEsp32DashboardUrl(serverUrl, localStorage);
  const overridden = readEsp32UrlOverride(localStorage) != null;
  liveUrl = url;
  phase = 'checking';
  reading = null;
  histW = [];
  histS = [];
  histTried = false;
  const gen = generation;
  aliveFn = () => gen === generation && alive();
  drawFn = draw;
  draw(viewEl, sensorsView({ url, serverUrl, phase, overridden, reading, water: histW, soil: histS }));
  panelEl = viewEl.querySelector('#esp-panel');
  await pull();
  if (!aliveFn()) return;
  pollTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    pull();
  }, ESP32_POLL_MS);
}

export async function sensorsClick(a, el, { route, toast, confirm: confirmImpl }) {
  if (a === 'esp-retry') return route();
  if (a === 'esp-reset') {
    clearEsp32UrlOverride(localStorage);
    toast(t('esp_reset_ok'));
    return route();
  }
  if (a === 'esp-cal') {
    const mode = el?.dataset?.mode;
    const target = esp32CalibrateUrl(liveUrl, mode);
    if (!target || !CAL_MODES.includes(mode)) return undefined;
    const ask = typeof confirmImpl === 'function' ? confirmImpl : globalThis.confirm;
    if (typeof ask === 'function' && !ask(t(`esp_cal_ask_${mode}`))) return undefined;
    const res = await fetchEsp32Json(liveUrl, `/calibrate?mode=${mode}`);
    if (!res.ok || !res.json || res.json.ok !== true) { toast(t('esp_cal_fail'), true); return undefined; }
    toast(t('esp_cal_ok'));
    await pull();
    return undefined;
  }
  return undefined;
}

export async function sensorsSubmit(ev, { route, toast }) {
  if (ev.target.id !== 'esp-form') return false;
  ev.preventDefault();
  const value = ev.target.querySelector('#esp-url')?.value ?? '';
  const saved = writeEsp32UrlOverride(value, localStorage);
  if (!saved) { toast(t('esp_bad_url'), true); return true; }
  toast(t('esp_saved'));
  await route();
  return true;
}
