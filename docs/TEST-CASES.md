# Test cases: Mzansi Farmer Ops (organiser list, 20 cases)

Prepared 2026-10-23 (Africa/Johannesburg) by the QA review. Fictional data only. Submission deadline: Wed 28 Oct 2026, 14:00.

**Required types.** Intentional failure: **TC-02** (marked `INTENTIONAL FAILURE`). Human approval: **TC-04** (marked `HUMAN APPROVAL`). TC-19 also covers the two-step confirmation.

**Status key** (only what was actually verified on 2026-10-23, offline, mock AI, `mock-pasoe` standing in for OpenEdge):
- `Pass (npm test)`: the mapped eval case passed in `npm test` (184 passed, 0 failed, 3 intentional failures confirmed, exit 0, after the BUG-1/2/3 fixes; the report below was written at 146).
- `Pass (probe)`: checked by a throw-away script (`/tmp/qa/probe.mjs`, `/tmp/qa/probe2.mjs` on the box, outside the repo) that drives `buildApp()` in-process with `OE_MODE=mock`. Not part of `npm test`.
- `Fail`: the system behaves differently from the expected result: a bug (see BUG ids at the bottom).
- `Not run`: not executed. **Nothing was run against real OpenEdge/PASOE or real Gemini by QA**, so ABL behaviour is only known by code reading and from NOTES.md's claim that the original 47 contract cases agree on both. The 14 contract cases added with the bug fixes (BUD01-06, DATE01-08) must still be run on real OpenEdge (see docs/NOTES.md section 6).

Eval ids: `OE` contract suite = `eval/oe-contract-cases.json` (OE/RULE/READ/SUG/AUD/MISC/FAIL), `DEV` = `eval/device-cases.json`, `E` = `eval/api-cases.json`.

## Summary

| ID | Title | Category | Mapped eval | Status |
|---|---|---|---|---|
| TC-01 | End-to-end happy path | Happy path | DEV04, E03, E05, E07, E19 | Pass (npm test) |
| TC-02 | **INTENTIONAL FAILURE**: approval without confirmation asserted to succeed | Intentional failure | E20, FAIL01 | Pass (fails as designed, confirmed by npm test) |
| TC-03 | AI proposal that breaks an ABL rule is rejected with reason | Negative / rules | E04, RULE04, RULE03, SUG02 | Pass (npm test) |
| TC-04 | **HUMAN APPROVAL**: action stays pending until the farmer confirms | Human approval | E03, E05, E07 | Pass (npm test + probe) |
| TC-05 | Decline leaves state unchanged | Human approval | E16, SUG08 | Pass (npm test + probe) |
| TC-06 | Stale sensor data blocks irrigation (15/16 min boundary) | Stale data | RULE05, RULE13, E10 | Pass (npm test + probe) |
| TC-07 | Reading goes stale or changes between advice and approval | Stale data | SUG12 (budget only), none for stale/wet | Pass (probe) |
| TC-08 | Out-of-range sensor values | Out-of-range | DEV06, READ03 | Pass (npm test + probe) |
| TC-09 | Malformed or missing fields, wrong types, wrong units | Malformed | DEV07, DEV11, READ04, READ05 | Pass (probe) |
| TC-10 | Impossible calendar date (31 Feb) is rejected | Malformed | DATE01-08, DEV13-17, `eval/fixes.test.mjs` | Pass after fix (BUG-3) |
| TC-11 | Duplicate deviceId + timestamp gives 409 | Duplicate | DEV05, READ02 | Pass (npm test + probe) |
| TC-12 | Bad model output (non-JSON, empty, null, fenced, trailing text) | Bad model output | E13 | Pass (npm test + probe) |
| TC-13 | Unknown/forbidden action, extra fields, hallucinated plot id | Bad model output | E14, RULE09, RULE11, E11 | Pass (npm test + probe) |
| TC-14 | hold/notify with non-zero litres must not be approvable or spend water budget | Bad model output | BUD01-06, E21, E22, `eval/fixes.test.mjs` | Pass after fix (BUG-1) |
| TC-15 | AI timeout falls back, rules still decide | Timeout | E12 (simulated only) | Pass (npm test + probe, real 8 s hang) |
| TC-16 | OpenEdge timeout/outage gives a clear error, within the documented 5 s | Timeout | `eval/fixes.test.mjs` | Pass after fix (BUG-2) |
| TC-17 | Empty results (no readings, no matches, unknown plot) | Empty results | E11, SUG16 | Pass (npm test + probe) |
| TC-18 | Unapproved delete is blocked; approved suggestion cannot be deleted | Unapproved delete | E17, E18, SUG14, SUG15 | Pass (npm test + probe) |
| TC-19 | Confirmation token misuse (wrong, expired, reused, other action/id, null) | Human approval / security | E06, E08 | Pass (npm test + probe) |
| TC-20 | Audit trail records approvals, decisions and tool calls | Audit | E19, AUD01, AUD02 | Pass (npm test + probe); see note on denied attempts |

Count: 20 cases. 16 map to existing eval cases; TC-07 maps only partly (SUG12, budget change); 3 have no mapping (TC-10, TC-14, TC-16). Several steps inside TC-07/08/09/12/13/17/18/19 go beyond the eval files and were checked by probe only. Pass: 17, Fail: 3, Not run: 0.

---

## TC-01 End-to-end happy path
- **Category:** Happy path
- **Preconditions:** seeded data (`referenceTime` 2026-10-23T08:10:00Z), `OE_MODE=mock`, `AI_PROVIDER=mock` (normal), valid device token and app token.
- **Steps / input:** (1) `POST /api/v1/readings` with `X-Device-Token` and `{deviceId:"esp32-01",plotId:1,timestamp:"2026-10-23T08:09:00Z",soilMoisturePct:17,temperatureC:29.4,humidityPct:50}`. (2) `POST /api/v1/plots/1/advise {"lang":"en"}`. (3) `POST /api/v1/suggestions/4/approve {}` then repeat with the returned `confirmToken`. (4) `GET /api/v1/audit?limit=500`.
- **Expected:** (1) 201 with id. (2) 200, `status: pending_approval`, `verdict: approved_by_rules`, `proposal` irrigate 270 L, `facts` from OpenEdge (soil 17, age 1 min), `ai.usedFallback:false`. (3) first call 202 `CONFIRMATION_REQUIRED` + `cfm_...` token; second call 200 `status: approved`. (4) audit contains `suggestion_approved`.
- **Mapped eval:** DEV04, E03, E05, E07, E19
- **Status:** Pass (npm test)

## TC-02 INTENTIONAL FAILURE: approval without confirmation asserted to succeed
- **Category:** Intentional failure (expected-to-fail / negative)
- **Preconditions:** pending suggestion exists (E13 creates suggestion 8).
- **Steps / input:** `POST /api/v1/suggestions/8/approve {}` with the app token, asserting HTTP 200 and `status: approved`.
- **Expected:** the **assertion fails by design**. The API returns 202 `CONFIRMATION_REQUIRED` (no approval without the confirmation step), so the runner must report this case as an intentional failure and must not count it as a pass or crash. A second intentional failure exists at the OpenEdge layer: FAIL01 asserts a wet plot is `approved_by_rules`, but the rules return `rejected_by_rules`.
- **Mapped eval:** E20 (API, run twice: `oe=mock` and `oe=pasoe-mock`), FAIL01 (OE contract)
- **Status:** Pass (npm test): output `FAIL (intentional, as designed) E20: status: expected 200, got 202` and `FAIL01: $.verdict: expected "approved_by_rules", got "rejected_by_rules"`; summary `3 intentional failures confirmed, 0 unexpected passes`.

## TC-03 AI proposal that breaks an ABL rule is rejected with a reason
- **Category:** Negative / rule validation
- **Preconditions:** `AI_MOCK_BEHAVIOUR=greedy` (model proposes the plot maximum regardless of data); plot 2 soil is 62% (dry threshold 40%).
- **Steps / input:** `POST /api/v1/plots/2/advise {"lang":"en"}`; then `POST /api/v1/suggestions/5/approve {}`.
- **Expected:** 200, `status: rejected`, `verdict: rejected_by_rules`, `rejectReasons` contains `SOIL_NOT_DRY`. Every failing rule is listed (RULE03: 501 L gives both `LITRES_OUT_OF_RANGE` and `WATER_BUDGET_EXCEEDED`). Approving the rejected suggestion gives 409 `NOT_APPROVABLE`.
- **Mapped eval:** E04, E09, RULE03, RULE04, RULE08, SUG02, SUG03
- **Status:** Pass (npm test)

## TC-04 HUMAN APPROVAL: action stays pending until the farmer confirms
- **Category:** Needs human approval
- **Preconditions:** rule-approved irrigate proposal for plot 1 (TC-01 step 2).
- **Steps / input:** after advise, read `GET /api/v1/suggestions/{id}`; call approve with no token; read the suggestion and the 7-day water use again; only then send the confirmation call.
- **Expected:** after advise and after the first approve call the suggestion is still `pending_approval` (water use is not touched until step 2); the first approve call returns 202 with `summary` ("Irrigate Maize Plot A (example) with 270 L") and a token; nothing is approved until the second call with the token (200, `approved`), which re-runs the rules.
- **Mapped eval:** E03, E05, E07, SUG04
- **Status:** Pass (npm test: E05 and E07; probe: suggestion still `pending_approval` after a wrong or missing token)

## TC-05 Decline leaves state unchanged
- **Category:** Human approval (negative path)
- **Preconditions:** a pending suggestion.
- **Steps / input:** `POST /api/v1/suggestions/{id}/reject {}`; then read 7-day water use; then try to approve and to reject again.
- **Expected:** 200, `status: declined`, no confirmation needed, `usedLast7DaysL` unchanged (probe: 1000 before and after), approve afterwards gives 409 `ALREADY_DECIDED`, second reject gives 409 `ALREADY_DECIDED`.
- **Mapped eval:** E16, SUG08
- **Status:** Pass (npm test: E16; probe: water use unchanged and 409s)

## TC-06 Stale sensor data blocks irrigation
- **Category:** Stale sensor data
- **Preconditions:** latest reading for the plot is dry (soil below threshold). Limit is 15 minutes (`STALE_READING_MINUTES`).
- **Steps / input:** validate `irrigate 100 L` with the reading 15 min old, 16 min old and 2 days old (plot 3). Also advise on plot 3.
- **Expected:** 15 min: `approved_by_rules`. 16 min and 2 days: `rejected_by_rules` with `SENSOR_STALE`, and no `SOIL_NOT_DRY`/`RAIN_DETECTED` noise. On plot 3 the AI is told the data is old and proposes `notify` (0 L), not irrigation (`readingAgeMinutes` 2890).
- **Mapped eval:** RULE05, RULE13, E10
- **Status:** Pass (npm test for RULE05/RULE13/E10; probe for the exact 15 min = allowed, 16 min = `SENSOR_STALE` boundary)

## TC-07 Reading goes stale or changes between advice and approval
- **Category:** Stale sensor data / human approval
- **Preconditions:** rule-approved pending suggestion; confirmation token issued.
- **Steps / input:** (a) advise with a reading 14 min 50 s old, request the token, approve 100 s later (reading now 16.5 min old). (b) advise on plot 1, request the token, then POST a new reading with soil 80%, then confirm.
- **Expected:** rules are re-run at approval; (a) 409 `NOT_APPROVABLE` with `SENSOR_STALE`; (b) 409 `NOT_APPROVABLE` with `SOIL_NOT_DRY`. The suggestion is not approved and no water is counted. Audit has `approve_blocked_by_rules`.
- **Mapped eval:** none, gap (SUG12 covers only a budget change at approval time)
- **Status:** Pass (probe). Note: the suggestion's status flips permanently to `rejected` and the farmer must request new advice (design choice, worth mentioning in the demo).

## TC-08 Out-of-range sensor values
- **Category:** Out-of-range values
- **Preconditions:** valid device token. Limits: soil and humidity 0 to 100, temperature -20 to 60 C.
- **Steps / input:** POST a reading with, one at a time: `soilMoisturePct` 101, -0.1, 100.01; `humidityPct` -1; `temperatureC` 98.6 (looks like a Fahrenheit value); timestamp 6 min in the future. Boundaries: soil 0 and 100, temperature -20 and 60, timestamp 4 min in the future.
- **Expected:** out-of-range values give 400 `VALIDATION_ERROR` with the `field` named; boundary values are accepted (201). Future timestamp more than 5 min gives 400, within 5 min gives 201. Nothing invalid is stored.
- **Mapped eval:** DEV06 (101), DEV10 (future), READ03 (140). The rest are extra.
- **Status:** Pass (npm test for DEV06/DEV10/READ03; probe for the others). Note: real JSON cannot carry NaN or Infinity (they serialise to `null`, which is rejected the same way as in TC-09).

## TC-09 Malformed or missing fields, wrong types, wrong units
- **Category:** Malformed input
- **Preconditions:** valid device token.
- **Steps / input:** POST readings with: `soilMoisturePct: null`; `soilMoisturePct: "17"` (string); `humidityPct` missing; `plotId: "1"`; `plotId` missing; `raining: "yes"`; timestamp `"yesterday"`, `"2026-10-23T24:00:00Z"`, missing; body `[]`; empty body; broken JSON `{bad json`; content type `text/plain`; no token; token for another device or plot.
- **Expected:** 400 `VALIDATION_ERROR` (or `INVALID_JSON`, `DEVICE_MISMATCH`) naming the field; 401 `UNAUTHORIZED` without or with a wrong token; no crash, no 500, nothing stored.
- **Mapped eval:** DEV02, DEV03, DEV07, DEV08, DEV09, DEV11, READ04, READ05
- **Status:** Pass (npm test for the mapped ones; probe for null, string, plotId, raining, 24:00, `[]`, empty body, `text/plain`)

## TC-10 Impossible calendar date is rejected
- **Category:** Malformed input
- **Preconditions:** valid device token.
- **Steps / input:** `POST /api/v1/readings` with `timestamp: "2026-02-31T08:20:00Z"` (also `2026-04-31`).
- **Expected:** 400 `VALIDATION_ERROR`, field `timestamp`.
- **Actual (before the fix):** 201 (stored). JavaScript rolled 31 Feb over to 3 March 2026, so the reading was silently stored with a different date than the one sent. **Now:** 400 `VALIDATION_ERROR`, field `timestamp`; leap years are handled (2024-02-29 valid, 2026-02-29 and 2100-02-29 refused).
- **Mapped eval:** DATE01-08 (contract), DEV13-17 (API), `eval/fixes.test.mjs`
- **Status:** Pass after fix (BUG-3). Fixed in the API, mock-pasoe and `openedge/src/iso.i`.

## TC-11 Duplicate deviceId + timestamp gives 409
- **Category:** Duplicate / malformed
- **Preconditions:** a reading was already stored.
- **Steps / input:** repeat the identical POST; repeat with the same instant written as `2026-10-23T10:08:00+02:00` and as `2026-10-23T08:08:00.000Z`.
- **Expected:** 409 `DUPLICATE_READING`, field `timestamp`; only one row stored.
- **Mapped eval:** DEV05, READ02
- **Status:** Pass (npm test for the exact duplicate; probe for the offset and fractional-second forms)

## TC-12 Bad model output: not JSON, empty, null, fenced, trailing text
- **Category:** Bad model output
- **Preconditions:** a provider that returns the given raw text.
- **Steps / input:** `POST /api/v1/plots/1/advise` with model output: `"Sure! Here is my advice..."` (mock `bad-json`), `""`, `null`, `undefined`, an object instead of a string, `"{}"`, JSON followed by text, text before JSON, JSON inside a ```json fence.
- **Expected:** no crash; 200 with `ai.usedFallback: true` and a `fallbackReason` (`invalid_json:` or `schema:`), proposal from the deterministic fallback, rules still decide. The fenced JSON is accepted (documented behaviour). A provider that throws gives `fallbackReason: "error: ..."`.
- **Mapped eval:** E13
- **Status:** Pass (npm test for E13; probe for all the other variants)

## TC-13 Unknown or forbidden action, extra fields, hallucinated plot id
- **Category:** Bad model output / prompt injection
- **Preconditions:** `AI_MOCK_BEHAVIOUR=injection` or a custom provider.
- **Steps / input:** model returns action `apply_pesticide` / `sell_crop` / `IRRIGATE`; `litres` as float, negative, string or 99999; empty or 500-char reason; extra field `plotId: 99`. Also call advise for plot `99`, `abc`, `-1`, and `lang: "fr"`. Validate `apply_pesticide` directly at OpenEdge.
- **Expected:** schema failure gives fallback (`fallbackReason: "schema: ..."`) and the proposal is always for the URL's plot, never for a plot id from the model. Unknown plot gives 404 `PLOT_NOT_FOUND`; `abc`, `-1`, bad lang give 400 `VALIDATION_ERROR`. At OpenEdge, `apply_pesticide` gives `ACTION_NOT_ALLOWED`.
- **Mapped eval:** E14, E11, RULE09, RULE11
- **Status:** Pass (npm test for E14/E11/RULE09/RULE11; probe for the other variants)

## TC-14 hold/notify with non-zero litres must not be approvable or spend water budget
- **Category:** Bad model output / rule gap
- **Preconditions:** a provider that returns `{"action":"hold","litres":500,"reason":"x"}` (or `notify` with 900).
- **Steps / input:** `POST /api/v1/plots/1/advise`; then (OpenEdge layer) approve that suggestion and read `usedLast7DaysL`.
- **Expected:** the proposal is rejected by the schema or normalised to 0 L, because only `irrigate` may carry litres (system prompt: "litres is 0 unless action is irrigate"). Approving a hold must not add to the weekly water use.
- **Actual (before the fix):** advise returned 200 `pending_approval`, `proposal: hold 500 L`. Approving it at the OpenEdge layer changed `usedLast7DaysL` from 1000 to 1500 (every approved suggestion's litres were summed regardless of action). **Now:** the schema refuses litres other than 0 on hold/notify (fallback with 0 L), and the 7-day sum in both `mock-pasoe/rules.js` and `openedge/src/farm-api.p` counts `irrigate` only.
- **Mapped eval:** BUD01-06 (contract, hold/notify carrying litres at the OpenEdge layer), E21, E22 (API), `eval/fixes.test.mjs`
- **Status:** Pass after fix (BUG-1) on mock-pasoe; ABL change pending a real-OpenEdge run.

## TC-15 AI timeout falls back, rules still decide
- **Category:** Timeout (AI)
- **Preconditions:** (a) `AI_MOCK_BEHAVIOUR=timeout`; (b) HTTP provider pointed at a local server that never answers (loopback only, dummy key).
- **Steps / input:** `POST /api/v1/plots/4/advise` (plot 4 has 350 of 400 L used).
- **Expected:** 200, `ai.usedFallback: true`, `fallbackReason` starts with `timeout:`; the fallback proposal is validated by the rules (`WATER_BUDGET_EXCEEDED`, status `rejected`). The real HTTP provider gives up after `AI_TIMEOUT_MS` (8000 ms).
- **Mapped eval:** E12 (simulated: the mock throws immediately)
- **Status:** Pass (npm test for E12; probe: real hanging server gave 200, `usedFallback:true`, `timeout: AI did not answer within 8000 ms` after 8009 ms)

## TC-16 OpenEdge timeout or outage gives a clear error within the documented 5 s
- **Category:** Timeout (ABL / OpenEdge)
- **Preconditions:** `OE_MODE=pasoe` pointed at a loopback server that (a) never answers, (b) refuses connections, (c) returns HTML, (d) returns 500 JSON.
- **Steps / input:** `POST /api/v1/plots/1/advise` and `POST /api/v1/readings`.
- **Expected:** (a) 504 `OE_TIMEOUT` after about 5 s (`OE_TIMEOUT_MS`); (b) and (c) 502 `OE_UNAVAILABLE`; (d) the error is passed through; never a hang, a crash or an invented answer.
- **Actual (before the fix):** the codes were as expected (a: 504 `OE_TIMEOUT`, b/c: 502 `OE_UNAVAILABLE`, d: 500 with the OpenEdge body) but latency for (a) was about **10 s** (twice the limit). **Now:** about one timeout; after an OpenEdge failure the API skips the audit write and logs locally (`auditSkipped` in `logs/tool-calls.jsonl`); a slow audit write waits at most 1 s.
- **Mapped eval:** `eval/fixes.test.mjs` (hung server, refused connection, slow audit; the timeout is set with `OE_TIMEOUT_MS` in the test)
- **Status:** Pass after fix (BUG-2).

## TC-17 Empty results
- **Category:** Empty results
- **Preconditions:** plot with no readings; filters that match nothing.
- **Steps / input:** delete the readings of plot 1 (in a throw-away in-memory store), then: `POST /api/v1/plots/1/advise`; `GET /api/v1/plots/1/readings`; validate `irrigate`; `GET /api/v1/suggestions?status=declined` when none; `GET /api/v1/suggestions/99`; `POST /api/v1/plots/99/advise`.
- **Expected:** advise returns 200 with `notify` 0 L ("check the sensor"), `facts.soilMoisturePct: null`, never irrigation; readings list is `[]` (200); irrigate validation gives `NO_SENSOR_DATA`; empty filter gives `{"suggestions":[]}`; unknown suggestion gives 404 `SUGGESTION_NOT_FOUND`; unknown plot gives 404 `PLOT_NOT_FOUND`, not an invented answer.
- **Mapped eval:** E11, SUG16, SUG18 (note: no eval case asserts `NO_SENSOR_DATA`, see gaps)
- **Status:** Pass (npm test for E11/SUG16/SUG18; probe for the no-readings checks). Not checked: an unrecognised `status` filter (`?status=bogus`) returns 200 with an empty list rather than 400.

## TC-18 Unapproved delete is blocked
- **Category:** Unapproved delete
- **Preconditions:** one pending suggestion and one approved suggestion (the seed has three approved).
- **Steps / input:** `DELETE /api/v1/suggestions/7` with no body; with no auth; for an unknown id; on an approved id (without a token; the confirmed variant was not probed); then the confirmed delete.
- **Expected:** no body: 202 `CONFIRMATION_REQUIRED`, suggestion still present; no auth: 401; unknown id: 404; approved: 409 `CANNOT_DELETE_APPROVED` (approved water counts against the budget); confirmed delete of a non-approved one: 200 `status: deleted`, second delete 409 `ALREADY_DECIDED`.
- **Mapped eval:** E17, E18, SUG13, SUG14, SUG15
- **Status:** Pass (npm test for E17/E18/SUG13-15; probe for 401, 404 and the approved-delete 409 through the API)

## TC-19 Confirmation token misuse
- **Category:** Human approval / security
- **Preconditions:** a token issued by step 1 of approve.
- **Steps / input:** confirm with: a wrong token; the same token twice; the approve token on DELETE; the token on another suggestion id; the token 121 s after issue (TTL 120 s); `confirmToken: null`; `confirmToken: 123`.
- **Expected:** 403 `CONFIRMATION_INVALID` each time (the unknown-id case gives 404); the suggestion stays `pending_approval`; a valid token works once.
- **Mapped eval:** E06, E08
- **Status:** Pass (npm test for E06/E08; probe for the other variants, using an injected clock for expiry)

## TC-20 Audit trail
- **Category:** Audit
- **Preconditions:** run TC-01, TC-05 and TC-18 first.
- **Steps / input:** `GET /api/v1/audit?limit=500`.
- **Expected:** events for every tool call (`tool_call`: OpenEdge and AI calls, with `requestId`), `rule_check`, `suggestion_approved`, `suggestion_declined`, `suggestion_deleted`, `approve_blocked_by_rules`; newest first; `limit` respected; the audit write never fails the request.
- **Mapped eval:** E19, AUD01, AUD02
- **Status:** Pass (npm test for E19/AUD01/AUD02; probe saw `tool_call`, `rule_check`, `suggestion_declined`, `approve_blocked_by_rules`). Observation, not a failed case: 401 and 403 attempts (missing token, wrong or expired confirmation token) leave no audit entry of their own.

---

## Bugs and gaps found

| ID | Severity | Finding | Repro | Where |
|---|---|---|---|---|
| BUG-1 (fixed) | Medium | Non-irrigate actions can carry litres and those litres count toward the weekly water budget once approved. The proposal schema allows `litres` 0 to 1000 for every action, the ABL and Node rules only check litres for `irrigate`, and the budget sum adds all approved rows. | Provider returns `{"action":"hold","litres":500,"reason":"x"}` for plot 1: advise gives `pending_approval`; approving moves `usedLast7DaysL` 1000 to 1500 (mock-pasoe). | `apps/api/src/ai/advise.js` 227-234; `mock-pasoe/rules.js` 19-21; `openedge/src/farm-api.p` 196-201 |
| BUG-2 (fixed) | Low-Medium | During an OpenEdge outage a request takes about 2 x `OE_TIMEOUT_MS` (10 s): the failing call times out, then the `finally` in `tool()` awaits an audit write to the same unreachable OpenEdge, which times out too. | `OE_MODE=pasoe`, `OE_BASE_URL` to a server that never answers; `POST /api/v1/plots/1/advise` returns 504 after about 10 s. | `apps/api/src/app.js` 38-48 (line 46 awaits `oe.call('/farm/audit')`) |
| BUG-3 (fixed) | Low | Impossible calendar dates (`2026-02-31`, `2026-04-31`) are accepted and stored on a rolled-over date. The same day <= 31 check exists in the ABL parser. | `POST /api/v1/readings` with `timestamp: "2026-02-31T08:20:00Z"` returns 201. | `apps/api/src/app.js` 11 and 76; `mock-pasoe/time.js` 8; `openedge/src/iso.i` 27 |
| GAP-1 | Info | No eval case for rule `NO_SENSOR_DATA` (listed in NOTES.md section 2). Behaviour verified only by probe. | Validate `irrigate` on a plot with no readings. | `eval/oe-contract-cases.json` |
| GAP-2 | Info | AI timeout case E12 is simulated (mock throws immediately); the real 8 s abort and every OpenEdge failure mode have no automated test. | See TC-15 and TC-16. | `eval/api-cases.json`, `apps/api/src/ai/provider.js` |
| GAP-3 | Info | Mock behaviour `extra-field` and `greedy` on a dry plot, stale-at-approval, wet-at-approval, expired token and boundary values are not in the eval files. | See TC-07, TC-08, TC-19. | `eval/*.json` |
| GAP-4 | Info | Denied attempts (401, 403 `CONFIRMATION_INVALID`) are not audited; the raw model output is not stored (only the fallback reason). | See TC-20. | `apps/api/src/app.js` |

## What was not verified

- Fixes for BUG-1/2/3 were made after this report (see `docs/NOTES.md` section 6a). Line numbers in the bug table refer to the code before the fixes.

- Real OpenEdge/PASOE and the ABL code (`farm-api.p`, `FarmHandler.cls`) were not run on this Linux box; the Windows-only suites (`test:oe-http`, `test:api-real-oe`, `oe-run.ps1 -Action test`) and the real Gemini test (`test:gemini`) were not run. Statuses above are for `mock-pasoe` and the mock AI.
- Firmware tests (`pio test -e native`) and the physical ESP32 were not run. The simulator tests (33 unit, 5 against the API) passed inside `npm test`.
- `npm test` also appends to `logs/tool-calls.jsonl` (gitignored); the QA probes did too.
