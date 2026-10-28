// Live field sensors: embed the ESP32's own page. The server cannot reach the hotspot.
// See docs/ESP32.md. The device sends no CORS headers, so this file never fetches /data.
import { html, icon } from './util.js';
import { t } from './i18n.js';
import { getSession } from './api.js';
import {
  ESP32_DASHBOARD_URL_DEFAULT, clearEsp32UrlOverride, normalizeEsp32DashboardUrl, probeEsp32Dashboard,
  readEsp32UrlOverride, resolveEsp32DashboardUrl, writeEsp32UrlOverride,
} from './esp32-url.js';

let showEmbed = false;

function frame(url) {
  // allow-same-origin keeps the device's own origin so its page can fetch /data on itself.
  // allow-modals lets its calibration confirm() run. No allow-top-navigation: it cannot leave this app.
  return html`<iframe class="esp-frame" title="${t('esp_iframe_title')}" src="${url}" sandbox="allow-scripts allow-same-origin allow-modals" referrerpolicy="no-referrer"></iframe>`;
}

/** phase: checking | online | offline | embed */
export function sensorsView({ url, serverUrl, phase, overridden }) {
  const device = normalizeEsp32DashboardUrl(url) || ESP32_DASHBOARD_URL_DEFAULT;
  const server = normalizeEsp32DashboardUrl(serverUrl) || ESP32_DASHBOARD_URL_DEFAULT;
  const open = html`<a class="btn dk sm" href="${device}" target="_blank" rel="noopener noreferrer">${icon('sensor', 16)}${t('esp_open')}</a>`;
  let status;
  if (phase === 'online') {
    status = html`<div class="row g8 wrap"><span class="chip"><span class="dot"></span>${t('esp_online')}</span><button class="btn out sm" type="button" data-act="esp-retry">${t('esp_retry')}</button></div>${frame(device)}`;
  } else if (phase === 'embed') {
    status = html`<p class="sm">${t('esp_embed_note')}</p><div class="row g8 wrap" style="margin-top:8px"><button class="btn out sm" type="button" data-act="esp-retry">${t('esp_retry')}</button></div>${frame(device)}`;
  } else if (phase === 'offline') {
    status = html`<div class="errbox" role="alert"><b>${t('esp_offline_title')}</b><p style="margin-top:6px">${t('esp_offline')}</p><p style="margin-top:6px">${t('esp_browser_block')}</p><div class="row g8 wrap" style="margin-top:10px"><button class="btn dk sm" type="button" data-act="esp-retry">${t('esp_retry')}</button><button class="btn out sm" type="button" data-act="esp-embed">${t('esp_show_anyway')}</button></div></div>`;
  } else {
    status = html`<span class="chip"><span class="dot grey"></span>${t('esp_checking')}</span>`;
  }
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
    <div class="esp-status" role="status">${status}</div>
    <div class="card pad esp-notes"><p>${t('esp_pins')}</p><p>${t('esp_cors')}</p><p>${t('esp_net')}</p></div>
  </div>`;
}

export function sensorsDashLink() {
  return html`<a class="card pad row sp esp-dash" href="#/sensors"><span class="row g8">${icon('sensor', 18)}<span><b>${t('esp_title')}</b><span class="xs mut" style="display:block">${t('esp_dash_hint')}</span></span></span>${icon('chev', 18)}</a>`;
}

export async function sensorsPage(alive, renderChrome, draw, viewEl) {
  renderChrome('sensors');
  const serverUrl = normalizeEsp32DashboardUrl(getSession()?.esp32DashboardUrl) || ESP32_DASHBOARD_URL_DEFAULT;
  const url = resolveEsp32DashboardUrl(serverUrl, localStorage);
  const overridden = readEsp32UrlOverride(localStorage) != null;
  const paint = (phase) => draw(viewEl, sensorsView({ url, serverUrl, phase, overridden }));
  if (showEmbed) { paint('embed'); return; }
  paint('checking');
  const ok = await probeEsp32Dashboard(url);
  if (!alive()) return;
  paint(ok ? 'online' : 'offline');
}

export async function sensorsClick(a, _el, { route, toast }) {
  if (a === 'esp-retry') { showEmbed = false; return route(); }
  if (a === 'esp-embed') { showEmbed = true; return route(); }
  if (a === 'esp-reset') {
    clearEsp32UrlOverride(localStorage);
    showEmbed = false;
    toast(t('esp_reset_ok'));
    return route();
  }
  return undefined;
}

export async function sensorsSubmit(ev, { route, toast }) {
  if (ev.target.id !== 'esp-form') return false;
  ev.preventDefault();
  const value = ev.target.querySelector('#esp-url')?.value ?? '';
  const saved = writeEsp32UrlOverride(value, localStorage);
  if (!saved) { toast(t('esp_bad_url'), true); return true; }
  showEmbed = false;
  toast(t('esp_saved'));
  await route();
  return true;
}
