# Farm Assistant

A chat-first assistant for the farmer. It checks the farm, answers from farming guides kept in OpenEdge, and only proposes actions. **Nothing changes on the farm until the farmer approves.** It never gives chemical doses.

## How a turn works
1. The farmer types a message in any of the 11 languages (UI: Farm Assistant page). The page shows "Let me check your farm..." straight away.
2. `POST /api/v1/assistant/chat` runs the tool loop (`apps/api/src/assistant/`):
   * **AI on** (`AI_PROVIDER=http`, Gemini OpenAI-compatible endpoint): function calling over the tool registry, at most `STEP_LIMIT = 6` steps.
   * **Offline / mock / any AI failure**: a deterministic planner calls the same tools in a fixed order and produces the same kind of cards.
   * Tools: `get_farm_profile`, `get_sensor_readings`, `get_forecast`, `run_plant_doctor`, `search_guides`, `get_nearby_reports`, `get_case`, `list_harvest_days`, `propose_action`, `remember`. Each call goes through the audited OpenEdge client and is listed under "What I checked" in the reply and in the case file.
3. The AI answer is checked by the server: it must only cite passages that `search_guides` returned this turn, and no dose words. Otherwise the planner answers instead (`usedFallback`, `fallbackReason`).
4. The case file is saved in OpenEdge (`POST /farm/assistant/cases`). ABL checks again: every citation id must exist (`CITATION_UNKNOWN`), no dose text (`DOSE_BLOCKED`). On a 422 the turn is redone offline.
5. Approval cards:
   * irrigate / hold / notify become a normal suggestion. The OpenEdge irrigation rules check it first. A rejection is final and shows the rule reasons. If it passes, the farmer uses the usual two-step approval on the suggestion page.
   * step / contact_expert / list_harvest_day: Accept or Decline, saved in the case file and the audit log.
6. Follow-ups: each case gets a follow-up question (3 days). The farmer answers it on the case file screen and can mark the problem solved.

## Guide search (RAG) in OpenEdge
* Schema `openedge/schema/008-assistant.df`: `GuidePassage` with a WORD index on `SearchText`, `GuideSynonym`, `GuideStopword`, `AssistantCase`, `CaseFollowUp`, `FarmerMemory`.
* `POST /farm/guide/search {q}` (ABL `CONTAINS`, plus synonyms and singular/plural) returns the top 3 passages. `mock-pasoe/assistant.js` gives the same results (contract cases AS01 to AS41).
* Seed: `openedge/data/guide-seed.json`. There are 51 passages quoted word for word from 15 English Wikipedia articles. Each passage stores the article title, section, a fixed-revision URL (`oldid`) and the licence **CC BY-SA 4.0**. Sentences that name chemicals or sprays were left out. Nothing is invented.

## Memory and check-ins
* Memory is stored per farm in OpenEdge (`FarmerMemory`), using `remember` or `POST /api/v1/assistant/memory`.
* Check-ins: `ASSISTANT_CHECKIN_MS` (default 15 min, 0 = off) runs a job in the API. The first look only records the current state. After that it adds a message to the Check-ins inbox only when something is new: a frost or heat alert, a plot that just went dry, or a follow-up that is due. It is read-only.

## Honest limits
* The guides are general encyclopedia text, not local extension advice. The assistant says when it is not sure and suggests the extension officer.
* "Ask an expert" and "notify" do not send any message. No SMS, WhatsApp or email is sent.
* Voice input is not built yet.
* The isiZulu synonyms in the seed (umswakama, isithwathwa, ukoma) need review by a first-language speaker.
* Chat history is kept in the browser tab only. Case files and memory are kept in OpenEdge.
* Single farm (farmId 1), as in the rest of the demo.

## Tests
`eval/assistant.test.mjs` (in `npm test`) and contract cases AS01 to AS41 (mock and real ABL, `oe-run.ps1 -Action test`).
