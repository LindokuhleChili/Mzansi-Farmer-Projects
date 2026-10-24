// Harvest-day market (docs/MARKET.md): list, detail, the farmer's create/edit form and reservations.
// The farmer lists produce for a market day; OpenEdge checks every price against the retail buyer price and every lot
// against its free stock; the farmer publishes with the same two-step confirmation as approving a suggestion.
import { html, raw, $, $$, icon, num, fmtDayLong, fmtDayNoYear, fmtHM, photoStyle } from './util.js';
import { t, tx } from './i18n.js';
import { api } from './api.js';
import { lvl, fmtSecs } from './views.js';

const HERO = '/assets/photos/market-stall.jpg';
const RESERVE_CAP_KG = 50;   // same as mock-pasoe/constants.js and farm-api.p; the rules are in OpenEdge, this is only for the hint
const TZ_OFFSET = '+02:00';  // South Africa has no daylight saving: form times are SAST
const rand = (v) => Number(v).toFixed(2);
const ST = { pending_approval: 'w', published: 'n', rejected: 'o', declined: 'z', cancelled: 'z' };
const stLvl = (st) => lvl(ST[st] || 'z', st === 'published' ? 'check' : st === 'rejected' ? 'x' : '', t('mk_st_' + st));
const isPast = (e, now = Date.now()) => Date.parse(e.startsAt) <= now;
const FILTERS = {
  upcoming: (e) => !isPast(e) && ['published', 'pending_approval'].includes(e.status),
  waiting: (e) => e.status === 'pending_approval',
  blocked: (e) => e.status === 'rejected',
  past: (e) => isPast(e) || ['cancelled', 'declined'].includes(e.status),
};
const mstate = { filter: 'upcoming', sheet: null, timer: null };

// ---------- list ----------
function dateBlock(e) {
  const d = fmtDayNoYear(e.startsAt).split(' ');   // "Sat 31 Oct"
  return html`<div class="mk-date" aria-hidden="true"><span>${d[0]}</span><b>${d[1]}</b><span>${d[2]}</span></div>`;
}
function eventRow(e) {
  const crops = [...new Set(e.items.map((i) => i.crop))];
  return html`<a class="mk-row" href="#/market/${e.eventId}">
    ${dateBlock(e)}
    <div class="grow"><div class="row sp g8"><div class="nm">${tx(e.eventName)}</div>${stLvl(e.status)}</div>
      <div class="xs mut" style="margin-top:3px">${icon('pin', 12)} ${e.venue}${e.area ? ' · ' + e.area : ''} · ${t('mk_time', { a: fmtHM(e.startsAt), b: fmtHM(e.endsAt) })}</div>
      <div class="mk-crops">${crops.map((c) => html`<span class="mk-crop"><span class="th photo" style="${photoStyle(c)}"></span>${tx(c)}</span>`)}</div>
      <div class="xs mut">${t(e.items.length === 1 ? 'mk_items_1' : 'mk_items_n', { n: e.items.length })} · ${t('mk_kg_total', { kg: num(e.totalKg, 0) })}${e.reservedKg ? ' · ' + t('mk_reserved_kg', { kg: num(e.reservedKg, 0) }) : ''}</div></div>
    ${icon('chev', 18)}</a>`;
}
function monthGroups(events) {
  const fm = new Intl.DateTimeFormat('en-ZA', { timeZone: 'Africa/Johannesburg', month: 'long', year: 'numeric' });
  const g = [];
  for (const e of events) {
    const m = fm.format(new Date(e.startsAt));
    if (!g.length || g[g.length - 1].m !== m) g.push({ m, list: [] });
    g[g.length - 1].list.push(e);
  }
  return g;
}
export async function marketPage(alive, renderChrome, draw, viewEl, need) {
  renderChrome('market');
  const events = need(await api('GET', '/market/events')).events || [];
  if (!alive()) return;
  const f = FILTERS[mstate.filter] || FILTERS.upcoming;
  const shown = events.filter(f);
  if (mstate.filter === 'past') shown.reverse();
  const next = events.filter(FILTERS.upcoming).find((e) => e.status === 'published');
  draw(viewEl, html`<div class="pg">
    <div class="pagehead"><div><h1>${t('mk_title')}</h1><div class="sub">${t('mk_sub')}</div></div>
      <a class="btn dk sm d-only" href="#/market/new">${icon('spark', 16)}${t('mk_new')}</a></div>
    <div class="mk-hero" style="background-image:url(${HERO})" role="img" aria-label="Fresh produce on a market stall">
      <div class="mk-hero-t">${next ? html`<div class="lbl">${t('mk_hero_t')}</div><b>${tx(next.eventName)}</b><span>${fmtDayLong(next.startsAt)} · ${fmtHM(next.startsAt)} · ${next.venue}</span>`
        : html`<b>${t('mk_hero_none')}</b>`}</div></div>
    <div class="row sp wrap g8" style="margin:14px 0 12px">
      <div class="chipsel" role="group">${Object.keys(FILTERS).map((k) => html`<button data-act="mk-filter" data-f="${k}" aria-pressed="${String(mstate.filter === k)}">${t('mk_f_' + k)} (${events.filter(FILTERS[k]).length})</button>`)}</div>
      <span class="tag-ex d">${t('mk_example')}</span></div>
    ${shown.length ? monthGroups(shown).map((g) => html`<div class="lbl mk-month">${g.m}</div><div class="card mk-list">${g.list.map(eventRow)}</div>`) : html`<div class="card pad"><p class="empty">${t('mk_none')}</p></div>`}
    <a class="btn dk block m-only" style="margin-top:14px" href="#/market/new">${icon('spark', 16)}${t('mk_new')}</a>
  </div>`);
}

// ---------- detail ----------
function ruleCard(e) {
  const reasons = e.rejectReasons || [];
  if (!reasons.length) return html`<div class="card pad"><div class="row sp"><div class="lbl">${t('mk_rules')}</div>${lvl('n', 'check', t('mk_rules_ok'))}</div>
    <p class="xs mut" style="margin-top:8px">${t('mk_publish_hint')}</p></div>`;
  return html`<div class="card pad"><div class="row sp"><div class="lbl">${t('mk_rules')}</div>${lvl('o', 'x', t('mk_rules_bad'))}</div>
    ${reasons.map((r) => html`<div class="mk-reason">${icon('x', 14)}<div><b>${t('r_' + r.code) !== 'r_' + r.code ? t('r_' + r.code) : r.code}${r.item ? ' · ' + t('mk_item_n', { n: r.item }) : ''}</b><div class="xs mut">${tx(r.message)}</div></div></div>`)}</div>`;
}
function itemsTable(e) {
  return html`<div class="tbl-wrap"><table class="t mk-t"><thead><tr><th>${t('mk_col_item')}</th><th class="r">${t('mk_col_kg')}</th><th class="r">${t('mk_col_price')}</th><th class="r d-only">${t('mk_col_retail')}</th><th class="r d-only">${t('mk_col_reserve')}</th><th class="r d-only">${t('mk_col_walk')}</th></tr></thead><tbody>
    ${e.items.map((i) => html`<tr><td><div class="row g8"><span class="th photo" style="${photoStyle(i.crop)}"></span><div><b>${tx(i.label)}</b><div class="xs mut">${tx(i.crop)}${i.lotId ? ' · ' + t('mk_lot', { id: i.lotId }) : ''}</div></div></div></td>
      <td class="r">${num(i.quantityKg, 0)}</td>
      <td class="r"><b>${t('mk_per_kg', { p: rand(i.pricePerKg) })}</b>${i.retailBuyerPricePerKg !== null && i.pricePerKg < i.retailBuyerPricePerKg ? html`<div class="xs ok">${t('mk_below', { d: rand(i.retailBuyerPricePerKg - i.pricePerKg) })}</div>` : ''}</td>
      <td class="r d-only">${i.retailBuyerPricePerKg === null ? html`<span class="xs mut">${t('mk_no_ref')}</span>` : t('mk_per_kg', { p: rand(i.retailBuyerPricePerKg) })}</td>
      <td class="r d-only">${num(i.reservableKg, 0)}</td><td class="r d-only">${num(i.walkUpKg, 0)}</td></tr>`)}
  </tbody></table></div>`;
}
function reservationsCard(e, res) {
  const open = e.status === 'published' && !isPast(e);
  const conf = res.filter((r) => r.status === 'confirmed');
  const items = new Map(e.items.map((i) => [i.itemId, i]));
  return html`<div class="card pad"><div class="lbl" style="margin-bottom:4px">${t('mk_res_title')}</div>
    <p class="xs mut">${t('mk_res_hint', { cap: RESERVE_CAP_KG })}</p>
    ${conf.length ? conf.map((r) => html`<div class="kv"><span>${r.buyerName} · ${tx(items.get(r.itemId)?.label || '')}</span><span class="row g8"><b>${num(r.quantityKg, 0)} kg</b>${open ? html`<button class="btn out sm" data-act="mk-res-cancel" data-id="${r.reservationId}" aria-label="${t('mk_res_cancel')}">${icon('x', 14)}</button>` : ''}</span></div>`)
      : html`<p class="sm mut" style="margin-top:8px">${open ? t('mk_res_none') : t('mk_res_closed')}</p>`}
    ${open ? html`<form id="mk-res" class="mk-resform" data-event="${e.eventId}" novalidate>
      <div class="field"><label for="r-name">${t('mk_res_buyer')}</label><input id="r-name" name="buyer" type="text" maxlength="80" autocomplete="off" required></div>
      <div class="field"><label for="r-item">${t('mk_res_item')}</label><select id="r-item" name="item">${e.items.filter((i) => i.reservableKg > 0).map((i) => html`<option value="${i.itemId}">${i.label} (${num(i.reservableKg, 0)} kg)</option>`)}</select></div>
      <div class="field"><label for="r-kg">${t('mk_res_kg')}</label><input id="r-kg" name="kg" type="number" min="1" step="1" inputmode="numeric" required></div>
      <button class="btn dk" type="submit">${t('mk_res_add')}</button></form>` : ''}
  </div>`;
}
export async function marketEventPage(id, alive, renderChrome, draw, viewEl, need) {
  renderChrome('market');
  const [e, rr] = await Promise.all([api('GET', `/market/events/${id}`).then(need), api('GET', `/market/reservations?eventId=${id}`).then(need)]);
  if (!alive()) return;
  const res = rr.reservations || [];
  const hasRes = res.some((r) => r.status === 'confirmed');
  const canEdit = ['pending_approval', 'published', 'rejected', 'declined'].includes(e.status) && !hasRes;
  const acts = html`${e.status === 'pending_approval' ? html`<button class="btn out" data-act="mk-decline" data-id="${e.eventId}">${t('mk_decline')}</button><button class="btn dk" data-act="mk-publish" data-id="${e.eventId}">${icon('check', 16)}${t('mk_publish')}</button>` : ''}
    ${canEdit ? html`<a class="btn out" href="#/market/${e.eventId}/edit">${t('mk_edit_btn')}</a>` : ''}
    ${['pending_approval', 'published'].includes(e.status) ? html`<button class="btn out mk-danger" data-act="mk-cancel" data-id="${e.eventId}">${t('mk_cancel_event')}</button>` : ''}`;
  draw(viewEl, html`<div class="pg">
    <a class="back" href="#/market">${icon('back', 16)} ${t('mk_back')}</a>
    <div class="mk-dhead" style="background-image:url(${HERO})" role="img" aria-label="Fresh produce on a market stall"></div>
    <div class="pagehead"><div><div class="row g8 wrap">${stLvl(e.status)}<span class="tag-ex d">${t('example_data')}</span></div><h1 style="margin-top:6px">${tx(e.eventName)}</h1>
      <div class="sub">${icon('clock', 12)} ${fmtDayLong(e.startsAt)} · ${t('mk_time', { a: fmtHM(e.startsAt), b: fmtHM(e.endsAt) })} SAST</div>
      <div class="sub">${icon('pin', 12)} ${e.venue}${e.area ? ', ' + e.area : ''}</div></div></div>
    <div class="two"><div>
      <div class="card pad"><div class="lbl" style="margin-bottom:8px">${t('mk_produce')}</div>${itemsTable(e)}
        ${e.notes ? html`<p class="sm" style="margin-top:12px"><b>${t('mk_notes')}:</b> ${tx(e.notes)}</p>` : ''}</div>
      ${hasRes && e.status !== 'cancelled' ? html`<p class="xs mut" style="margin-top:10px">${t('mk_has_res')}</p>` : ''}
      <div class="row g8 wrap mk-acts">${acts}</div>
    </div><div>${ruleCard(e)}${reservationsCard(e, res)}</div></div>
  </div>`);
}

// ---------- create / edit ----------
const sastParts = (iso) => {
  const d = new Date(Date.parse(iso) + 2 * 3600 * 1000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
};
function itemRow(i, k, prices) {
  const ref = prices.find((p) => p.crop === i.crop);
  return html`<div class="mk-item" data-row="${k}">
    <div class="field"><label>${t('mk_form_crop')}</label><select name="crop" data-act-change="mk-crop">${prices.map((p) => html`<option ${p.crop === i.crop ? raw('selected') : ''}>${p.crop}</option>`)}</select></div>
    <div class="field"><label>${t('mk_form_label')}</label><input name="label" type="text" maxlength="80" value="${i.label && i.label !== i.crop ? i.label : ''}"></div>
    <div class="field"><label>${t('mk_form_kg')}</label><input name="kg" type="number" min="1" step="1" inputmode="numeric" value="${i.quantityKg ?? ''}"></div>
    <div class="field"><label>${t('mk_form_price')}</label><input name="price" type="number" min="0.01" step="0.01" inputmode="decimal" value="${i.pricePerKg ?? ''}"></div>
    <div class="field"><label>${t('mk_form_lot')}</label><input name="lot" type="number" min="1" step="1" inputmode="numeric" value="${i.lotId ?? ''}"></div>
    <button type="button" class="btn out sm mk-rm" data-act="mk-rm-item" aria-label="${t('mk_form_remove')}">${icon('x', 14)}</button>
    <div class="xs mut mk-ref" data-ref>${ref ? t('mk_form_ref', { p: rand(ref.retailBuyerPricePerKg) }) : ''}</div>
  </div>`;
}
let formPrices = [];
export async function marketFormPage(id, alive, renderChrome, draw, viewEl, need) {
  renderChrome('market');
  const [pr, ev] = await Promise.all([api('GET', '/market/prices').then(need), id ? api('GET', `/market/events/${id}`).then(need) : null]);
  if (!alive()) return;
  formPrices = pr.prices || [];
  const tomorrow = new Date(Date.now() + 7 * 86400000).toISOString();
  const e = ev || { eventName: '', venue: '', area: '', notes: '', startsAt: tomorrow.slice(0, 10) + 'T05:00:00Z', endsAt: tomorrow.slice(0, 10) + 'T10:00:00Z', items: [{ crop: formPrices[0]?.crop }] };
  const s = sastParts(e.startsAt), en = sastParts(e.endsAt);
  draw(viewEl, html`<div class="pg">
    <a class="back" href="${id ? `#/market/${id}` : '#/market'}">${icon('back', 16)} ${id ? tx(e.eventName) : t('mk_back')}</a>
    <div class="pagehead"><div><h1>${id ? t('mk_edit') : t('mk_new')}</h1><div class="sub">${t('mk_form_hint')}</div></div></div>
    <form id="mk-form" class="card pad mk-form" data-id="${id || ''}" novalidate>
      <div class="mk-grid">
        <div class="field wide"><label for="m-name">${t('mk_form_name')}</label><input id="m-name" name="eventName" type="text" maxlength="80" value="${e.eventName}" required></div>
        <div class="field"><label for="m-venue">${t('mk_form_venue')}</label><input id="m-venue" name="venue" type="text" maxlength="120" value="${e.venue}" required></div>
        <div class="field"><label for="m-area">${t('mk_form_area')}</label><input id="m-area" name="area" type="text" maxlength="80" value="${e.area}"></div>
        <div class="field"><label for="m-date">${t('mk_form_date')}</label><input id="m-date" name="date" type="date" value="${s.date}" required></div>
        <div class="field"><label for="m-start">${t('mk_form_start')}</label><input id="m-start" name="start" type="time" value="${s.time}" required></div>
        <div class="field"><label for="m-end">${t('mk_form_end')}</label><input id="m-end" name="end" type="time" value="${en.time}" required></div>
        <div class="field wide"><label for="m-notes">${t('mk_form_notes')}</label><textarea id="m-notes" name="notes" maxlength="500" rows="2">${e.notes}</textarea></div>
      </div>
      <div class="lbl" style="margin:16px 0 8px">${t('mk_form_items')}</div>
      <div id="mk-items">${e.items.map((i, k) => itemRow(i, k, formPrices))}</div>
      <button type="button" class="btn out sm" data-act="mk-add-item" style="margin-top:10px">${t('mk_form_add')}</button>
      <p class="sm" id="mk-err" role="alert" style="color:#8c2a18;margin-top:10px"></p>
      <button class="btn dk block" type="submit" style="margin-top:12px">${icon('shield', 16)}${t('mk_form_save')}</button>
    </form></div>`);
}
function readForm(f) {
  const v = (n) => f.elements[n].value.trim();
  const iso = (time) => new Date(`${v('date')}T${time}:00${TZ_OFFSET}`).toISOString().replace(/\.\d+Z$/, 'Z');
  const items = $$('.mk-item', f).map((row) => {
    const g = (n) => $(`[name=${n}]`, row).value.trim();
    const it = { crop: g('crop'), quantityKg: Number(g('kg')), pricePerKg: Number(g('price')) };
    if (g('label')) it.label = g('label');
    if (g('lot')) it.lotId = Number(g('lot'));
    return it;
  });
  let startsAt, endsAt;
  try { startsAt = iso(v('start')); endsAt = iso(v('end')); } catch { /* left undefined: the API says which field */ }
  return { eventName: v('eventName'), venue: v('venue'), area: v('area'), notes: v('notes'), startsAt, endsAt, items };
}

// ---------- confirm sheet (publish / cancel) ----------
function closeMkSheet(overlay) { clearInterval(mstate.timer); overlay.replaceChildren(); }
function openMkSheet(overlay, draw, { action, id, summary, token, secs, toast }) {
  const go = action === 'approve' ? t('mk_confirm_publish') : t('mk_confirm_cancel');
  const btns = (desk) => desk
    ? html`<div class="dbtns d-only" style="margin-top:18px"><button class="btn out" data-act="sheet-cancel">${icon('back', 16)}${t('go_back')}</button><button class="btn dk" style="flex:1.4" data-act="mk-confirm" data-id="${id}" data-action="${action}" data-token="${token}">${icon('check', 16)}${go}</button></div>`
    : html`<div class="actbar m-only"><button class="a" data-act="sheet-cancel">${icon('back', 16)}${t('go_back')}</button><button class="a go" data-act="mk-confirm" data-id="${id}" data-action="${action}" data-token="${token}">${icon('check', 16)}${go}</button></div>`;
  draw(overlay, html`<div class="scrim" data-act="sheet-bg" role="presentation"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-h">
    <div class="grab"></div>
    <div class="sh-t"><h2 id="sheet-h">${t('confirm_title')}</h2><span class="chip sm2 grey">${icon('clock', 12)} <span class="timer" data-timer>${fmtSecs(secs)}</span></span></div>
    <div class="appr"><div class="th photo" style="background-image:url(${HERO})"></div><div><div class="lbl">${action === 'approve' ? t('mk_you_publishing') : t('mk_you_cancelling')}</div><div class="s">${summary}</div></div></div>
    <div class="infos"><div>${icon('shield', 16)}<span>${t('mk_publish_hint')}</span></div></div>
    <div class="pbar"><i data-bar style="width:100%"></i></div>${btns(true)}${btns(false)}</div></div>`);
  const b = $$('[data-act=mk-confirm]', overlay).find((x) => x.getClientRects().length) || $('[data-act=mk-confirm]', overlay);
  b?.focus();
  let left = secs;
  clearInterval(mstate.timer);
  mstate.timer = setInterval(() => {
    left -= 1;
    $$('[data-timer]', overlay).forEach((el) => { el.textContent = fmtSecs(Math.max(0, left)); });
    const bar = $('[data-bar]', overlay); if (bar) bar.style.width = `${Math.max(0, left) / secs * 100}%`;
    if (left <= 0) { clearInterval(mstate.timer); $$('[data-act=mk-confirm]', overlay).forEach((x) => { x.disabled = true; }); toast(t('confirm_expired'), true); }
  }, 1000);
}

// ---------- actions (called from main.js) ----------
export async function marketClick(a, el, ctx) {
  const { route, toast, busy, errText, overlay, draw } = ctx;
  const id = Number(el.dataset.id);
  const fail = (r) => toast(errText({ code: r.body?.error, message: r.body?.message }), true);
  if (a === 'mk-filter') { mstate.filter = el.dataset.f; return route(); }
  if (a === 'mk-add-item') { $('#mk-items').insertAdjacentHTML('beforeend', String(itemRow({ crop: formPrices[0]?.crop }, $$('.mk-item').length, formPrices))); return; }
  if (a === 'mk-rm-item') { if ($$('.mk-item').length > 1) el.closest('.mk-item').remove(); return; }
  if (a === 'mk-publish' || a === 'mk-cancel') {
    const action = a === 'mk-publish' ? 'approve' : 'cancel';
    busy(el, true);
    try {
      const r = await api('POST', `/market/events/${id}/${a === 'mk-publish' ? 'publish' : 'cancel'}`, {});
      if (r.status === 202) openMkSheet(overlay, draw, { action, id, summary: r.body.summary, token: r.body.confirmToken, secs: r.body.expiresInSeconds || 120, toast });
      else { fail(r); await route(); }
    } catch (e) { toast(errText(e), true); } finally { busy(el, false); }
    return;
  }
  if (a === 'mk-confirm') {
    busy(el, true);
    try {
      const action = el.dataset.action;
      const r = await api('POST', `/market/events/${id}/${action === 'approve' ? 'publish' : 'cancel'}`, { confirmToken: el.dataset.token });
      closeMkSheet(overlay);
      if (r.status === 200 && r.body.status === (action === 'approve' ? 'published' : 'cancelled')) toast(t(action === 'approve' ? 'mk_published' : 'mk_cancelled'));
      else if (r.status === 200) toast(t('mk_saved_bad'), true);
      else fail(r);
      await route();
    } catch (e) { closeMkSheet(overlay); toast(errText(e), true); }
    return;
  }
  if (a === 'mk-decline') {
    busy(el, true);
    try { const r = await api('POST', `/market/events/${id}/decline`, {}); if (r.status === 200) toast(t('mk_declined')); else fail(r); await route(); }
    catch (e) { toast(errText(e), true); busy(el, false); }
    return;
  }
  if (a === 'mk-res-cancel') {
    busy(el, true);
    try { const r = await api('POST', `/market/reservations/${id}/cancel`, {}); if (r.status === 200) toast(t('mk_res_cancelled')); else fail(r); await route(); }
    catch (e) { toast(errText(e), true); busy(el, false); }
  }
}
export function marketChange(ev) {
  const sel = ev.target.closest('[data-act-change=mk-crop]'); if (!sel) return;
  const ref = formPrices.find((p) => p.crop === sel.value);
  $('[data-ref]', sel.closest('.mk-item')).textContent = ref ? t('mk_form_ref', { p: rand(ref.retailBuyerPricePerKg) }) : '';
}
export async function marketSubmit(ev, ctx) {
  const { toast, busy, errText } = ctx;
  const f = ev.target;
  if (f.id === 'mk-form') {
    const btn = $('button[type=submit]', f), id = f.dataset.id;
    busy(btn, true);
    try {
      const r = await api('POST', id ? `/market/events/${id}` : '/market/events', readForm(f));
      if (r.status === 200 || r.status === 201) { toast(t(r.body.status === 'rejected' ? 'mk_saved_bad' : 'mk_saved_ok'), r.body.status === 'rejected'); location.hash = `#/market/${r.body.eventId}`; return; }
      $('#mk-err').textContent = r.body.message || errText({ code: r.body.error });
    } catch (e) { toast(errText(e), true); } finally { busy(btn, false); }
    return true;
  }
  if (f.id === 'mk-res') {
    const btn = $('button[type=submit]', f);
    busy(btn, true);
    try {
      const body = { itemId: Number(f.item.value), buyerName: f.buyer.value.trim(), quantityKg: Number(f.kg.value) };
      const r = await api('POST', '/market/reservations', body);
      if (r.status === 201 && r.body.status === 'confirmed') { toast(t('mk_res_ok', { kg: body.quantityKg, name: body.buyerName })); await ctx.route(); return true; }
      const why = r.body.rejectReasons?.[0]?.message || r.body.message;
      toast(why || errText({ code: r.body.error }), true);
    } catch (e) { toast(errText(e), true); } finally { busy(btn, false); }
    return true;
  }
  return false;
}
export { closeMkSheet };
