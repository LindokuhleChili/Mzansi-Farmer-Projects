// Weather alerts (docs/WEATHER.md). No AI: OpenEdge compares the 7-day forecast with the alert thresholds,
// writes the alerts and the audit, and validates every threshold change. The farmer acknowledges.
// The forecast is a synthetic EXAMPLE file, never a real weather service.
import { html, icon, num, fmtDayNoYear } from './util.js';
import { t, tx } from './i18n.js';
import { api } from './api.js';
import { lvl } from './views.js';

const HERO = '/assets/photos/rain-wheat-storm-kenya.jpg';
const FARM_ID = 1;
const LVL = { watch: 'z', warning: 'w', severe: 'o' };

function dayCard(d, alerts) {
  const hit = alerts.filter((a) => a.dayNo === d.dayNo);
  return html`<div class="wx-day${hit.length ? ' hit' : ''}">
    <div class="xs mut">${t('wx_day', { n: d.dayNo })}</div><b>${fmtDayNoYear(d.date + 'T12:00:00+02:00')}</b>
    <div class="wx-t"><span>${num(d.tempMaxC, 0)}°</span><span class="mut">${num(d.tempMinC, 0)}°</span></div>
    <div class="xs">${t('wx_rain_mm', { mm: num(d.rainMm, 1) })}</div>
    ${hit.map((a) => html`<div class="wx-flag ${a.level}">${t('wx_type_' + a.alertType)}</div>`)}</div>`;
}
function alertRow(a) {
  return html`<div class="kv wx-alert"><span class="row g8">${lvl(LVL[a.level] || 'w', '', t('wx_lvl_' + a.level))}<span><b>${tx(a.message)}</b><span class="xs mut"> · ${fmtDayNoYear(a.forecastDate + 'T12:00:00+02:00')}</span></span></span>
    ${a.status === 'open' ? html`<button class="btn out sm" data-act="wx-ack" data-id="${a.alertId}">${t('wx_ack')}</button>` : html`<span class="xs mut">${t('wx_acked')}</span>`}</div>`;
}
function thresholdRow(th) {
  return html`<form class="wx-th" data-id="${th.thresholdId}" novalidate>
    <label for="th-${th.thresholdId}" class="grow"><b>${t('wx_type_' + th.alertType)}</b> <span class="xs mut">${th.op} · ${t('wx_lvl_' + th.level)}</span></label>
    <input id="th-${th.thresholdId}" name="value" type="number" step="0.1" inputmode="decimal" value="${th.value}" aria-label="${t('wx_type_' + th.alertType)} (${th.unit})">
    <span class="xs mut">${th.unit === 'mm' ? 'mm' : '°C'}</span><button class="btn out sm" type="submit">${t('wx_save')}</button></form>`;
}
export async function weatherPage(alive, renderChrome, draw, viewEl, need) {
  renderChrome('weather');
  const farm = need(await api('GET', `/farms/${FARM_ID}`));
  const [fc, al, th] = await Promise.all([api('GET', `/forecast?province=${encodeURIComponent(farm.province || '')}`), api('GET', `/farms/${FARM_ID}/alerts`), api('GET', '/alert-thresholds')]);
  if (!alive()) return;
  const days = need(fc).days || [];
  const alerts = need(al).alerts || [];
  const open = alerts.filter((a) => a.status === 'open');
  draw(viewEl, html`<div class="pg">
    <div class="pagehead"><div><h1>${t('wx_title')}</h1><div class="sub">${t('wx_sub')}</div></div>
      <button class="btn dk sm" data-act="wx-refresh" data-province="${farm.province || ''}">${icon('spark', 16)}${t('wx_refresh')}</button></div>
    <div class="mk-hero" style="background-image:url(${HERO})" role="img" aria-label="Storm clouds over a wheat field">
      <div class="mk-hero-t"><div class="lbl">${tx(farm.province || '')}</div><b>${open.length ? t(open.length === 1 ? 'wx_open_1' : 'wx_open_n', { n: open.length }) : t('wx_open_0')}</b><span>${t('wx_rules')}</span></div></div>
    <div class="row sp wrap g8" style="margin:14px 0 10px"><div class="lbl">${t('wx_week')}</div>${fc.body?.source === 'open-meteo' ? html`<span class="tag-ex d wx-live">${t('wx_src_om')}</span>` : html`<span class="tag-ex d">${t('wx_example')}</span>`}</div>
    ${days.length ? html`<div class="wx-days">${days.map((d) => dayCard(d, open))}</div>` : html`<div class="card pad"><p class="empty">${t('wx_nodata')}</p></div>`}
    ${fc.body?.source === 'open-meteo' ? html`<p class="xs mut wx-credit">${t('wx_om_credit_pre')} <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a> (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>) · ${t('wx_om_place', { date: fc.body.baseDate })}</p>`
      : html`<p class="xs mut wx-credit">${t('wx_example_note')}</p>`}
    <div class="wx-grid">
      <div class="card pad"><div class="lbl" style="margin-bottom:6px">${t('wx_alerts')}</div>
        ${alerts.length ? alerts.map(alertRow) : html`<p class="sm mut">${t('wx_none')}</p>`}</div>
      <div class="card pad"><div class="lbl" style="margin-bottom:4px">${t('wx_thresholds')}</div><p class="xs mut">${t('wx_th_hint')}</p>
        ${(need(th).thresholds || []).map(thresholdRow)}</div>
    </div></div>`);
}
export async function weatherClick(a, el, { route, toast, busy, errText }) {
  const fail = (r) => toast(errText({ code: r.body?.error, message: r.body?.message }), true);
  busy(el, true);
  try {
    if (a === 'wx-refresh') {
      // 1) real forecast from Open-Meteo (OpenEdge validates and stores it); on failure the stored forecast stays and we say so
      const fr = await api('POST', '/forecast/refresh', { province: el.dataset.province || '' });
      const fellBack = fr.status !== 200 || fr.body.fallback;
      // 2) OpenEdge compares the stored forecast with the alert levels
      const r = await api('POST', `/farms/${FARM_ID}/alerts/refresh`, {});
      if (r.status === 200) toast((fellBack ? t('wx_fetch_failed') + ' ' : '') + (r.body.noData ? t('wx_nodata') : t('wx_refreshed', { a: r.body.created, b: r.body.expired })), fellBack); else fail(r);
    } else if (a === 'wx-ack') {
      const r = await api('POST', `/alerts/${Number(el.dataset.id)}/acknowledge`, {});
      if (r.status === 200) toast(t('wx_acked')); else fail(r);
    }
    await route();
  } catch (e) { toast(errText(e), true); busy(el, false); }
}
export async function weatherSubmit(ev, { route, toast, busy, errText }) {
  const f = ev.target.closest?.('form.wx-th');
  if (!f) return false;
  ev.preventDefault();
  const btn = f.querySelector('button'); busy(btn, true);
  try {
    const r = await api('POST', `/alert-thresholds/${Number(f.dataset.id)}`, { value: Number(f.value.value) });
    if (r.status === 200) { toast(t('wx_saved')); await route(); }
    else { toast(r.body?.error === 'ALERT_THRESHOLD_INVALID' ? `${t('e_ALERT_THRESHOLD_INVALID')} ${tx(r.body.message || '')}` : errText({ code: r.body?.error, message: r.body?.message }), true); busy(btn, false); }
  } catch (e) { toast(errText(e), true); busy(btn, false); }
  return true;
}
