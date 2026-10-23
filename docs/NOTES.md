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
| Tables | `Farm`, `Plot`, `SensorReading` (unique index DeviceId+ReadAt), `AiSuggestion`, `AuditLog`, sequences `ReadingSeq`, `SuggestionSeq`, `AuditSeq` (`openedge/schema/*.df`) |
| ABL code | `openedge/src/farm-api.p` (all rules and data access), `web/FarmHandler.cls` (thin PASOE WebHandler), `seed.p`, `load-schema.p`, `run-contract.p` (batch test runner), `compile-check.p` |
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

Other thresholds in the API (`apps/api/src/config.js`): AI timeout 8 s, OpenEdge timeout 5 s, confirmation token lifetime 120 s and single use, reading timestamp at most 5 min in the future, soil/humidity 0 to 100, temperature -20 to 60 C, model explanation may only use numbers that came from OpenEdge.

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
| `AI_MOCK_BEHAVIOUR` | mock only: `normal`, `timeout`, `bad-json`, `injection`, `extra-field`, `greedy`, `invented-number` |
| `LOG_DIR`, `LOG_LEVEL` | tool-call log (`logs/tool-calls.jsonl`, gitignored) and Fastify log level |

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
| `npm run test:oe-http` | the 47 OpenEdge contract cases over HTTP against a running PASOE (`OE_BASE_URL`); reseed first |
| `npm run test:api-real-oe` | the API suites (device + api cases) against real PASOE |
| `node mock-pasoe/server.js` | mock PASOE as a standalone HTTP server on :8820 |
| `node sim/esp32-sim.js --scenario drought --url http://localhost:3000` | feed the API like the ESP32 (needs `DEVICE_TOKEN`, see `docs/ESP32.md`) |
| `cd firmware/esp32 && pio test -e native` | firmware payload-builder unit tests (15, needs PlatformIO and a host C++ compiler) |
| `cd firmware/esp32 && cp include/config.example.h include/config.h && pio run -e esp32dev` | compile the firmware (edit `config.h` before flashing; it is gitignored) |

### Real OpenEdge mode (Windows, OpenEdge 12.8)

Details and the exact configuration are in `openedge/pasoe/README.md`. Short version, in PowerShell from the repo root:

```powershell
.\scripts\oe-run.ps1 -Action start-db      # farm database server on port 20000 (once; database already loaded)
.\scripts\oe-run.ps1 -Action seed          # reset to the example data (do this before each test run and before the demo)
.\scripts\oe-run.ps1 -Action test          # 47 contract cases against the real ABL code in batch mode
# PASOE instance `farmops` must be running (tcman.bat start); then:
$env:OE_BASE_URL = 'http://localhost:8820/web'
npm run test:oe-http                       # same 47 cases over HTTP through FarmHandler.cls
$env:OE_MODE = 'pasoe'; npm start          # API on :3000 backed by the real database
npm run demo
```

Fresh database: `.\scripts\oe-run.ps1 -Action load-schema` (database server stopped; loads `openedge/schema/002-farm-ops.df`; `001-farm.df` is the original `Farm` table), then start the server and `seed`.
The PASOE PROPATH points at this repo's `openedge/src`, so after changing ABL code, run `compile-check.p` (see `scripts/oe-run.ps1`/`openedge/src/compile-check.p`) and, if needed, restart or refresh the agent sessions.
The API must run on the same machine as PASOE (or be given a reachable `OE_BASE_URL`); a cloud/Linux box cannot reach the laptop's localhost. For the ESP32, allow inbound TCP **3000** in Windows Firewall and use the laptop's LAN IP (or phone-hotspot IP) in `config.h`.

## 5. What is real and what is mocked

| Piece | Status |
|---|---|
| OpenEdge database, schema, ABL rules, PASOE WebHandler | **Real.** Tested on OpenEdge 12.8: 47 contract cases pass in batch mode and over HTTP through PASOE; API suites (32 cases) pass against real PASOE; `npm run demo` completed against it |
| `mock-pasoe` (Node port of the ABL rules) | **Mock** stand-in used by `npm test` so the repo is testable anywhere. The same 47 cases run against both and must agree (`eval/compare-oe.mjs`) |
| Node API, confirmation gates, audit, fallback logic | **Real** code; tested in-process and over HTTP |
| AI model | **Real** Gemini (`gemini-3.5-flash`) in `npm run test:gemini` and when `.env` says `AI_PROVIDER=http`. **Mock** (deterministic) in all automated tests so results are repeatable |
| ESP32 firmware | **Compiled only** (`pio run -e esp32dev` succeeds; 15 native unit tests pass). It has **not** been run on a physical board in this repo's tests |
| ESP32 simulator | **Real** HTTP client; unit tests (33) and runs against the Node API in `npm test` |
| Sensor values, farm, plots, user "Nomsa" | **Fictional example data** |
| Demo screens in `docs/screens/` | Static design mockups (PNG), not a running UI. There is no web front end in this repo; the API is the product surface |

## 6. Test results (at the time of writing)

- `npm test` (offline): **146 passed, 0 failed, 3 intentional failures confirmed**, 0 unexpected passes. Breakdown: OpenEdge contract on mock-pasoe 46, API suites on `OE_MODE=mock` 31, same over the PASOE HTTP client path 31, simulator unit tests 33, simulator against API 5. Each of the three suites with an intentional failure contains exactly one case that is *designed to fail* (OE `FAIL01`, API `E20` in two modes) to show the checker reports failures honestly.
- Real OpenEdge over HTTP: 46 passed + 1 intentional failure. API suites vs real PASOE: 31 passed + 1 intentional failure.
- `npm run test:gemini`: passed (English and isiZulu, real model used, no fallback).
- Firmware native tests: 15 passed. Firmware compiles for `esp32dev`.
- Required case types covered: a case that must fail (`FAIL01`, `E20`), and a case that needs human approval (`E05`, `E07`, `E17`, `E18`).

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

## 8. Repository map

| Path | Content |
|---|---|
| `docs/API.md` | HTTP API contract (farmer app and device) |
| `docs/OE-CONTRACT.md` | internal contract between the API and OpenEdge |
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
