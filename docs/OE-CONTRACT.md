# OpenEdge REST contract (internal: API service <-> OpenEdge)

The Node API never calculates farm numbers or decides what is allowed. It calls this contract. Two implementations exist:

| Implementation | Where | How it is reached |
|---|---|---|
| **ABL** `openedge/src/farm-api.p` (real OpenEdge database `farm`) | Windows laptop with OpenEdge 12.8 | run in batch (`scripts/oe-run.ps1`) or behind the PASOE WEB handler `openedge/src/web/FarmHandler.cls` at `/web/farm/*` |
| **mock-pasoe** `mock-pasoe/` (Node port of the same rules, in-memory data) | anywhere | in-process (`OE_MODE=mock`) or over HTTP (`npm run mock-pasoe`, then `OE_MODE=pasoe OE_BASE_URL=http://127.0.0.1:8820/web`) |

Both are tested with the same cases: `eval/oe-contract-cases.json` (the irrigation cases, including 1 intentional failure, plus co-op cases `CO01` to `CO76`). `eval/compare-oe.mjs` checks a batch results file or a live HTTP server. `--coop` keeps only the co-op cases. Co-op routes are implemented in `openedge/src/coop.i` (included by `farm-api.p`) and in `mock-pasoe/coop-handler.js`. The precise rules are in `docs/COOP.md`.

All paths below are relative to `/web` (e.g. `GET /web/farm/plots`). Bodies are JSON; errors are `{ "error": CODE, "message": text, "field"?: name }`.
Time values are ISO 8601 UTC with `Z` (`2026-10-23T08:06:00.000Z`). `asOf` (optional ISO string in a POST body) overrides "now" so tests are deterministic.

| Method and path | Purpose | Success |
|---|---|---|
| `GET /farm/plots` | list plots | `200 { plots: [...] }` |
| `GET /farm/plots/{id}` | one plot | `200 {plot}` or `404 PLOT_NOT_FOUND` |
| `GET /farm/plots/{id}/readings?limit=` | newest first | `200 { plotId, readings: [...] }` |
| `POST /farm/readings` | store a sensor reading | `201 { id }`, `400 VALIDATION_ERROR` (+`field`), `404 PLOT_NOT_FOUND`, `409 DUPLICATE_READING` |
| `POST /farm/validate` `{plotId, action, litres, asOf?}` | run the rules only (no write) | `200 { verdict, rejectReasons[], facts{} }` |
| `POST /farm/suggestions` `{plotId, action, litres, reason, provider, requestId, asOf?}` | run the rules and store the proposal | `201 {suggestion}` with `status` `pending_approval` or `rejected` |
| `GET /farm/suggestions?status=` / `GET /farm/suggestions/{id}` | read | `200` / `404 SUGGESTION_NOT_FOUND` |
| `POST /farm/suggestions/{id}/decision` `{decision: approve\|reject\|delete, actor, requestId, asOf?}` | farmer decision (approve re-runs the rules) | `200 {suggestion}`, `409 NOT_APPROVABLE` / `ALREADY_DECIDED` / `CANNOT_DELETE_APPROVED` |
| `POST /farm/audit` `{requestId, actor, event, detail}` / `GET /farm/audit?limit=` | audit trail | `201 { id }` / `200 { events }` |

## The rules (see docs/NOTES.md for thresholds)

`PLOT_NOT_FOUND`, `ACTION_NOT_ALLOWED`, `LITRES_OUT_OF_RANGE`, `NO_SENSOR_DATA`, `SENSOR_STALE`, `SOIL_NOT_DRY`, `RAIN_DETECTED`, `WATER_BUDGET_EXCEEDED`.
Only `irrigate` uses water: the litres checks and the 7-day budget sum apply to `irrigate` only, so a `hold` or `notify` that carries litres never counts against the budget. Timestamps (`timestamp`, `asOf`) must be real calendar dates.
Every failing rule is reported (not only the first), in that order, so the farmer sees all reasons.

## Database (openedge/schema)

`001-farm.df` (existing `Farm` table), `002-farm-ops.df`: `Plot`, `SensorReading`, `AiSuggestion`, `AuditLog` and sequences `ReadingSeq`, `SuggestionSeq`, `AuditSeq`.
`SensorReading` has a unique index on (`DeviceId`, `ReadAt`) which enforces the duplicate rule in the database itself.
`003-coop.df`: `Member`, `InputCredit`, `HarvestLot`, `LotContribution`, `BuyerContract`, `Allocation`, `Payout` and sequences `MemberSeq`, `CreditSeq`, `LotSeq`, `ContractSeq`, `AllocationSeq`, `PayoutSeq`.

## Co-op routes

Same host and the same `/farm` prefix. Money in JSON is Rand with two decimals. Quantities are whole kilograms. Create returns 201 with `facts` and stores `pending_approval` or `rejected`. Approve, reject and deliver are separate POSTs. The full list, the rule codes and the OpenEdge 12.8 steps are in `docs/COOP.md`.

| Method and path | Success |
|---|---|
| `GET /farm/members`, `GET /farm/members/{id}` | 200, or 404 `MEMBER_NOT_FOUND` |
| `GET /farm/credits`, `GET /farm/credits/{id}`, `POST /farm/credits`, `POST /farm/credits/{id}/decision` | 200 / 201, or 404 / 409 |
| `GET /farm/lots`, `GET /farm/lots/{id}`, `POST /farm/lots/{id}/fair-allocation` | 200 plan, or 201 when `commit` is true |
| `GET /farm/contracts`, `GET /farm/contracts/{id}` | 200, or 404 `CONTRACT_NOT_FOUND` |
| `GET /farm/allocations`, `GET /farm/allocations/{id}`, `POST /farm/allocations`, `POST /farm/allocations/{id}/decision` | 200 / 201, or 404 / 409. `decision` is `approve`, `reject` or `deliver` |
| `GET /farm/payouts`, `GET /farm/payouts/{id}`, `POST /farm/payouts`, `POST /farm/payouts/{id}/decision` | 200 / 201, or 404 / 409 |
