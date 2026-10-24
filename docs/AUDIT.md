# Tamper-evident audit log (feature 21: hash chain)

Every row OpenEdge writes to `AuditLog` (tool calls, rule checks, farmer decisions, co-op and market events) is chained:

```
RowHash = SHA-256 hex( PrevHash | AuditId | LoggedAt (ISO 8601 UTC, ms) | RequestId | Actor | Event | Detail )
PrevHash = RowHash of the row before it ("" for the first chained row)
```

- **Where:** `openedge/src/farm-api.p` (`fAuditHash`, procedure `audit`, `h-verify-audit`) using the built-in
  `MESSAGE-DIGEST("SHA-256", ...)`. The writer locks the current last row (`EXCLUSIVE-LOCK`) so two writers cannot fork the chain.
  `mock-pasoe/audit-chain.js` uses the same formula (Node `crypto`).
- **Schema:** `openedge/schema/005-audit-chain.df` adds `PrevHash` and `RowHash` (x(64)) to `AuditLog`.
- **Verify:** `GET /farm/audit/verify` (OpenEdge) and `GET /api/v1/audit/verify` (API, bearer token) walk the log oldest first:
  `{ ok, checked, legacy, firstBadId, reason, headHash }`. `reason` is `ROW_HASH_MISMATCH` (a row's content was changed) or
  `PREV_HASH_MISMATCH` (a row was deleted, inserted or re-hashed). Rows written before 005 have no hash and are counted as `legacy`.
- **UI:** the Audit log page shows a flat "Tamper check" card (intact / broken at event #N / not available yet). Its text goes
  through the 11-language translation like every other screen string.
- **List:** `GET /farm/audit` rows now also carry `prevHash` and `rowHash`.

## Tests
- Contract cases AUD03-AUD05 (mock-pasoe and real ABL): hashes are 64 hex chars and linked; verify is ok, also after every other case.
- `eval/audit-chain.test.mjs`: editing detail / actor / event / time is caught; a re-hashed edit or a deleted row breaks the next
  link; legacy rows; the API route; a parity constant.
- `openedge/src/audit-tamper-test.p` (run by `oe-run.ps1 -Action scratch-test`, **scratch database only**, it refuses any other
  database): ABL SHA-256 equals the Node value for the same string, the chain verifies, a directly edited `Detail` is reported at
  that row, and restoring it makes the chain verify again.

## Limits
- It is tamper-*evident*, not tamper-proof: someone with database access could rewrite every hash from the edited row onwards.
  Publishing or saving the `headHash` somewhere else (for example in the demo notes) makes that detectable too.
- Characters outside ASCII are hashed in the session code page on ABL and UTF-8 on Node, so ABL and mock hashes of the same
  non-ASCII text can differ. Each side only verifies its own rows, so this does not cause false alarms.

## Loading it into the live demo database
Needs the database server **stopped**, then restarted (your OK first):
```
.\scripts\oe-run.ps1 -Action stop-db
.\scripts\oe-run.ps1 -Action load-audit-chain
.\scripts\oe-run.ps1 -Action start-db
```
then restart PASOE `farmops` so it recompiles `farm-api.p`. **Until 005 is loaded, `farm-api.p` from this branch does not
compile against the live database** (it uses the new fields), so do not point PASOE at this branch before loading it.
Existing rows stay as `legacy`; new rows are chained.
