# Farm Assistant

A chat-first assistant for the farmer. It checks the farm, answers from farming guides kept in OpenEdge, and only proposes actions. **Nothing changes on the farm until the farmer approves.** It never gives chemical doses.

## How a turn works
1. The farmer types a message in any of the 11 languages (UI: Farm Assistant page). The page shows "Let me check your farm..." straight away.
2. `POST /api/v1/assistant/chat` runs the tool loop (`apps/api/src/assistant/`):
   * **AI on** (`AI_PROVIDER=http`, Gemini OpenAI-compatible endpoint): function calling over the tool registry, at most `STEP_LIMIT = 6` steps.
   * **Offline / mock / any AI failure**: a deterministic planner calls the same tools in a fixed order and produces the same kind of cards.
   * Tools: `get_farm_profile`, `get_sensor_readings`, `get_forecast`, `run_plant_doctor`, `search_guides`, `get_nearby_reports`, `get_case`, `list_harvest_days`, `propose_action`, `remember`, `find_similar_cases`. Each call goes through the audited OpenEdge client and is listed under "What I checked" in the reply and in the case file.
   * `find_similar_cases` looks up past plant-doctor cases. When a description embedding is stored it ranks those by cosine similarity of the **written description** of the photos. With no embedding it matches the same crop and overlapping condition words. It does not compare photo pixels. See [docs/DOCTOR.md](DOCTOR.md).
3. The AI answer is checked by the server: it must only cite passages that `search_guides` returned this turn, and no dose words. Otherwise the planner answers instead (`usedFallback`, `fallbackReason`).
4. The case file is saved in OpenEdge (`POST /farm/assistant/cases`). ABL checks again: every citation id must exist (`CITATION_UNKNOWN`), no dose text (`DOSE_BLOCKED`). On a 422 the turn is redone offline.
5. Approval cards:
   * irrigate / hold / notify become a normal suggestion. The OpenEdge irrigation rules check it first. A rejection is final and shows the rule reasons. If it passes, the farmer uses the usual two-step approval on the suggestion page.
   * step / contact_expert / list_harvest_day: Accept or Decline, saved in the case file and the audit log.
6. Follow-ups: each case gets a follow-up question (3 days). The farmer answers it on the case file screen and can mark the problem solved.

## Guide search (RAG) in OpenEdge
* Schema `openedge/schema/008-assistant.df`: `GuidePassage` with a WORD index on `SearchText`, `GuideSynonym`, `GuideStopword`, `AssistantCase`, `CaseFollowUp`, `FarmerMemory`.
* `POST /farm/guide/search {q}` (ABL `CONTAINS`, plus synonyms and singular/plural) returns the top 3 passages. `mock-pasoe/assistant.js` gives the same results (contract cases AS01 to AS42).
* Seed: `openedge/data/guide-seed.json`. There are 51 passages quoted word for word from 15 English Wikipedia articles. Each passage stores the article title, section, a fixed-revision URL (`oldid`) and the licence **CC BY-SA 4.0**. Sentences that name chemicals or sprays were left out. Nothing is invented.

## Memory and check-ins
* Memory is stored per farm in OpenEdge (`FarmerMemory`), using `remember` or `POST /api/v1/assistant/memory`.
* Check-ins: `ASSISTANT_CHECKIN_MS` (default 15 min, 0 = off) runs a job in the API. The first look only records the current state. After that it adds a message to the Check-ins inbox only when something is new: a frost or heat alert, a plot that just went dry, or a follow-up that is due. It is read-only.

## Farm watch
A background look that opens a case file only when something needs the farmer. It uses the same tools (sensors, forecast, nearby reports, similar cases, guides) and the **offline planner**, including when an AI key is set, so a missing or slow model cannot change the result. Every proposal still goes through `propose_action`. OpenEdge applies `DOSE_BLOCKED`, `CITATION_UNKNOWN` and the irrigation rules. Nothing is watered or sent until the farmer approves the card.

What it looks for:
* **Stale sensor** — the latest reading is older than 15 minutes (the same limit as `SENSOR_STALE`). One open case for the farm, a `notify` card. The example seed readings are old, so this is the case a normal demo opens.
* **Dry soil with no rain in the forecast** — the reading is fresh, soil is under the plot's dry limit, it is not raining, and no forecast day has 1 mm of rain or more. The planner may propose irrigation. OpenEdge still accepts or rejects it. The example forecast includes rain, so this case does not open on the seed data.
* **Disease reported nearby** — a plant-doctor diagnosis exists. The planner opens a sick-plant case (cultural steps and "ask an expert"), and `find_similar_cases` runs as one of the checks.

Dedupe: `FARM_WATCH_DEDUPE_HOURS` (default 24). An open case with the same title prefix blocks another one. A case that is no longer open also blocks until the window has passed. At most 3 cases are opened per run.

Schedule: `FARM_WATCH_INTERVAL_MIN` (default **0**, off). The job does not run at startup. The demo trigger is `POST /api/v1/assistant/watch/run` with the app token. Each run is written to `logs/tool-calls.jsonl` as `assistant.watch`, and the tool calls inside it are logged the same way as a chat turn.

The Farm Assistant page shows a **Farm watch** card only when an open case from this job exists. The card links to the case file, where the approval buttons are the ones the chat already uses.

## MCP
The same tools are exposed by a small MCP server (`npm run mcp` for stdio, `npm run mcp:http` for Streamable HTTP). Connecting a client is described in [docs/MCP.md](MCP.md). `propose_action` still does not execute anything.

## Honest limits
* The guides are general encyclopedia text, not local extension advice. The assistant says when it is not sure and suggests the extension officer.
* "Ask an expert" and "notify" do not send any message. No SMS, WhatsApp or email is sent.
* Voice input is not built yet.
* The isiZulu synonyms in the seed (umswakama, isithwathwa, ukoma) need review by a first-language speaker.
* Chat history is kept in the browser tab only. Case files and memory are kept in OpenEdge.
* Single farm (farmId 1), as in the rest of the demo.

## Tests
`eval/assistant.test.mjs`, `eval/similar.test.mjs`, `eval/watch.test.mjs` and `eval/mcp.test.mjs` (in `npm test`). Contract cases AS01 to AS42 and SC01 to SC04 run against mock-pasoe. Real ABL still needs schema 009 loaded before `oe-run.ps1 -Action test`.
