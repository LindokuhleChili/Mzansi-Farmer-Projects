// Farm Assistant (docs/ASSISTANT.md). The farmer chats in their language; the assistant answers "let me check" first, then
// shows what it checked (each tool it used), a reply that cites the farming guides stored in OpenEdge, and approval cards.
// Nothing changes on the farm until the farmer approves a card. Irrigation cards go through the OpenEdge rules first and
// use the normal two-step approval on the suggestion page; a card the rules rejected is final. Never chemical doses.
import { html, icon, fmtDateTime, fmtDayNoYear } from './util.js';
import { t, tx, getLang } from './i18n.js';
import { api } from './api.js';
import { lvl } from './views.js';

const cstate = { msgs: [], after: 0, inbox: [] };   // this tab only; the case files themselves are kept in OpenEdge
const CONF = { low: 'o', medium: 'w', high: 'n' };
const STATUS = { proposed: 'w', accepted: 'n', declined: 'o', rejected: 'o', approved: 'n', pending_approval: 'w' };
const short = (s) => String(s || '').replace(/^Wikipedia: /, '');

const cite = (c) => html`<li id="as-src-${c.passageId}"><b>[${c.passageId}]</b> ${short(c.sourceTitle)}, ${c.section}. <a href="${c.sourceUrl}" target="_blank" rel="noopener">${t('as_source')}</a> · ${c.licence}</li>`;
const sources = (list) => (list?.length ? html`<details class="as-src"><summary>${t('as_sources', { n: list.length })}</summary><ul>${list.map(cite)}</ul><p class="xs mut">${t('as_src_note')}</p></details>` : '');
const checked = (steps) => (steps?.length ? html`<details class="as-checked"><summary>${icon('check', 14)}${t('as_checked', { n: steps.length })}</summary><ol>${steps.map((s) => html`<li><code>${s.tool || s.kind}</code> ${tx(s.summary || s.text)}</li>`)}</ol></details>` : '');

export function actionCard(c) {
  const st = c.verdict === 'rejected_by_rules' ? 'rejected' : c.status;
  const nums = (c.citations || []).map((n) => `[${n}]`).join(' ');
  let act = '';
  if (c.suggestionId) {
    act = st === 'rejected'
      ? html`<div class="as-rej"><b>${t('as_rejected')}</b><ul>${(c.rejectReasons || []).map((r) => html`<li>${t('r_' + r)} <span class="xs mut">${r}</span></li>`)}</ul><span class="xs mut">${t('as_rejected_final')}</span></div>`
      : html`<a class="btn dk sm" href="#/suggestions/${c.suggestionId}">${t('as_review')}</a>`;
  } else if (c.status === 'proposed') {
    act = html`<div class="row g8 wrap"><button class="btn dk sm" data-act="as-accept" data-case="${c.caseId}" data-n="${c.actionNo}">${t('as_accept')}</button><button class="btn out sm" data-act="as-decline" data-case="${c.caseId}" data-n="${c.actionNo}">${t('as_decline')}</button>
      ${c.kind === 'list_harvest_day' ? html`<a class="btn out sm" href="#/market">${t('as_open_market')}</a>` : ''}</div>`;
  }
  return html`<div class="as-card">
    <div class="row sp g8"><span class="lbl">${t('as_kind_' + c.kind) !== 'as_kind_' + c.kind ? t('as_kind_' + c.kind) : c.kind}</span>${lvl(STATUS[st] || 'w', '', t('as_st_' + st))}</div>
    <p class="sm">${tx(c.text)} <span class="xs mut">${nums}</span></p>
    ${c.cost ? html`<span class="dr-cost ${c.cost}">${t('dr_cost_' + c.cost) !== 'dr_cost_' + c.cost ? t('dr_cost_' + c.cost) : c.cost}</span>` : ''}
    <div style="margin-top:8px">${act}</div></div>`;
}

function bubble(m) {
  if (m.who === 'me') return html`<div class="as-msg me"><p>${m.text}</p></div>`;
  if (m.ack) return html`<div class="as-msg bot ack"><p>${t('as_ack')}</p></div>`;
  const r = m.res;
  return html`<div class="as-msg bot">
    ${r.usedFallback ? html`<div class="dr-note">${icon('x', 14)}<span>${t('as_offline')}</span></div>` : ''}
    ${checked(r.steps)}
    <p>${tx(r.reply)}</p>
    ${r.cards?.length ? html`<div class="as-cards">${r.cards.map(actionCard)}</div>` : ''}
    ${sources(r.citations)}
    ${r.case ? html`<a class="xs" href="#/assistant/${r.case.caseId}">${icon('book', 13)} ${t('as_open_case', { id: r.case.caseId })}</a>` : ''}
    <p class="xs mut">${t('as_honest')}</p></div>`;
}

function watchCards(list) {
  const open = list.filter((c) => String(c.provider || '').startsWith('farm-watch') && c.status === 'open');
  if (!open.length) return '';
  const kind = (a) => (t('as_kind_' + a.kind) !== 'as_kind_' + a.kind ? t('as_kind_' + a.kind) : a.kind);
  const st = (a) => (t('as_st_' + (a.status || 'proposed')) !== 'as_st_' + (a.status || 'proposed') ? t('as_st_' + (a.status || 'proposed')) : (a.status || 'proposed'));
  return html`<div class="card pad"><div class="lbl" style="margin-bottom:6px">${t('as_watch')}</div><p class="xs mut">${t('as_watch_wait')}</p>
    ${open.map((c) => html`<a class="as-card as-watch" href="#/assistant/${c.caseId}"><b>${tx(c.title)}</b><p class="sm">${tx(c.likelyCause)}</p><span class="xs mut">${(c.actions || []).slice(0, 2).map((a) => `${kind(a)} · ${st(a)}`).join(' · ')}</span></a>`)}</div>`;
}
export async function assistantPage(alive, renderChrome, draw, viewEl, need) {
  renderChrome('assistant');
  const [cases, ins] = await Promise.all([api('GET', '/assistant/cases?limit=8'), api('GET', `/assistant/check-ins?after=0`)]);
  if (!alive()) return;
  const list = need(cases).cases || [];
  cstate.inbox = need(ins).messages || [];
  draw(viewEl, html`<div class="pg">
    <div class="pagehead"><div><h1>${t('as_title')}</h1><div class="sub">${t('as_sub')}</div></div></div>
    <div class="as-layout">
      <div class="card pad as-chat">
        <div class="as-log" id="as-log" aria-live="polite">
          ${cstate.msgs.length ? cstate.msgs.map(bubble) : html`<div class="as-msg bot"><p>${t('as_hello')}</p></div>`}
        </div>
        <div class="as-quick">${['as_q_dry', 'as_q_spots', 'as_q_frost'].map((k) => html`<button class="dr-chip" data-act="as-quick" data-q="${t(k)}">${t(k)}</button>`)}</div>
        <form id="as-form" class="row g8" novalidate>
          <input name="msg" type="text" maxlength="1000" autocomplete="off" aria-label="${t('as_input')}" placeholder="${t('as_input')}" style="flex:1">
          <button class="btn dk" type="submit">${icon('spark', 16)}${t('as_send')}</button></form>
        <p class="xs mut">${t('as_nodose')}</p>
      </div>
      <div class="as-side">
        <div class="card pad"><div class="lbl" style="margin-bottom:6px">${t('as_inbox')}</div>
          ${cstate.inbox.length ? cstate.inbox.slice().reverse().map((m) => html`<div class="as-in"><span class="sm">${tx(m.text)}</span><span class="xs mut">${fmtDateTime(m.at)}</span>
            ${m.caseId ? html`<a class="xs" href="#/assistant/${m.caseId}">${t('as_open_case', { id: m.caseId })}</a>` : html`<button class="btn out sm" data-act="as-quick" data-q="${m.text}">${t('as_ask_this')}</button>`}</div>`)
            : html`<p class="sm mut">${t('as_inbox_none')}</p>`}</div>
        ${watchCards(list)}
        <div class="card pad"><div class="lbl" style="margin-bottom:6px">${t('as_cases')}</div>
          ${list.length ? list.map((c) => html`<a class="kv as-caserow" href="#/assistant/${c.caseId}"><span><b>${tx(c.title)}</b><span class="xs mut"> · ${fmtDayNoYear(c.createdAt)}</span></span><span class="xs mut">${t('as_case_' + c.status)}</span></a>`)
            : html`<p class="sm mut">${t('as_cases_none')}</p>`}</div>
      </div>
    </div></div>`);
  document.getElementById('as-log')?.lastElementChild?.scrollIntoView({ block: 'nearest' });
}

export async function casePage(id, alive, renderChrome, draw, viewEl, need) {
  renderChrome('assistant');
  const c = need(await api('GET', `/assistant/cases/${id}`));
  if (!alive()) return;
  const cards = c.actions.map((a) => ({ ...a, caseId: c.caseId }));
  const due = c.followUps.find((f) => f.status === 'due');
  draw(viewEl, html`<div class="pg">
    <div class="pagehead"><div><a class="xs" href="#/assistant">${t('as_back')}</a><h1>${tx(c.title)}</h1><div class="sub">${t('as_case_no', { id: c.caseId })} · ${fmtDateTime(c.createdAt)} · ${t('as_case_' + c.status)}</div></div></div>
    <div class="as-layout">
      <div class="card pad">
        <div class="row sp wrap g8"><div class="lbl">${t('as_likely')}</div>${lvl(CONF[c.confidence] || 'w', '', t('dr_conf_' + c.confidence))}</div>
        <p class="sm">${tx(c.likelyCause)} <span class="xs mut">${c.causeCitations.map((n) => `[${n}]`).join(' ')}</span></p>
        ${c.usedFallback ? html`<p class="xs mut">${t('as_offline')}</p>` : ''}
        <div class="lbl" style="margin-top:12px">${t('as_actions')}</div>
        <div class="as-cards">${cards.map(actionCard)}</div>
        ${sources(c.citations)}
        <p class="xs mut">${t('as_nodose')}</p>
      </div>
      <div class="as-side">
        <div class="card pad"><div class="lbl" style="margin-bottom:6px">${t('as_followups')}</div>
          ${c.followUps.map((f) => html`<div class="as-in"><span class="sm"><b>${tx(f.question)}</b></span><span class="xs mut">${t('as_due', { d: fmtDayNoYear(f.dueAt) })} · ${t('as_fu_' + f.status)}</span>${f.answer ? html`<span class="sm">${f.answer}</span>` : ''}</div>`)}
          ${due && c.status === 'open' ? html`<form id="as-fu-form" data-case="${c.caseId}" data-fu="${due.followUpId}" novalidate>
            <div class="field"><label for="as-fu">${t('as_fu_answer')}</label><input id="as-fu" name="answer" type="text" maxlength="300"></div>
            <label class="row g8 sm"><input type="checkbox" name="resolved"> ${t('as_fu_resolved')}</label>
            <button class="btn dk sm" type="submit" style="margin-top:8px">${t('as_fu_send')}</button></form>` : ''}</div>
        <div class="card pad">${checked(c.evidence)}</div>
      </div>
    </div></div>`);
}

export async function assistantSubmit(ev, { route, toast, busy, errText }) {
  const f = ev.target;
  if (f.id === 'as-fu-form') {
    ev.preventDefault();
    const r = await api('POST', `/assistant/cases/${f.dataset.case}/follow-ups/${f.dataset.fu}/answer`, { answer: f.answer.value.trim() || '-', resolved: f.resolved.checked });
    if (r.status === 200) { toast(t('as_fu_saved')); await route(); } else toast(errText({ code: r.body?.error, message: r.body?.message }), true);
    return true;
  }
  if (f.id !== 'as-form') return false;
  ev.preventDefault();
  await send(f.msg.value, { route, toast, busy, errText, btn: f.querySelector('button[type=submit]') });
  return true;
}
async function send(text, { route, toast, busy, errText, btn }) {
  const msg = String(text || '').trim();
  if (!msg) return;
  const history = cstate.msgs.filter((m) => !m.ack).slice(-6).map((m) => (m.who === 'me' ? { role: 'user', text: m.text } : { role: 'assistant', text: m.res.reply }));
  cstate.msgs.push({ who: 'me', text: msg }, { who: 'bot', ack: true });
  await route();                                          // the quick "let me check" bubble shows straight away
  if (btn) busy(document.querySelector('#as-form button[type=submit]'), true, t('as_checking'));
  try {
    const r = await api('POST', '/assistant/chat', { message: msg, lang: getLang(), history });
    cstate.msgs = cstate.msgs.filter((m) => !m.ack);
    if (r.status === 200) cstate.msgs.push({ who: 'bot', res: r.body });
    else toast(errText({ code: r.body?.error, message: r.body?.message }), true);
  } catch (e) { cstate.msgs = cstate.msgs.filter((m) => !m.ack); toast(errText(e), true); }
  await route();
}
export async function assistantClick(a, el, { route, toast, busy, errText }) {
  if (a === 'as-quick') return send(el.dataset.q, { route, toast, busy, errText });
  busy(el, true);
  try {
    const r = await api('POST', `/assistant/cases/${el.dataset.case}/actions/${el.dataset.n}/${a === 'as-accept' ? 'accept' : 'decline'}`, {});
    if (r.status === 200) {
      toast(t(a === 'as-accept' ? 'as_accepted' : 'as_declined'));
      for (const m of cstate.msgs) for (const c of m.res?.cards || []) if (c.caseId === Number(el.dataset.case) && c.actionNo === Number(el.dataset.n)) c.status = a === 'as-accept' ? 'accepted' : 'declined';
    } else toast(errText({ code: r.body?.error, message: r.body?.message }), true);
    await route();
  } catch (e) { toast(errText(e), true); busy(el, false); }
}
