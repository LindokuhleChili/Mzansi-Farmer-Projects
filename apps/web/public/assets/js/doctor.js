// Plant doctor (docs/DOCTOR.md). The farmer adds up to 3 photos plus crop, plant part, growth stage and province.
// The AI proposes a likely condition; the server and OpenEdge (rule DOSE_BLOCKED) make sure no chemical dose is ever shown;
// the farmer saves the answer to the farm record or dismisses it. Photos are shrunk here and never stored.
import { html, icon, fmtDayNoYear } from './util.js';
import { t, tx } from './i18n.js';
import { api } from './api.js';
import { lvl } from './views.js';

const HERO = '/assets/photos/plant-doctor-tomato-fruit.jpg';
const MAX_PHOTOS = 3, MAX_SIDE = 1280;
const PARTS = ['leaf', 'stem', 'fruit', 'root', 'flower', 'whole_plant'];
const STAGES = ['seedling', 'vegetative', 'flowering', 'fruiting', 'mature'];
const PROVINCES = ['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'];
const CROPS = ['Tomato', 'Maize', 'Beans', 'Spinach', 'Cabbage', 'Potato', 'Pepper', 'Other'];
const CONF = { low: 'o', medium: 'w', high: 'n' };
const RISK = { low: 'n', medium: 'w', high: 'o' };
const dstate = { photos: [], last: null };

function resultCard(d, extra = {}) {
  return html`<div class="card pad dr-result" id="dr-result">
    <div class="row sp wrap g8"><div><div class="lbl">${t('dr_likely')}</div><h2 class="dr-cond">${tx(d.condition)}</h2></div>${lvl(CONF[d.confidence] || 'w', '', t('dr_conf_' + d.confidence))}</div>
    ${d.usedFallback ? html`<div class="dr-note">${icon('x', 14)}<span>${t('dr_fb_' + (d.fallbackReason || 'ai_unavailable')) !== 'dr_fb_' + (d.fallbackReason || 'ai_unavailable') ? t('dr_fb_' + d.fallbackReason) : t('dr_fb_ai_unavailable')}</span></div>` : ''}
    ${extra.removedSteps ? html`<p class="xs mut">${t('dr_removed', { n: extra.removedSteps })}</p>` : ''}
    <p class="sm" style="margin:8px 0 12px">${tx(d.observations)}</p>
    <div class="lbl">${t('dr_steps')}</div>
    <ol class="dr-steps">${d.steps.map((s) => html`<li><span>${tx(s.text)}</span><span class="dr-cost ${s.cost}">${t('dr_cost_' + s.cost)}</span></li>`)}</ol>
    <div class="dr-grid">
      <div><div class="lbl">${t('dr_monitor')}</div><ul class="dr-ul">${d.monitor.map((m) => html`<li>${tx(m)}</li>`)}</ul></div>
      <div><div class="lbl">${t('dr_risk')}</div><div class="row g8" style="margin:6px 0">${lvl(RISK[d.neighbourRisk.level] || 'w', '', t('dr_risk_' + d.neighbourRisk.level))}</div><p class="xs">${tx(d.neighbourRisk.reason)}</p></div>
    </div>
    <div class="dr-expert"><div class="lbl">${t('dr_expert')}</div><p class="sm">${tx(d.callExpert)}</p></div>
    <p class="xs mut">${t('dr_nodose')}</p>
    ${d.status === 'pending_review' ? html`<div class="row g8 wrap" style="margin-top:12px"><button class="btn dk" data-act="dr-save" data-id="${d.diagnosisId}">${t('dr_save')}</button><button class="btn out" data-act="dr-dismiss" data-id="${d.diagnosisId}">${t('dr_dismiss')}</button></div>`
      : html`<p class="xs mut" style="margin-top:10px">${t('dr_st_' + d.status)}</p>`}
  </div>`;
}
const opt = (v, label, sel) => html`<option value="${v}" ${sel ? 'selected' : ''}>${label}</option>`;

export async function doctorPage(alive, renderChrome, draw, viewEl, need) {
  renderChrome('doctor');
  const [hist, terms] = await Promise.all([api('GET', '/doctor/diagnoses?limit=5'), api('GET', '/doctor/blocked-terms')]);
  if (!alive()) return;
  const list = need(hist).diagnoses || [];
  const words = need(terms).terms || [];
  draw(viewEl, html`<div class="pg">
    <div class="pagehead"><div><h1>${t('dr_title')}</h1><div class="sub">${t('dr_sub')}</div></div></div>
    <div class="mk-hero" style="background-image:url(${HERO})" role="img" aria-label="Tomato leaf with dark spots (early blight)">
      <div class="mk-hero-t"><b>${t('dr_hero')}</b><span>${t('dr_hero_sub')}</span></div></div>
    <p class="xs mut dr-credit">${t('dr_photo_credit')} Michal Maňas, <a href="https://commons.wikimedia.org/wiki/File:Alternaria_solani_on_Solanum_lycopersicum.jpg" target="_blank" rel="noopener">Wikimedia Commons</a>, CC BY 4.0</p>
    <div class="dr-layout">
      <form id="dr-form" class="card pad" novalidate>
        <div class="lbl" style="margin-bottom:8px">${t('dr_ask')}</div>
        <div class="field"><label for="dr-photos">${t('dr_photos', { n: MAX_PHOTOS })}</label>
          <input id="dr-photos" name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple capture="environment" data-act="dr-photos"></div>
        <div class="dr-thumbs" id="dr-thumbs">${dstate.photos.map((p) => html`<img src="${p.preview}" alt="">`)}</div>
        <div class="dr-fields">
          <div class="field"><label for="dr-crop">${t('dr_crop')}</label><select id="dr-crop" name="crop">${CROPS.map((c) => opt(c, tx(c), c === 'Tomato'))}</select></div>
          <div class="field"><label for="dr-part">${t('dr_part')}</label><select id="dr-part" name="part">${PARTS.map((p) => opt(p, t('dr_part_' + p), p === 'leaf'))}</select></div>
          <div class="field"><label for="dr-stage">${t('dr_stage')}</label><select id="dr-stage" name="stage">${STAGES.map((s) => opt(s, t('dr_stage_' + s), s === 'fruiting'))}</select></div>
          <div class="field"><label for="dr-prov">${t('dr_province')}</label><select id="dr-prov" name="province">${PROVINCES.map((p) => opt(p, p, p === 'KwaZulu-Natal'))}</select></div>
        </div>
        <p class="xs mut">${t('dr_privacy')}</p>
        <button class="btn dk block" type="submit">${icon('spark', 16)}${t('dr_check')}</button>
      </form>
      <div id="dr-out">${dstate.last ? resultCard(dstate.last.diagnosis, dstate.last) : html`<div class="card pad"><p class="empty">${t('dr_empty')}</p></div>`}</div>
    </div>
    <div class="dr-layout" style="margin-top:14px">
      <div class="card pad"><div class="lbl" style="margin-bottom:6px">${t('dr_history')}</div>
        ${list.length ? list.map((d) => html`<div class="kv"><span><b>${tx(d.condition)}</b><span class="xs mut"> · ${tx(d.crop)} · ${fmtDayNoYear(d.createdAt)}${d.usedFallback ? ' · ' + t('dr_fallback_tag') : ''}</span></span><span class="xs mut">${t('dr_st_' + d.status)}</span></div>`)
          : html`<p class="sm mut">${t('dr_history_none')}</p>`}</div>
      <details class="card pad dr-words"><summary class="lbl">${t('dr_words', { n: words.filter((w) => w.active).length })}</summary>
        <p class="xs mut" style="margin:6px 0">${t('dr_words_hint')}</p>
        <div class="dr-chips">${words.map((w) => html`<button class="dr-chip ${w.kind}${w.active ? '' : ' off'}" data-act="dr-term" data-id="${w.termId}" data-active="${String(w.active)}" title="${t(w.active ? 'dr_word_off' : 'dr_word_on')}">${w.term}</button>`)}</div>
        <form id="dr-term-form" class="row g8 wrap" style="margin-top:10px" novalidate>
          <input name="term" type="text" maxlength="40" aria-label="${t('dr_word_new')}" placeholder="${t('dr_word_new')}">
          <select name="kind" aria-label="${t('dr_word_kind')}"><option value="chemical">${t('dr_kind_chemical')}</option><option value="dose">${t('dr_kind_dose')}</option></select>
          <button class="btn out sm" type="submit">${t('dr_word_add')}</button></form>
      </details>
    </div></div>`);
}

function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.82);
      URL.revokeObjectURL(url);
      resolve({ mimeType: 'image/jpeg', dataBase64: dataUrl.split(',')[1], preview: dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}
export async function doctorChange(ev, { toast }) {
  if (ev.target.dataset?.act !== 'dr-photos') return false;
  const files = [...ev.target.files].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
  if (ev.target.files.length > MAX_PHOTOS) toast(t('dr_too_many', { n: MAX_PHOTOS }), true);
  if (files.length < ev.target.files.length) toast(t('dr_bad_type'), true);
  try { dstate.photos = await Promise.all(files.slice(0, MAX_PHOTOS).map(shrink)); } catch { dstate.photos = []; toast(t('dr_bad_type'), true); }
  const th = document.getElementById('dr-thumbs');
  if (th) th.innerHTML = dstate.photos.map((p) => `<img src="${p.preview}" alt="">`).join('');
  return true;
}
export async function doctorSubmit(ev, { route, toast, busy, errText }) {
  const f = ev.target;
  if (f.id === 'dr-term-form') {
    ev.preventDefault();
    const r = await api('POST', '/doctor/blocked-terms', { term: f.term.value, kind: f.kind.value });
    if (r.status === 201) { toast(t('dr_word_added')); await route(); } else toast(errText({ code: r.body?.error, message: r.body?.message }), true);
    return true;
  }
  if (f.id !== 'dr-form') return false;
  ev.preventDefault();
  if (!dstate.photos.length) { toast(t('dr_need_photo'), true); return true; }
  const btn = f.querySelector('button[type=submit]'); busy(btn, true, t('dr_checking'));
  try {
    const r = await api('POST', '/doctor/diagnoses', { crop: f.crop.value, plantPart: f.part.value, growthStage: f.stage.value, province: f.province.value,
      photos: dstate.photos.map(({ mimeType, dataBase64 }) => ({ mimeType, dataBase64 })) });
    if (r.status === 201) { dstate.last = r.body; await route(); document.getElementById('dr-result')?.scrollIntoView({ block: 'start' }); }
    else { toast(errText({ code: r.body?.error, message: r.body?.message }), true); busy(btn, false); }
  } catch (e) { toast(errText(e), true); busy(btn, false); }
  return true;
}
export async function doctorClick(a, el, { route, toast, busy, errText }) {
  const id = Number(el.dataset.id);
  busy(el, true);
  try {
    let r;
    if (a === 'dr-save' || a === 'dr-dismiss') {
      r = await api('POST', `/doctor/diagnoses/${id}/${a === 'dr-save' ? 'save' : 'dismiss'}`, {});
      if (r.status === 200) { if (dstate.last?.diagnosis?.diagnosisId === id) dstate.last.diagnosis = r.body; toast(t(a === 'dr-save' ? 'dr_saved' : 'dr_dismissed')); }
    } else if (a === 'dr-term') {
      r = await api('POST', `/doctor/blocked-terms/${id}`, { active: el.dataset.active !== 'true' });
      if (r.status === 200) toast(t(r.body.active ? 'dr_word_turned_on' : 'dr_word_turned_off'));
    }
    if (r && r.status >= 400) toast(errText({ code: r.body?.error, message: r.body?.message }), true);
    await route();
  } catch (e) { toast(errText(e), true); busy(el, false); }
}
