# Mzansi Farmer Ops: engineering notes (for the README, the QA test list and the presentation)

**One sentence:** an ESP32 sends soil readings to a Node API; an AI model *proposes* an irrigation action; ABL rules running in OpenEdge *validate* it; the farmer *approves* it in two explicit steps. All numbers and records come from OpenEdge, never from the model. **All data is fictional example data.**

```
ESP32 / simulator --POST /api/v1/readings--> Node API (Fastify, :3000)
                                               |  reads facts (plot limits, latest reading, 7-day water use) from OpenEdge
                                               |  asks the AI for a JSON proposal  (Gemini, or a deterministic mock)
                                               |  schema-checks the proposal, checks numbers in its explanation, else falls back
                                               v
                               OpenEdge (PASOE WebHandler -> farm-api.p -> database `farm`)
                                               |  ABL rules: approve/reject with every failing reason
                                               v
                               farmer approves: step 1 returns a single-use token, step 2 re-runs the rules and applies
```

## 1. Stack and versions

| Part | Version / detail |
|---|---|
| OpenEdge (database, ABL, PAS for OpenEdge) | 12.8, Windows, `C:\Progress\OpenEdge`; Developer Studio installed; PASOE instance `farmops` (HTTP 8820, HTTPS 8821, shutdown 8822) |
| Java for PASOE / Developer Studio | Eclipse Temurin 17.0.20.1 |
| OpenEdge database | `farm` (single-user for schema load; multi-user server on port 20000 with `-minport 3100 -maxport 3199` so it never takes port 3000) |
| Tables | `Farm`, `Plot`, `SensorReading` (unique index DeviceId+ReadAt), `AiSuggestion`, `AuditLog`, sequences `ReadingSeq`, `SuggestionSeq`, `AuditSeq` (`002-farm-ops.df`). Co-op: `Member`, `InputCredit`, `HarvestLot`, `LotContribution`, `BuyerContract`, `Allocation`, `Payout` and their sequences (`003-coop.df`) |
| ABL code | `openedge/src/farm-api.p` (irrigation rules, data access, and the route dispatcher), `openedge/src/coop.i` (co-op rules, included by `farm-api.p`), `web/FarmHandler.cls` (thin PASOE WebHandler), `seed.p`, `load-schema.p`, `run-contract.p` (batch test runner), `compile-check.p` |
| API | Node.js 20+ (tested on 20.19 and 24), Fastify 5.12, Ajv 8.20. Only two runtime dependencies. |
| AI | Any OpenAI-compatible `/chat/completions` endpoint. Real config: Google Gemini `gemini-3.5-flash` via `https://generativelanguage.googleapis.com/v1beta/openai`. Default: deterministic mock provider (no key, no network). |
| Firmware | PlatformIO, Arduino framework on ESP32 (espressif32 platform 8.0.0), DHT22 + analog soil sensor |
| Simulator | `sim/esp32-sim.js`, plain Node, no dependencies |

## 2. Rules (enforced in OpenEdge, `farm-api.p`; mirrored in `mock-pasoe/rules.js`)

| Code | Rule |
|---|---|
| `PLOT_NOT_FOUND` | the plot must exist |
| `ACTION_NOT_ALLOWED` | action must be one of `irrigate`, `hold`, `notify` (anything else, e.g. `apply_pesticide`, is refused) |
| `LITRES_OUT_OF_RANGE` | irrigate only: 1 to the plot's `MaxIrrigationLitres` |
| `NO_SENSOR_DATA` | irrigate only: the plot needs a reading |
| `SENSOR_STALE` | irrigate only: latest reading must be at most **15 minutes** old |
| `SOIL_NOT_DRY` | irrigate only: soil moisture must be **below** the plot's dry threshold |
| `RAIN_DETECTED` | irrigate only: latest reading must not say it is raining |
| `WATER_BUDGET_EXCEEDED` | irrigate only: approved litres in the last **7 days** + this request must be at most the plot's weekly budget (equal is allowed) |

Every failing rule is reported, not just the first. `notify` and `hold` need no water checks. Approving **re-runs** the rules at approval time (the data may have changed).

Example plots (seed): Maize A max 500 L / dry below 35% / 1500 L per week; Beans B 300 / 40 / 900; Spinach C 200 / 45 / 600; Tomato D 250 / 40 / 400; Cabbage E 300 / 40 / 900.

Co-op rules (credit limit, allocation, pro-rata fair split, payouts) are in `openedge/src/coop.i` and `mock-pasoe/coop-rules.js`. Definitions, the approval gate and the OpenEdge steps are in `docs/COOP.md`. Section 5 of that file is the payout rules.

Other thresholds in the API (`apps/api/src/config.js`): AI timeout 8 s, OpenEdge timeout 5 s (audit write after a call: 1 s, and skipped when OpenEdge itself just failed), confirmation token lifetime 120 s and single use, reading timestamp at most 5 min in the future, soil/humidity 0 to 100, temperature -20 to 60 C, model explanation may only use numbers that came from OpenEdge.

Safety behaviour the tests cover: unknown/invalid input is a clear error (not an invented answer); AI timeout, non-JSON output, extra fields, forbidden action (prompt injection) and invented numbers all fall back to a deterministic proposal or template explanation; approve and delete need a confirmation step, reject does not; every tool call and decision is written to the OpenEdge audit table.

## 3. Environment variables (`.env`, never committed; `.env.example` is the template)

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | API listen address (default 3000, 0.0.0.0) |
| `OE_MODE` | `mock` (Node port of the ABL rules, in memory; default) or `pasoe` (real OpenEdge over HTTP) |
| `OE_BASE_URL` | PASOE base, default `http://localhost:8820/web` (the service is `/web/farm/*`) |
| `OE_AUTH` | optional `user:password` for PASOE basic auth (demo instance is open on localhost) |
| `APP_TOKEN` | bearer token for the farmer app (`npm run setup` generates a random one) |
| `DEVICE_REGISTRY` | JSON array mapping device tokens to a device and plot: `[{"deviceId":"esp32-01","plotId":1,"token":"..."}]` |
| `AI_PROVIDER` | `mock` (default) or `http` |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | for `http`; the key is read only from the environment or `.env` and is never logged |
| `AI_MOCK_BEHAVIOUR` | mock only: `normal`, `timeout`, `bad-json`, `injection`, `extra-field`, `greedy`, `invented-number`, `hold-with-litres`, `notify-no-litres` |
| `OE_TIMEOUT_MS` | optional, default 5000; only meant for tests (minimum 50) |
| `LOG_DIR`, `LOG_LEVEL` | tool-call log (`logs/tool-calls.jsonl`, gitignored) and Fastify log level |
| `ESP32_DASHBOARD_URL` | browser-only address of the ESP32 dashboard (default `http://192.168.4.1`). The API does not connect to it. See `docs/ESP32.md` |

Real environment variables win over `.env`.

## 4. How to run

From a clone, any OS with Node 20+:

```bash
npm install
npm run setup        # creates .env with random tokens (keeps an existing .env, adds missing tokens)
npm test             # everything below that works offline; AI is the mock
npm start            # API on :3000 (OE_MODE=mock, AI_PROVIDER=mock unless .env says otherwise)
npm run demo         # in a second terminal: reading -> AI proposal -> rules -> approve (two steps) -> audit
```

Optional checks:

| Command | What it does |
|---|---|
| `npm run test:gemini` | one live call to the real model (English and isiZulu). **Skipped** (exit 0) unless `AI_PROVIDER=http` and the three AI variables are set |
| `npm run test:oe-http` | every OpenEdge contract case, including `CO01` to `CO76`, over HTTP against a running PASOE (`OE_BASE_URL`); reseed first |
| `npm run test:api-real-oe` | the API suites (device + api cases) against real PASOE |
| `node mock-pasoe/server.js` | mock PASOE as a standalone HTTP server on :8820 |
| `node sim/esp32-sim.js --scenario drought --url http://localhost:3000` | feed the API like the ESP32 (needs `DEVICE_TOKEN`, see `docs/ESP32.md`) |
| `cd firmware/esp32 && pio test -e native` | firmware payload-builder unit tests (15, needs PlatformIO and a host C++ compiler) |
| `cd firmware/esp32 && cp include/config.example.h include/config.h && pio run -e esp32dev` | compile the firmware (edit `config.h` before flashing; it is gitignored) |

### Real OpenEdge mode (Windows, OpenEdge 12.8)

Details and the exact configuration are in `openedge/pasoe/README.md`. Short version, in PowerShell from the repo root:

```powershell
.\scripts\oe-run.ps1 -Action start-db      # farm database server on port 20000 (once; database already loaded)
.\scripts\oe-run.ps1 -Action seed          # reset to the example data, including coop-seed.json (do this before each test run and before the demo)
.\scripts\oe-run.ps1 -Action test          # every contract case, including CO01-CO76, against the real ABL code in batch mode
.\scripts\oe-run.ps1 -Action test-coop     # reseed, then only CO01-CO76 in batch mode
# PASOE instance `farmops` must be running (tcman.bat start); then:
$env:OE_BASE_URL = 'http://localhost:8820/web'
.\scripts\oe-run.ps1 -Action test-http     # reseed, then every case over HTTP through FarmHandler.cls
.\scripts\oe-run.ps1 -Action test-http-coop
npm run test:oe-http                       # same HTTP cases; this command does not reseed
$env:OE_MODE = 'pasoe'; npm start          # API on :3000 backed by the real database
npm run demo
```

Schema, with the database server stopped. An existing farm database that already has `002-farm-ops.df`: `.\scripts\oe-run.ps1 -Action load-coop` (loads `003-coop.df` only). A database that does not have `002` yet: `.\scripts\oe-run.ps1 -Action load-schema` (`002-farm-ops.df` then `003-coop.df`). `001-farm.df` is the original `Farm` table and is not loaded by `load-schema`. Then start the server and `seed`. The exact co-op steps are in `docs/COOP.md` section 10.
The PASOE PROPATH points at this repo's `openedge/src`, so after changing ABL code, run `compile-check.p` (see `scripts/oe-run.ps1`/`openedge/src/compile-check.p`) and, if needed, restart or refresh the agent sessions.
The API must run on the same machine as PASOE (or be given a reachable `OE_BASE_URL`); a cloud/Linux box cannot reach the laptop's localhost. For the ESP32, allow inbound TCP **3000** in Windows Firewall and use the laptop's LAN IP (or phone-hotspot IP) in `config.h`.

## 5. What is real and what is mocked

| Piece | Status |
|---|---|
| OpenEdge database, schema, ABL rules, PASOE WebHandler | **Real** for irrigation. Tested on OpenEdge 12.8: the original 47 contract cases passed in batch mode and over HTTP through PASOE and the API suites passed against real PASOE; `npm run demo` completed against it. See 6a. **Co-op ABL** (`coop.i` inside `farm-api.p`, schema `003-coop.df`) is written and matched to the Node rules, but it has **not** been compiled or run on OpenEdge yet |
| `mock-pasoe` (Node port of the ABL rules) | **Mock** stand-in used by `npm test` so the repo is testable anywhere. Irrigation and co-op cases (`CO01` to `CO76`) run here. `eval/compare-oe.mjs` checks the same cases against a real batch file or PASOE HTTP (`--coop` for the co-op cases only) |
| Node API, confirmation gates, audit, fallback logic | **Real** code; tested in-process and over HTTP |
| AI model | **Real** Gemini (`gemini-3.5-flash`) in `npm run test:gemini` and when `.env` says `AI_PROVIDER=http`. **Mock** (deterministic) in all automated tests so results are repeatable |
| ESP32 firmware | **Compiled only** (`pio run -e esp32dev` succeeds; 15 native unit tests pass). It has **not** been run on a physical board in this repo's tests |
| ESP32 simulator | **Real** HTTP client; unit tests (33) and runs against the Node API in `npm test` |
| Sensor values, farm, plots, user "Nomsa" | **Fictional example data** |
| Demo screens in `docs/screens/` | Static design mockups (PNG) that the web UI follows |
| Web UI (`apps/web/`, `docs/UI.md`) | **Real** page code served by the Node API at `/`; checked in a headless browser against the **mock** OpenEdge and **mock** AI. Not yet looked at against real PASOE or on a physical phone |

## 6. Test results (at the time of writing)

- Current offline total: see section 6b. The figure of 184 passed was the count before the co-op cases, the co-op unit tests and the web UI suite were in `npm test`.
- Earlier breakdown, kept so the bug-fix note stays readable: OpenEdge contract on mock-pasoe 60, API suites on `OE_MODE=mock` 38, same over the PASOE HTTP client path 38, simulator unit tests 33, simulator against API 5, bug-fix tests (`eval/fixes.test.mjs`) 10. (Before the bug fixes it was 146: 46 + 31 + 31 + 33 + 5.) Each of the three suites with an intentional failure contains exactly one case that is *designed to fail* (OE `FAIL01`, API `E20` in two modes) to show the checker reports failures honestly.
- Real OpenEdge over HTTP, before the bug fixes: 46 passed + 1 intentional failure. API suites vs real PASOE: 31 passed + 1 intentional failure. After the fixes (61 contract cases, 38 API cases): 60 + 1 intentional failure, and 17 + 21 + 1 intentional failure; see 6a.

### 6a. QA bug fixes (2026-10-23)

- **BUG-1 litres only count for irrigation.** The AI schema (`apps/api/src/ai/advise.js`) now allows `litres` only as 0 (or absent, stored as 0) on `hold` and `notify`; a model that sends litres there falls back to the deterministic proposal. The 7-day budget sum in `farm-api.p` and `mock-pasoe/rules.js` counts `irrigate` suggestions only, so even a stored hold with litres uses no water. Cases: contract BUD01-06, API E21-E22.
- **BUG-2 outage no longer doubles the wait.** If a call to OpenEdge fails (timeout or unreachable) the API skips the audit write to the same server and logs the call locally (`auditSkipped: openedge_unavailable` in `logs/tool-calls.jsonl`). A normal audit write has its own 1 s limit. The 504 now arrives after about one `OE_TIMEOUT_MS`. Tests: `eval/fixes.test.mjs`.
- **BUG-3 real calendar dates.** Timestamps are checked against a real calendar (month lengths, leap years, century rule, time zone offset up to +/-23:59) in the API (`apps/api/src/iso.js`), `mock-pasoe/time.js` and `openedge/src/iso.i`. Cases: contract DATE01-08, API DEV13-17.
- **Real OpenEdge status of these fixes:** **Verified on the laptop on 23 Oct 2026 (OpenEdge 12.8, Node 24).** `compile-check.p` compiles all five programs; the 61 contract cases give 60 passed + 1 intentional failure in batch mode and again over HTTP through PASOE; `npm run test:api-real-oe` gives device cases 17 passed and API cases 21 passed + 1 intentional failure; `npm test` on the laptop gives 184 passed, 3 intentional failures confirmed. (`npm test` now asks Node for the TAP reporter so the counts also work on Node 24.)
- `npm run test:gemini`: passed (English and isiZulu, real model used, no fallback).
- Firmware native tests: 15 passed. Firmware compiles for `esp32dev`.
- Required case types covered: a case that must fail (`FAIL01`, `E20`), and a case that needs human approval (`E05`, `E07`, `E17`, `E18`).

### 6b. Co-op rules (2026-10-24)

- `npm test` (offline, this branch): **301 passed, 0 failed, 3 intentional failures confirmed**, 0 unexpected passes. The three intentional failures are still `FAIL01` and `E20` in two modes. Breakdown: OpenEdge contract on mock-pasoe 136 passed (the earlier 60 plus `CO01` to `CO76`) and 1 intentional failure, API device + API cases on `OE_MODE=mock` 17 + 21 and the same 17 + 21 over the PASOE HTTP client path (each API suite has the one intentional `E20`), simulator unit tests 33, simulator against API 5, bug-fix tests 10, web UI tests 13, co-op unit tests (`eval/coop.test.mjs`) 28. Those 28 cover pro rata, approval re-check, payouts, audit, and checks that `coop.i` and `eval/compare-oe.mjs` are present. `compare-oe` is also run from those tests against mock-pasoe in batch mode and over HTTP, including `--coop`.
- **Real OpenEdge status of the co-op ABL:** not run. This environment has no OpenEdge, and none was installed. `docs/COOP.md` section 10 is the exact load and run sequence for the laptop (OpenEdge 12.8, farm database on port 20000). Expect 76 co-op passes in batch mode and again over HTTP, and the existing 60 + 1 intentional failure for the irrigation cases.

## 7. Known limitations (be honest about these)

- **No RAG.** There is no vector database, embeddings or document store. Instead, facts are *retrieved from OpenEdge* for each request (plot limits, latest readings, 7-day approved water use, computed trend) and given to the model as the only allowed source of numbers. Farming-guide retrieval with citations would be a sensible next step.
- **ESP32 firmware has only been compile-tested** and unit-tested on a host; the soil-sensor calibration values (`SOIL_RAW_DRY` 3200, `SOIL_RAW_WET` 1300) are typical defaults and must be calibrated with the real probe. Firmware accepts -40..80 C but the API accepts -20..60 C; values outside that range get a 400 with a clear field error.
- **isiZulu text needs review by a native speaker.** The isiZulu strings (templates, screens, AI answers) were written without one; the API appends a note saying the text is a draft.
- **Model choice:** `gemini-3.8-flash` and `3.7-flash` were overloaded earlier, so `gemini-3.5-flash` is used. Free-tier limits and availability can change; if the model fails or is slow (8 s timeout) the deterministic fallback proposal is used, still validated by OpenEdge (`ai.usedFallback: true`).
- The model proposed the maximum litres (500 L) in one live run where the deterministic sizing would give 260 L. The rules accepted it because it is within the plot limit and budget; the farmer still approves. We do not tune the amount beyond the rules.
- PASOE demo instance is configured with `permitAll()` on `/web/**` (see `openedge/pasoe/README.md`). That is acceptable only because it listens on the laptop and the Node API is the only caller. Use basic/form login and `OE_AUTH` for anything real.
- PASOE Development licence limits apply (1 agent, 5 concurrent requests): fine for a demo, not for production.
- The confirmation tokens and the API process state are in memory: restarting the API invalidates pending tokens. Suggestions, readings and audit are in OpenEdge and survive restarts.
- Weekly budget counts only *approved* suggestions inside a rolling 7 days; run `seed` to reset between demo runs.
- Device authentication is a shared token per device over plain HTTP on a local network (hotspot). No TLS, rate limiting or token rotation.
- The photos in `docs/screens/` are Pexels stock photos (see `credits.md`), not South African fields, and the example user avatar is a stock portrait.
- The screens use illustrative plot names that differ slightly from the seed data (the API data has five plots: Maize A, Beans B, Spinach C, Tomato D, Cabbage E).
- Error handling is tested for the cases in `eval/*.json`, not for every possible network failure.
- The co-op ABL (`openedge/src/coop.i`) has not been compiled or executed on OpenEdge. The Node copy is what `npm test` runs. There is no co-op screen.

## 8. Repository map

| Path | Content |
|---|---|
| `docs/API.md` | HTTP API contract (farmer app and device) |
| `docs/OE-CONTRACT.md` | internal contract between the API and OpenEdge |
| `docs/COOP.md` | co-op rules, approval gate, endpoints, and how to run `CO01` to `CO76` on OpenEdge 12.8 |
| `docs/ESP32.md` | firmware, wiring, simulator usage |
| `docs/screens/` | approved demo screens, `credits.md`, `api-fields.md` |
| `apps/api/` | Fastify API and AI layer (`src/ai/advise.js`, `src/ai/provider.js`) |
| `openedge/` | schema, seed data, ABL code, PASOE handler map |
| `mock-pasoe/` | Node port of the ABL service |
| `eval/` | test cases (`*.json`) and runners; `npm test` runs `run-all.mjs` |
| `firmware/esp32/`, `sim/` | ESP32 firmware and simulator |
| `scripts/` | `setup-env.mjs`, `demo.mjs`, `oe-run.ps1`, `gen-seed.mjs` |

## 9. Secrets

`.env`, `firmware/esp32/include/config.h`, logs and build output are gitignored. Keys and tokens are only read from the environment. Nothing in the repository or its history contains an API key, Wi-Fi name or password. Run the secrets sweep before every push.

> Test push via laptop git (24 Oct 2026): harmless note, no code change.
