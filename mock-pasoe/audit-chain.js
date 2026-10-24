// Audit hash chain, same formula as farm-api.p (fAuditHash):
//   RowHash = lower-case hex SHA-256 of PrevHash|AuditId|LoggedAt(ISO UTC, ms)|RequestId|Actor|Event|Detail
// Rows with an empty rowHash at the start of the log are "legacy" (written before 005-audit-chain.df).
import crypto from 'node:crypto';
import { iso } from './time.js';

export const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
export const auditHash = (prev, row) => sha256Hex([prev, row.auditId, iso(row.at), row.requestId, row.actor, row.event, row.detail].join('|'));

export function appendAudit(store, requestId, actor, event, detail, at) {
  const last = store.audit.length ? store.audit[store.audit.length - 1] : null;
  const row = { auditId: ++store.seq.audit, at, requestId: requestId || '', actor: actor || 'api', event, detail: (detail || '').slice(0, 4000) };
  row.prevHash = last ? (last.rowHash || '') : '';
  row.rowHash = auditHash(row.prevHash, row);
  store.audit.push(row);
  return row;
}

export function verifyAudit(store) {
  let prev = '', started = false, checked = 0, legacy = 0;
  for (const r of [...store.audit].sort((a, b) => a.auditId - b.auditId)) {
    if (!started && !r.rowHash) { legacy++; continue; }
    if (!started) { started = true; prev = r.prevHash || ''; }
    checked++;
    if ((r.prevHash || '') !== prev) return { ok: false, checked, legacy, firstBadId: r.auditId, reason: 'PREV_HASH_MISMATCH', headHash: '' };
    if (r.rowHash !== auditHash(r.prevHash || '', r)) return { ok: false, checked, legacy, firstBadId: r.auditId, reason: 'ROW_HASH_MISMATCH', headHash: '' };
    prev = r.rowHash;
  }
  return { ok: true, checked, legacy, firstBadId: null, reason: null, headHash: prev };
}
