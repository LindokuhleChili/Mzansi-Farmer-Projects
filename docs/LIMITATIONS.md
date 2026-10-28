# Limitations

This is a hackathon prototype. It shows one idea: an AI model may propose, OpenEdge rules decide what is allowed, and the farmer approves. This note lists what is real, what is mocked and what is missing, so nobody relies on more than the project does.

**All data is fictional example data.** The farm, plots, readings and the user "Nomsa" are made up. Do not use this system to make real irrigation decisions.

## What is real and what is mocked

| Piece | Status |
|---|---|
| OpenEdge database, schema, ABL rules, PASOE WebHandler | Real for irrigation. Tested on OpenEdge 12.8: the original 47 contract cases in batch mode and over HTTP through PASOE (46 pass plus 1 case designed to fail). API suites also passed against real PASOE. The demo has been run against it. 14 contract cases were added with the QA bug fixes (see `docs/NOTES.md` 6a): those 61 pass on real OpenEdge too (60 pass plus 1 designed to fail, in batch mode and over HTTP). Co-op rules are in `openedge/src/coop.i` (included by `farm-api.p`) and schema `003-coop.df`. They are compiled and run on OpenEdge 12.8: on 25 and 26 Oct 2026 all 76 cases `CO01` to `CO76` passed in batch mode on the live database and over HTTP through PASOE, as part of the full 259-case run (plus the intentional FAIL01; market MK01-MK51 51 passed). See `docs/COOP.md`. |
| `mock-pasoe` (Node port of the ABL rules) | A stand-in. `npm test` uses it so the repository can be tested anywhere. The irrigation cases and the 76 co-op cases run against it. `eval/compare-oe.mjs` is what compares a real OpenEdge batch file or a live PASOE HTTP response with those cases. |
| Node API, confirmation steps, audit log, fallback logic | Real code, tested in-process and over HTTP. |
| AI model | Real Gemini (`gemini-3.5-flash`) in `npm run test:gemini` and when `.env` sets `AI_PROVIDER=http`. All automated tests use a deterministic mock so results can be repeated. |
| ESP32 firmware | Compiled and unit-tested on a host computer only. It has not been run on a physical board in this project's tests. |
| ESP32 simulator | A real HTTP client with its own tests. It is not a sensor. |
| Demo screens in `docs/screens/` | Static design mockups (PNG). |
| Web interface (`apps/web/`, `docs/UI.md`) | Real page code served by the API at `/`. Only exercised in a headless browser against the mock OpenEdge and mock AI so far; there is no native mobile app. |

## The AI layer

- **Guide text is not a vector database.** Farming guides are still the OpenEdge WORD index (`search_guides`, schema 008). Facts for irrigation (plot limits, readings, 7-day water use) still come from OpenEdge on each request. The only vectors in this repo are **description embeddings** on plant-doctor rows (schema 009): a short written description of the photos, not the photo itself, ranked in the Node API by cosine. See docs/DOCTOR.md. There is no separate vector database.
- **Model choice.** `gemini-3.8-flash` and `3.7-flash` were overloaded during development, so `gemini-3.5-flash` is used. Free-tier limits and availability can change. If the model fails or takes longer than 8 seconds, the API uses a fixed, rule-based proposal that OpenEdge still validates (`ai.usedFallback: true`).
- **The model can pick a poor amount that the rules still allow.** In one live run the model proposed the maximum 500 litres where the fixed sizing would give 260 litres. The rules accepted it because it was inside the plot limit and the weekly budget, and the farmer still has to approve. The project does not tune the amount beyond the rules.
- **The checks cover known failures only.** Tests cover invalid output, extra fields, a forbidden action (prompt injection) and invented numbers. They do not prove the model is safe against every input.
- **isiZulu text needs review by a native speaker.** The isiZulu strings (templates, screens and AI answers) were written without one. The API adds a note that the text is a draft. Do not treat it as final.

- **Translation.** Languages other than English and the reviewed isiZulu lines are machine-translated by the AI on demand. Quality varies by language and is not reviewed; numbers/prices/placeholders are checked, wording is not. The caches are in memory (server) and localStorage (browser). With the mock provider the "translation" is `[code] English`. Irrigation advice reasons are translated the same way after they are generated in English, so the wording of safety-relevant advice in those languages is unreviewed AI text; the numbers, litres and rule decisions come from OpenEdge and are not changed. See docs/TRANSLATION.md.

- **Audit hash chain** is tamper-evident, not tamper-proof: someone with direct database access could recompute every hash after an edit. Rows from before `005-audit-chain.df` are not covered (`legacy`). See docs/AUDIT.md.

## OpenEdge and the demo setup

- **PASOE uses basic login over plain HTTP.** `/web/**` needs `ROLE_PSCUser`; admin changes need `ROLE_PSCAdmin`, checked in ABL (see `openedge/pasoe/README.md`). Users and plain-text passwords are in the instance's `users.properties` (local authmanager), and the API calls as one service user (`farmapi`) on behalf of the farmer, so farmer decisions are audited as "farmer", not per person. For anything real: HTTPS, hashed passwords or an OERealm/LDAP authmanager, and one login per person.
- **Development licence limits apply.** The PASOE instance runs with one agent and five concurrent requests. That is fine for a demo and not for production.
- **Only the OpenEdge side is a real rules engine.** Mock mode uses a Node copy of the rules. The two are tested against the same cases, but the copy could drift if one side is changed without the other.
- **Seed data is dated 23 October 2026.** The seed readings are old compared with the rule that readings must be 15 minutes old or less. Without a fresh reading, the system proposes `notify` instead of irrigation. The seed history also counts toward the 7-day water budget (plot 1 has 1000 litres approved on 21 October), so the room left in the budget depends on the date and on earlier demo runs. Reset the data before each run.
- **The weekly budget counts only approved suggestions** in a rolling 7 days.
- **The irrigation rules are simple.** They cover freshness, dryness, rain, litres and a weekly budget per plot. They do not model soil type, crop stage, weather forecasts, water restrictions, or equipment limits.
- **Co-op rules are a second set on the same database** (`docs/COOP.md`): credit limit, lot versus contract, pro-rata shares, payouts, and a fair-allocation plan. They do not move money, call a bank, or update a buyer's system. A create stores a pending or rejected row. Approval is a separate call.
- **There is no co-op screen.** The web UI is still the irrigation demo. Co-op is the OpenEdge HTTP contract only.

## Data, devices and hardware

- **Soil calibration is not done.** The defaults (`SOIL_RAW_DRY` 3200 and `SOIL_RAW_WET` 1300) are typical values for capacitive modules. They must be calibrated with the real probe.
- **Temperature limits differ.** The firmware accepts -40 to 80 C. The API accepts -20 to 60 C and returns a 400 error with the field name for values outside that range.
- **One device per plot in the demo.** The device registry maps a token to one device and one plot. There is no device onboarding.
- **Wi-Fi and network.** The firmware needs 2.4 GHz Wi-Fi and a network where the laptop is reachable. It also needs the clock to sync before it sends a reading.
- **The live field page is not a sensor feed.** `/#/sensors` reads the ESP32 in the browser (`ESP32_DASHBOARD_URL`, or `http://mzansi-farm.local` on the farmer's Wi-Fi). The API never connects to that address, and those water and soil readings are not written to OpenEdge by the page. The separate `POST /api/v1/readings` feed is unchanged. See `docs/ESP32.md`.

## Security and privacy

- **Device authentication is a shared token per device over plain HTTP** on a local network. There is no TLS, no rate limiting and no token rotation.
- **There is one app token** (`APP_TOKEN`), not user accounts or roles. The farmer app is a single caller.
- **Confirmation tokens live in memory.** They last 120 seconds and work once. Restarting the API invalidates pending tokens. Suggestions, readings and the audit log are stored in OpenEdge and survive restarts (in mock mode, they are lost on restart).
- **Secrets stay out of Git by design,** but this depends on `.gitignore` and on people following it. Run a secrets check before every push.

## Testing

- Error handling is tested for the cases in `eval/*.json`, not for every possible network failure.
- The offline count in `docs/NOTES.md` section 6b is from `npm test` on this branch (mock AI, mock OpenEdge). The real OpenEdge irrigation results and the real Gemini result were recorded on the team's laptop and are not repeated by `npm test`. The co-op ABL has been executed on OpenEdge 12.8 (76 of 76 cases, batch and HTTP).
- Three cases are designed to fail so the test runner can be seen to report failures. A run that shows "3 intentional failures confirmed" is a pass.

## Content and licence

- The photos in `docs/screens/` are Pexels stock photos (see `docs/screens/credits.md`). They are not South African fields, and some were taken in Kenya and Nigeria. The example user's avatar is a stock portrait.
- The screens use plot names that differ slightly from the seed data. The API data has five plots: Maize A, Beans B, Spinach C, Tomato D and Cabbage E.
- No licence has been chosen for this repository yet.

## Not built

- Planned features 17-22, including weather alerts from a 7-day forecast and a tamper-evident hash chain on the audit log (see docs/OLD-APP-IDEAS-PLAN.md)
- Native-speaker review of the AI translations (only the hand-written isiZulu lines were drafted by hand, and they still need review)

- A co-op screen (the rules are HTTP only; see `docs/COOP.md`)
- A native mobile app (the web interface works in a phone browser)
- A vector database for the farming guides (guide search is the OpenEdge WORD index; plant-doctor similar cases are description embeddings on the Diagnosis row, docs/DOCTOR.md)
- Real-time actuation (the system records an approval; it does not open a valve)
- Multi-farm or multi-user support
- Production deployment, monitoring and backups

## Weather alerts
- The real forecast comes from Open-Meteo for one representative town per province, not for each farm's exact position. Without network access (or with `WEATHER_SOURCE=example`), the synthetic example file (`openedge/data/weather-seed.json`) is used. It is labelled "Example forecast data", and a reseed brings it back.
- Alerts are refreshed when the farmer presses "Check forecast". There is no scheduled job and no push or SMS.
- Alert levels apply to every farm. There are no per-farm or per-crop levels yet.

## Plant doctor
- The diagnosis is a guess from photos, not a lab test. The confidence is the AI's own guess.
- The word lists catch the dose wording they contain. New phrasings need words added by an admin, so the server check and the prompt stay as extra layers.
- No chemical advice is given at all, on purpose. Farmers who need a spray programme are sent to an extension officer.
- Photos are not stored, so a saved diagnosis cannot show the photos later. Similar-case search does not keep the photos either. It stores a written description and, when an API key is set, a text embedding of that description (`gemini-embedding-001` by default, 256 numbers). The chat model stays `AI_MODEL`. With no key, or if the embedding call fails, matching is crop plus condition words and the diagnosis still saves.
- The place in "Similar past cases" is the province saved on the diagnosis, not a farm GPS pin.

## Farm Assistant
- Guide passages are quoted from English Wikipedia (CC BY-SA 4.0). They are general text, not local extension advice.
- "Ask an expert" and "notify" cards send nothing. Voice input is not built. The isiZulu synonyms need review by a first-language speaker.
- Chat history is kept only in the browser tab. Case files, follow-ups and memory are kept in OpenEdge. See docs/ASSISTANT.md.
- **Farm watch does not run on a timer unless `FARM_WATCH_INTERVAL_MIN` is set** (default 0). The manual route opens cases; it does not approve them. It always uses the offline planner, even when a key is configured, so the background job does not call the chat model. Dry-soil cases need a fresh reading and a forecast with under 1 mm of rain; the example forecast has more rain than that, so a demo on seed data opens a stale-sensor case instead.
- The MCP server is another door to the same tools. Streamable HTTP checks `APP_TOKEN`. stdio trusts the process environment (the same `.env` as the API). It does not add a second rules engine. See docs/MCP.md.
