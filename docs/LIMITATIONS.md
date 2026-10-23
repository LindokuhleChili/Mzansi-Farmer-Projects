# Limitations

This is a hackathon prototype. It shows one idea: an AI model may propose, OpenEdge rules decide what is allowed, and the farmer approves. This note lists what is real, what is mocked and what is missing, so nobody relies on more than the project does.

**All data is fictional example data.** The farm, plots, readings and the user "Nomsa" are made up. Do not use this system to make real irrigation decisions.

## What is real and what is mocked

| Piece | Status |
|---|---|
| OpenEdge database, schema, ABL rules, PASOE WebHandler | Real. Tested on OpenEdge 12.8: the original 47 contract cases in batch mode and over HTTP through PASOE (46 pass plus 1 case designed to fail). API suites also passed against real PASOE. The demo has been run against it. 14 contract cases were added with the QA bug fixes (see `docs/NOTES.md` 6a): the ABL changes behind them (budget sum counts irrigation only, real calendar check) are written but **not yet run on real OpenEdge**; mock-pasoe passes all of them. |
| `mock-pasoe` (Node port of the ABL rules) | A stand-in. `npm test` uses it so the repository can be tested anywhere. The same 61 cases run against both and must agree. |
| Node API, confirmation steps, audit log, fallback logic | Real code, tested in-process and over HTTP. |
| AI model | Real Gemini (`gemini-3.5-flash`) in `npm run test:gemini` and when `.env` sets `AI_PROVIDER=http`. All automated tests use a deterministic mock so results can be repeated. |
| ESP32 firmware | Compiled and unit-tested on a host computer only. It has not been run on a physical board in this project's tests. |
| ESP32 simulator | A real HTTP client with its own tests. It is not a sensor. |
| Demo screens in `docs/screens/` | Static design mockups (PNG). There is no web or mobile front end in this repository. The API is the product surface. |

## The AI layer

- **No RAG.** There is no vector database, no embeddings and no document store. Facts are fetched from OpenEdge for each request (plot limits, latest readings, approved water use over 7 days, a computed trend) and given to the model as the only allowed source of numbers. Retrieving farming guidance with citations is a sensible next step but is not built.
- **Model choice.** `gemini-3.8-flash` and `3.7-flash` were overloaded during development, so `gemini-3.5-flash` is used. Free-tier limits and availability can change. If the model fails or takes longer than 8 seconds, the API uses a fixed, rule-based proposal that OpenEdge still validates (`ai.usedFallback: true`).
- **The model can pick a poor amount that the rules still allow.** In one live run the model proposed the maximum 500 litres where the fixed sizing would give 260 litres. The rules accepted it because it was inside the plot limit and the weekly budget, and the farmer still has to approve. The project does not tune the amount beyond the rules.
- **The checks cover known failures only.** Tests cover invalid output, extra fields, a forbidden action (prompt injection) and invented numbers. They do not prove the model is safe against every input.
- **isiZulu text needs review by a native speaker.** The isiZulu strings (templates, screens and AI answers) were written without one. The API adds a note that the text is a draft. Do not treat it as final.

## OpenEdge and the demo setup

- **The demo PASOE instance allows anonymous access.** `/web/**` is set to `permitAll()` (see `openedge/pasoe/README.md`). This is acceptable only because the instance listens on the laptop and the Node API is the only caller. For anything real, use basic or form login and set `OE_AUTH`.
- **Development licence limits apply.** The PASOE instance runs with one agent and five concurrent requests. That is fine for a demo and not for production.
- **Only the OpenEdge side is a real rules engine.** Mock mode uses a Node copy of the rules. The two are tested against the same cases, but the copy could drift if one side is changed without the other.
- **Seed data is dated 23 October 2026.** The seed readings are old compared with the rule that readings must be 15 minutes old or less. Without a fresh reading, the system proposes `notify` instead of irrigation. The seed history also counts toward the 7-day water budget (plot 1 has 1000 litres approved on 21 October), so the room left in the budget depends on the date and on earlier demo runs. Reset the data before each run.
- **The weekly budget counts only approved suggestions** in a rolling 7 days.
- **The rules are simple.** They cover freshness, dryness, rain, litres and a weekly budget per plot. They do not model soil type, crop stage, weather forecasts, water restrictions, or equipment limits.

## Data, devices and hardware

- **Soil calibration is not done.** The defaults (`SOIL_RAW_DRY` 3200 and `SOIL_RAW_WET` 1300) are typical values for capacitive modules. They must be calibrated with the real probe.
- **Temperature limits differ.** The firmware accepts -40 to 80 C. The API accepts -20 to 60 C and returns a 400 error with the field name for values outside that range.
- **One device per plot in the demo.** The device registry maps a token to one device and one plot. There is no device onboarding.
- **Wi-Fi and network.** The firmware needs 2.4 GHz Wi-Fi and a network where the laptop is reachable. It also needs the clock to sync before it sends a reading.

## Security and privacy

- **Device authentication is a shared token per device over plain HTTP** on a local network. There is no TLS, no rate limiting and no token rotation.
- **There is one app token** (`APP_TOKEN`), not user accounts or roles. The farmer app is a single caller.
- **Confirmation tokens live in memory.** They last 120 seconds and work once. Restarting the API invalidates pending tokens. Suggestions, readings and the audit log are stored in OpenEdge and survive restarts (in mock mode, they are lost on restart).
- **Secrets stay out of Git by design,** but this depends on `.gitignore` and on people following it. Run a secrets check before every push.

## Testing

- Error handling is tested for the cases in `eval/*.json`, not for every possible network failure.
- The count of 184 offline checks was taken at the last run and uses the mock AI and the mock OpenEdge. The real OpenEdge and real Gemini results were recorded on the team's laptop and are not repeated by `npm test`.
- Three cases are designed to fail so the test runner can be seen to report failures. A run that shows "3 intentional failures confirmed" is a pass.

## Content and licence

- The photos in `docs/screens/` are Pexels stock photos (see `docs/screens/credits.md`). They are not South African fields, and some were taken in Kenya and Nigeria. The example user's avatar is a stock portrait.
- The screens use plot names that differ slightly from the seed data. The API data has five plots: Maize A, Beans B, Spinach C, Tomato D and Cabbage E.
- No licence has been chosen for this repository yet.

## Not built

- A web or mobile front end
- Retrieval from farming documents (RAG)
- Real-time actuation (the system records an approval; it does not open a valve)
- Multi-farm or multi-user support
- Production deployment, monitoring and backups
