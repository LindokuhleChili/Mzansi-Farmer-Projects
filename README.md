# Mzansi Farmer Ops

An irrigation helper for small farms, built for the Mzansi Farmer AI hackathon (OpenEdge + AI).

An ESP32 soil sensor sends readings to a Node API. An AI model proposes an action. Business rules written in OpenEdge ABL decide whether that action is allowed. The farmer approves it in two explicit steps.

> **AI proposes, OpenEdge rules validate, the farmer approves.**
> Every number and record comes from OpenEdge, never from the model. The model may only suggest an action (`irrigate`, `hold` or `notify`) and explain it using numbers OpenEdge gave it.

**All data in this repository is fictional example data.** Nothing here is a real farm, a real person or advice to act on.

## Hosting status

The public demo (previously at http://13.43.92.196/ on an AWS EC2 Windows server) has been shut down after the AIGS hackathon (29 Oct 2026). Keeping that VM running is costly. Run the app on your own machine with the [Quick start](#quick-start-no-openedge-no-key-no-hardware), or bring the demo back with [docs/REHOSTING.md](docs/REHOSTING.md).

## Status (26 Oct 2026)

| Area | State |
|---|---|
| Irrigation loop (sensor -> AI proposal -> ABL rules -> two-step farmer approval -> audit) | Built, tested on real OpenEdge 12.8 |
| Co-op rules (members, input credit, harvest lots, fair allocation, payouts) | Built (HTTP API), CO01-CO76 pass on real ABL |
| Community harvest-day market (feature 16) | Merged; schema `004-market.df` loaded in the live demo DB; MK01-MK51 pass on real ABL |
| AI translation into all 11 official languages | Merged; picker in the UI, hand-written isiZulu first, AI for the rest (mock offline, Gemini via `AI_PROVIDER=http`); see [docs/TRANSLATION.md](docs/TRANSLATION.md) |
| Weather alerts (17) with the real 7-day Open-Meteo forecast, and tamper-evident audit hash chain (21) | Merged; 005 and 006 loaded in the live DB, tested on real OpenEdge; see [docs/AUDIT.md](docs/AUDIT.md) and [docs/WEATHER.md](docs/WEATHER.md) |
| Plant doctor | Merged; 007-doctor.df loaded in the live DB, tested on real OpenEdge; see [docs/DOCTOR.md](docs/DOCTOR.md) |
| Similar past cases | Description embeddings on Diagnosis (schema `009-similar.df`, load with `load-similar`). Compares a written description of the photos, not the pixels. No key: crop and condition. See [docs/DOCTOR.md](docs/DOCTOR.md) |
| MCP server | Same assistant tools over stdio or Streamable HTTP (`APP_TOKEN`). See [docs/MCP.md](docs/MCP.md) |
| Farm watch | Off unless `FARM_WATCH_INTERVAL_MIN` is set. Manual: `POST /api/v1/assistant/watch/run`. Opens cases only; the farmer still approves. See [docs/ASSISTANT.md](docs/ASSISTANT.md) |
| Live ESP32 field dashboard | Page `/#/sensors` embeds the device page. The server only publishes `ESP32_DASHBOARD_URL`. It does not proxy the hotspot. See [docs/ESP32.md](docs/ESP32.md) |
| PASOE security | Basic login (`farmapi`, `farmadmin`), role check in ABL for admin changes, real user in the audit log; see [openedge/pasoe/README.md](openedge/pasoe/README.md) |
| Planned features 18, 19, 20 (rest), 22 | **Not built yet**; ideas and plans in [docs/OLD-APP-IDEAS-PLAN.md](docs/OLD-APP-IDEAS-PLAN.md) |

Tests (28 Oct 2026, this branch, mock OpenEdge only): `npm test` 553 passed, 0 failed, 3 intentional failures (by design). Schema `009-similar.df` and the new ABL have not been executed on real OpenEdge here. The 26 Oct 2026 real OpenEdge run was: 259 contract cases passed plus the intentional FAIL01, in batch mode on the live database, on a scratch database and over HTTP through PASOE with basic login (co-op CO01-CO76: 76 passed, market MK01-MK51: 51 passed); audit tamper test 0 failed; PASOE security checks 10 of 10; API suites against real PASOE 21 + 17 passed. `npm test` that day was 480 passed.

```
ESP32 or simulator --POST /api/v1/readings--> Node API (Fastify, port 3000)
                                                |  reads plot limits, latest reading and 7-day water use from OpenEdge
                                                |  asks the AI for a JSON proposal (Gemini, or a built-in mock)
                                                |  checks the proposal's shape and the numbers in its explanation
                                                v
                                OpenEdge (PASOE WebHandler -> farm-api.p -> database `farm`)
                                                |  ABL rules approve or reject, and list every failing reason
                                                v
                                Farmer approves: step 1 returns a single-use token, step 2 re-runs the rules and applies
```

If the AI is slow, returns something that is not valid JSON, proposes a forbidden action, or invents a number, the API falls back to a fixed, rule-based proposal. OpenEdge still validates it.

## Quick start (no OpenEdge, no key, no hardware)

You need Node.js 20 or newer on any operating system.

```bash
npm install
npm run setup     # creates .env with random tokens; .env is never committed
npm test          # offline checks using a Node port of the OpenEdge rules and the mock AI
npm start         # API on http://localhost:3000
```

In a second terminal, from the same folder:

```bash
npm run demo      # reading -> AI proposal -> rules -> two-step approval -> audit trail
```

Then open **<http://localhost:3000/>** for the web interface (dashboard, plots, AI suggestions with the OpenEdge rule check, two-step approval, audit log, English / isiZulu). See [`docs/UI.md`](docs/UI.md).

By default `OE_MODE=mock` and `AI_PROVIDER=mock`, so the API runs entirely in memory. This is a stand-in so that anyone can run the project. The real OpenEdge setup is described below.

## Prerequisites

| For | You need |
|---|---|
| Quick start, tests, simulator | Node.js 20 or newer (tested on 20.19 and 24). Two runtime dependencies: Fastify and Ajv. |
| Real OpenEdge mode | Windows with OpenEdge 12.8 (database, ABL and PAS for OpenEdge), and Java 17 for PASOE (the project used Eclipse Temurin 17.0.20.1). |
| Real AI | An API key for any OpenAI-compatible `/chat/completions` endpoint. The project used Google Gemini `gemini-3.5-flash`. |
| ESP32 firmware | PlatformIO, an ESP32 board, a DHT22 sensor and an analog soil-moisture sensor. |

## Configuration

`npm run setup` creates `.env` from `.env.example` and adds random tokens. Real environment variables win over `.env`. Never commit `.env`.

| Variable | Meaning | Default |
|---|---|---|
| `PORT`, `HOST` | API listen address | `3000`, `0.0.0.0` |
| `OE_MODE` | `mock` (Node port of the rules, in memory) or `pasoe` (real OpenEdge over HTTP) | `mock` |
| `OE_BASE_URL` | PASOE base URL; the service is at `/web/farm/*` | `http://localhost:8820/web` |
| `OE_AUTH` | `user:password` for PASOE basic login (`farmapi`, PSCUser). Empty only with the anonymous login model. | empty |
| `OE_ADMIN_AUTH` | `user:password` with PSCAdmin (`farmadmin`), used for blocked-terms and alert-threshold changes | empty |
| `OE_NONE_AUTH` | `user:password` of a `ROLE_None` user, only for the 403 test | empty |
| `APP_TOKEN` | Bearer token the farmer app sends. `npm run setup` generates it. | none |
| `DEVICE_REGISTRY` | JSON array that maps a device token to a device and a plot, for example `[{"deviceId":"esp32-01","plotId":1,"token":"..."}]` | generated by `npm run setup` |
| `AI_PROVIDER` | `mock` or `http` | `mock` |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | Used when `AI_PROVIDER=http`. The key is read only from the environment or `.env` and is never logged. | empty |
| `AI_MOCK_BEHAVIOUR` | Mock only: `normal`, `timeout`, `bad-json`, `injection`, `extra-field`, `greedy`, `invented-number`, `hold-with-litres`, `notify-no-litres` | `normal` |
| `SIMILAR_CASES` | `on` (default) looks for similar plant-doctor cases. `off` skips that and does not call the embedding model | `on` |
| `AI_EMBED_MODEL`, `AI_EMBED_DIM`, `AI_EMBED_TIMEOUT_MS` | Text embedding of the photo **description**. Does not change `AI_MODEL`. Default model `gemini-embedding-001`, 256 numbers, 8 s | see `.env.example` |
| `FARM_WATCH_INTERVAL_MIN` | How often the farm watch opens cases. **0 = off** (the demo default). It does not run at process start | `0` |
| `FARM_WATCH_DEDUPE_HOURS` | Do not open another case for the same issue while one is open, or until this many hours after a closed one | `24` |
| `MCP_HTTP_HOST`, `MCP_HTTP_PORT` | Used only by `npm run mcp:http`. Bearer token is `APP_TOKEN` | `127.0.0.1`, `3001` |
| `LOG_DIR`, `LOG_LEVEL` | Tool-call log folder (`logs/tool-calls.jsonl`, gitignored) and log level | `logs`, `warn` |
| `ESP32_DASHBOARD_URL` | Address of the ESP32. The browser reads `/data` from it. The API never connects to it. Station-mode boards are also at `http://mzansi-farm.local`. See [docs/ESP32.md](docs/ESP32.md) | `http://192.168.4.1` |

## Using the real Gemini model

Add these to `.env` (use your own key; never paste it into a file that is committed):

```
AI_PROVIDER=http
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_MODEL=gemini-3.5-flash
AI_API_KEY=<your key>
```

Then run `npm run test:gemini` for one live call in English and isiZulu. That test is skipped (exit code 0) unless `AI_PROVIDER=http` and all three AI variables are set. The automated tests always use the mock AI so that results are repeatable.

## Using real OpenEdge (Windows, OpenEdge 12.8)

The database is called `farm`. The project ran it as a multi-user server on port 20000, with PASOE instance `farmops` on HTTP port 8820. The exact PASOE configuration, including basic login and roles, is in `openedge/pasoe/README.md`. In PowerShell, from the repository root:

```powershell
.\scripts\oe-run.ps1 -Action start-db     # database server on port 20000
.\scripts\oe-run.ps1 -Action seed         # reset to the example data, including the co-op seed (before each test run and before the demo)
.\scripts\oe-run.ps1 -Action test         # every contract case, including CO01-CO76, against the ABL code in batch mode
.\scripts\oe-run.ps1 -Action test-coop    # reseed, then only the 76 co-op cases
.\scripts\oe-run.ps1 -Action test-market  # reseed, then only the 51 market cases
.\scripts\oe-run.ps1 -Action scratch-test # every case on a throw-away database (never touches farm or PASOE)
# Start the PASOE instance `farmops` (tcman.bat start), then:
$env:OE_BASE_URL = 'http://localhost:8820/web'
.\scripts\oe-run.ps1 -Action test-http    # reseed, then every case over HTTP through FarmHandler.cls (OE_AUTH from .env)
.\scripts\oe-run.ps1 -Action test-security # 401 / 403 / admin-role checks, then reseed
npm run test:oe-http                      # the same HTTP cases; reseed first, this command does not
$env:OE_MODE = 'pasoe'; npm start         # API backed by the real database
npm run demo
```

Stop the database server before a schema load. An existing database that already has `002-farm-ops.df`: `.\scripts\oe-run.ps1 -Action load-coop` (loads `003-coop.df` only). A database that does not have `002` yet: `.\scripts\oe-run.ps1 -Action load-schema` (`002` then `003`). Then start the server and run `seed`. Co-op rules and the full steps are in `docs/COOP.md`. The PASOE PROPATH points at this repository's `openedge/src`. After you change ABL code, run `compile-check.p` (`farm-api.p` includes `coop.i` and `market.i`) and refresh the agent sessions if needed.

The API must run on the same machine as PASOE, or be given an `OE_BASE_URL` it can reach. A cloud machine cannot reach the laptop's localhost.

## The rules (in OpenEdge, `openedge/src/farm-api.p`)

| Code | Meaning |
|---|---|
| `PLOT_NOT_FOUND` | The plot must exist. |
| `ACTION_NOT_ALLOWED` | Only `irrigate`, `hold` and `notify` are allowed. Anything else, such as `apply_pesticide`, is refused. |
| `LITRES_OUT_OF_RANGE` | Irrigation must be between 1 litre and the plot's maximum. |
| `NO_SENSOR_DATA` | Irrigation needs at least one reading. |
| `SENSOR_STALE` | The latest reading must be at most 15 minutes old. |
| `SOIL_NOT_DRY` | Soil moisture must be below the plot's dry threshold. |
| `RAIN_DETECTED` | The latest reading must not report rain. |
| `WATER_BUDGET_EXCEEDED` | Approved litres in the last 7 days plus this request must not exceed the plot's weekly budget. Equal is allowed. |

All failing rules are reported, not only the first. `hold` and `notify` skip the water checks. Approval re-runs the rules at approval time, because the data may have changed.

The seed data has five fictional plots (Maize A, Beans B, Spinach C, Tomato D, Cabbage E) on one fictional farm.

Co-op rules (members, credit, harvest lots, buyer contracts, pro-rata allocation, payouts) are in the same OpenEdge program. They are described in `docs/COOP.md`. A create does not approve anything. The farmer or an admin approves in a separate call. There is no co-op screen.

The **community harvest-day market** (farmers list a market day with produce priced below the retail-buyer price, optional reservations, optional link to a co-op lot) is in the same OpenEdge program and has its own screens under Market. See `docs/MARKET.md`.

**Weather alerts** (no AI): OpenEdge checks the real 7-day Open-Meteo forecast (or the synthetic example forecast offline) against the farmer's alert levels for heavy rain, heat and frost, writes the alerts and the audit, and the farmer acknowledges them. See `docs/WEATHER.md`.

**Plant doctor** (`#/doctor`): 1 to 3 photos plus crop, plant part, growth stage and province go to the AI. The API strips dose steps, OpenEdge enforces DOSE_BLOCKED from the BlockedTerm word list, a safe fallback answer replaces anything unsafe, and the farmer saves or dismisses. When similar past cases exist they are listed under the answer (a written description of the photos when a key is set, otherwise crop and condition). See `docs/DOCTOR.md`.

**Farm watch** (`POST /api/v1/assistant/watch/run`): looks at sensors, the forecast, nearby reports, similar cases and the guides, then opens an assistant case if something needs the farmer. The schedule is off unless `FARM_WATCH_INTERVAL_MIN` is set. Cards still wait for approval. See `docs/ASSISTANT.md`.

**MCP**: `npm run mcp` (stdio) or `npm run mcp:http` exposes the assistant tools, including `find_similar_cases`. `propose_action` still does not do the action. See `docs/MCP.md`.

## Demo script

Use this order for a live demo. Times in the seed data are fixed to 23 October 2026, so you need a fresh reading to get an irrigation proposal (step 2 does this).

1. **Start clean.** Restart the API in mock mode, or run the `seed` action in OpenEdge mode. This resets the 7-day water budget.
2. **Show the loop in one command.** Run `npm run demo`. It prints six steps and ends with `DEMO COMPLETED`:
   1. Health check, which shows the OpenEdge mode and the AI provider.
   2. The device `esp32-01` posts a dry reading for plot 1 (soil 17.5%).
   3. The AI proposes an action and OpenEdge validates it. In our run this was "irrigate 260 L, approved by rules".
   4. Approval step 1 returns a confirmation token and changes nothing.
   5. Approval step 2 re-runs the rules and approves.
   6. The audit trail shows every tool call and decision.
3. **Show a refusal.** Start the API with `AI_PROVIDER=mock` and `AI_MOCK_BEHAVIOUR=greedy` so the mock AI always asks for the maximum amount. Post a reading with soil moisture 60% for plot 1 (see the curl example in `docs/API.md`), then call `POST /api/v1/plots/1/advise`. OpenEdge rejects it with `SOIL_NOT_DRY` and the suggestion cannot be approved.
4. **Show the guardrails** (optional). Try other `AI_MOCK_BEHAVIOUR` values. `injection` makes the mock AI propose a forbidden action, and the API falls back to a safe proposal (`ai.usedFallback: true`).
5. **Show the sensor feed.** Run the simulator, or the real ESP32 if one is available:
   ```bash
   DEVICE_TOKEN=<token from DEVICE_REGISTRY in .env> node sim/esp32-sim.js --scenario drought --url http://localhost:3000 --interval 2 --count 10
   ```
   Scenarios are `normal`, `drought`, `stale` and `invalid`. See `docs/ESP32.md`.

A note on the water budget: plot 1 already has 1000 litres of approved irrigation in the seed data (dated 21 October), against a weekly budget of 1500. A demo approval uses part of the remainder, so a second run without resetting can be refused for budget. Reset between runs.

If the API is started without a fresh reading, the seed readings are old and the AI correctly proposes `notify` ("check the sensor") instead of irrigation.

## ESP32 and simulator

The firmware reads soil moisture, temperature and humidity every 30 seconds and posts JSON to the API with an `X-Device-Token` header. The simulator sends the same payload without hardware.

```bash
cd firmware/esp32
cp include/config.example.h include/config.h    # config.h is gitignored; edit it before flashing
pio run -e esp32dev                              # compile
pio test -e native                               # 15 unit tests of the payload builder (runs on the host)
```

Edit `config.h` with your Wi-Fi name and password, the laptop's address, the device token, device id and plot id. The ESP32 supports 2.4 GHz Wi-Fi only. On Windows, allow inbound TCP port 3000 in the firewall. Wiring, calibration and the full API contract for devices are in `docs/ESP32.md`.

## Tests

| Command | What it does |
|---|---|
| `npm test` | Everything that works offline. 28 Oct 2026 on this branch: 553 passed, 0 failed, 3 intentional failures confirmed. |
| `npm run test:oe-http` | Every OpenEdge contract case, including `CO01` to `CO76`, over HTTP against a running PASOE. Reseed first. |
| `npm run test:api-real-oe` | The API test suites against real PASOE. |
| `npm run test:gemini` | One live call to the real model. Skipped without the AI variables. |
| `cd firmware/esp32 && pio test -e native` | Firmware payload-builder unit tests. Needs PlatformIO and a host C++ compiler. |

Three cases are designed to fail (`FAIL01` and `E20`, the last in two modes). They show that the test runner reports failures honestly, so "3 intentional failures confirmed" is the expected result.

## Project layout

| Path | Content |
|---|---|
| `apps/api/` | Fastify API and the AI layer |
| `apps/web/public/` | The web interface (static HTML, CSS and JavaScript, photos, fonts; served by the API at `/`) |
| `openedge/` | Schema, seed data, ABL code, PASOE handler map |
| `mock-pasoe/` | Node port of the ABL rules, used by `npm test` |
| `eval/` | Test cases (`*.json`) and runners |
| `firmware/esp32/`, `sim/` | ESP32 firmware and the simulator |
| `scripts/` | `setup-env.mjs`, `demo.mjs`, `oe-run.ps1`, `gen-seed.mjs` |
| `docs/` | API contract, OpenEdge contract, ESP32 guide, re-hosting guide, engineering notes, demo screens |

## Languages

The UI has a picker for all 11 official South African languages. Reviewed isiZulu lines are used where they exist; everything else, including market day names and notes, is translated on demand by the configured AI provider through `POST /api/v1/translate`, cached, and marked "Translated by AI" with a "Show original" switch. English is the default. AI translations still need native-speaker review. See [docs/TRANSLATION.md](docs/TRANSLATION.md).

For real translation with Gemini, set in your local `.env` only: `AI_PROVIDER=http`, `AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `AI_MODEL=gemini-3.5-flash-lite`, `AI_API_KEY=<your key>`. `AI_TRANSLATE_TIMEOUT_MS` (default 20000) is the per-batch translation timeout; advice keeps its 8 s limit.

## Documentation

| Doc | What |
|---|---|
| [`docs/ASSISTANT.md`](docs/ASSISTANT.md) | Farm Assistant: chat, tool loop, guide search (RAG) in OpenEdge, approval cards, case files, check-ins; guide sources and licence. |
| [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) | What is real, what is mocked, and what this project does not do. Read this before relying on it. |
| [`docs/NOTES.md`](docs/NOTES.md) | Stack versions, rules, environment variables, test results |
| [`docs/REHOSTING.md`](docs/REHOSTING.md) | Bring the Windows demo back on a Windows Server 2022 VM after the public host was shut down |
| [`docs/API.md`](docs/API.md) | HTTP API |
| [`docs/OE-CONTRACT.md`](docs/OE-CONTRACT.md) | Contract between the API and OpenEdge |
| [`docs/COOP.md`](docs/COOP.md) | Co-op rules, endpoints, and how to run them on OpenEdge 12.8 |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Tamper-evident audit log: hash chain, verify endpoint, tamper test, live schema load |
| [`docs/MARKET.md`](docs/MARKET.md) | Harvest-day market: decisions, rules, endpoints, screens, isiZulu drafts |
| [`docs/WEATHER.md`](docs/WEATHER.md) | Weather alerts: example forecast, ABL rules, thresholds, endpoints, live schema steps |
| [`docs/DOCTOR.md`](docs/DOCTOR.md) | Plant doctor: photos, three-layer DOSE_BLOCKED guardrail, fallback, farmer approval, photo credit |
| [`docs/ESP32.md`](docs/ESP32.md) | Firmware, wiring and simulator |
| `docs/screens/` | Approved demo screens (design mockups) and photo credits |
| `docs/UI.md` | The web interface: pages, token handling, demo tools, isiZulu, photo credits |

## Secrets

`.env`, `firmware/esp32/include/config.h`, logs and build output are gitignored. Keys, tokens and Wi-Fi details are read only from the environment or from those files. Do not commit them.

## Licence

TODO: the team has not chosen a licence yet.
