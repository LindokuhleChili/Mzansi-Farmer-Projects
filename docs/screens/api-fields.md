# API fields per screen: Mzansi Farmer AI demo screens

Sources: `/workspace/mzansi-farmer-ops/docs/API.md` (HTTP contract v1, the only spec found; the repo's `openedge/schema` folder is empty, and there is no `.df`, `.p` or OpenAPI file under `/workspace`). Field names are the API's camelCase names. The OpenEdge column names inside tables Farm, Plot, SensorReading and AiSuggestion are **not** in the repo, so a table name is given only where the API field clearly belongs to it.

Legend: **documented** = in docs/API.md. **assumed** = not in the spec; I made it up for the design and it needs a decision from whoever owns the API. Times in the API are UTC (`...Z`); the screens show South African time (UTC+2), so the "10:04" on screen is 08:04Z.

Auth for all farmer-app calls: `Authorization: Bearer <APP_TOKEN>` (documented).


> ## isiZulu: NEEDS NATIVE REVIEW
> Every isiZulu line on these screens is my own short draft. **None has been checked by a native speaker; all of it needs native review before the demo.** The API spec says the same about its own `lang: "zu"` output ("draft translation, needs native-speaker review"). Strings on the screens:
>
> | # | isiZulu text | English meaning | Screens |
> |---|---|---|---|
> | 1 | `Sawubona, Nomsa` | Hello, Nomsa | mobile-1-dashboard |
> | 2 | `Chelela isiqephu sombila A ngamalitha angu-300.` | Irrigate maize plot A with 300 litres. | mobile-2-review, mobile-2b-confirm (background), desktop-2-review, desktop-2b-confirm (background) |
> | 3 | `Umhlabathi womile. Umswakama ungu-18.5%, ngaphansi kuka-35%.` | The soil is dry. Moisture is 18.5%, below 35%. | same as row 2 |
> | 4 | `Qinisekisa isinqumo sakho.` | Confirm your decision. | mobile-2b-confirm, desktop-2b-confirm |
> | 5 | `Akuvunyelwe. Imvula iyana manje.` | Not allowed. It is raining now. | mobile-3-rejected, desktop-3-rejected |
> | 6 | `Linda kuze kuyeke imvula.` | Wait until the rain stops. | mobile-3-rejected, desktop-3-rejected |
> | 7 | `ZU` toggle and the label `isiZulu` | language switch and label | all screens |
>
> Things to check specifically: "sombila" (plot of maize), "ngamalitha angu-300" (number agreement), "ungu-18.5%" and "kuka-35%" with decimals and percentages, and whether "Chelela" is the preferred verb for irrigate. The English side of every screen is the source of truth.

---

## Screen 1: Plot / sensor dashboard (`mobile-1-dashboard`, `desktop-1-dashboard`)

> **isiZulu on this screen, needs native review:** only the greeting `Sawubona, Nomsa` (mobile) and the ZU / EN toggle. All other text is English. The toggle would switch app text to isiZulu, which is not written yet.

| On screen | Field | Table | Source | Status |
|---|---|---|---|---|
| Plot name, crop, area | `plotName`, `crop`, `areaHa` | Plot | `GET /api/v1/plots` | documented |
| Dry limit tick on the moisture bar | `dryThresholdPct` | Plot | `GET /api/v1/plots` | documented |
| (used by screens 2 and 3) | `plotId`, `farmId`, `maxIrrigationLitres`, `weeklyWaterBudgetL` | Plot | `GET /api/v1/plots` | documented |
| Soil moisture tile and bar | `soilMoisturePct` | SensorReading | `GET /api/v1/plots/{plotId}/readings?limit=1` (newest first) | documented |
| Temperature tile | `temperatureC` | SensorReading | same | documented |
| Humidity tile | `humidityPct` | SensorReading | same | documented |
| "Rain detected" / "No rain" | `raining` (optional boolean, default `false`) | SensorReading | same | documented |
| Device label, e.g. esp32-01 | `deviceId` | SensorReading | same | documented |
| "4 min ago" | `readAt` (now minus `readAt`, computed on the phone) | SensorReading | same | documented field, computed value |
| Desktop chart and table of last readings | `readingId`, `readAt`, `soilMoisturePct`, `temperatureC`, `humidityPct`, `raining` | SensorReading | `GET /api/v1/plots/{plotId}/readings?limit=20` | documented |
| Desktop "Waiting for you" rows | `suggestionId`, `plotId`, `action`, `litres`, `status`, `verdict`, `rejectReasons[].code` | AiSuggestion | `GET /api/v1/suggestions?status=pending_approval` plus a second call for `status=rejected` | documented (the second call and showing rejected ones in the list is **assumed**; the spec only shows `pending_approval` as an example) |

Derived on the phone (not API fields):
- Status pill "Dry soil" when `soilMoisturePct < dryThresholdPct`, otherwise "Moisture OK" (**assumed rule**; the API returns no per-plot status).
- Headline "2 of 3 plots have dry soil" is a count of those pills.
- "3 sensors online" counts plots whose newest reading is under 15 min old (15 min is the `SENSOR_STALE` limit in the spec's example message; the exact limit is **assumed** to be configurable).
- "Live, every 30 s" is static text (default interval in the spec).

Other assumed fields on this screen:
- Location chip "Greytown, KZN": Farm table, `farmName` / `locationName`, from an assumed `GET /api/v1/farms/{farmId}` (the spec has no Farm endpoint, only `farmId` on a plot).
- "Sawubona, Nomsa" and the avatar: no user endpoint or table exists in the spec. The name is static demo text (**assumed**).
- Plot photo: no photo field exists. The design maps crop to a stock photo (**assumed**: either a static map by `crop` or a `photoUrl` on Plot).
- Language toggle ZU / EN: sent as `lang` (`"en"` or `"zu"`) on `POST /api/v1/plots/{plotId}/advise` (documented). Storing the choice is **assumed** (device storage).

Demo data caveat: the spec's `DEVICE_REGISTRY` maps only `esp32-01` to plot 1. The screens also show Tomato Plot B (`esp32-02`, plot 2) and Cabbage Plot C (`esp32-03`, plot 3). Those two devices would need registering, or the sim script must post readings for them with each device's own token. The Plot B and C values (`dryThresholdPct` 35, `maxIrrigationLitres` 400 and 600, `weeklyWaterBudgetL` 1 200 and 2 000, area, crop) are **assumed** seed data. The plot names in the spec's example end with "(example)"; the screens drop that suffix and show an "Example data" tag instead.

---

## Screen 2: AI suggestion review (`mobile-2-review`, `desktop-2-review`)

> **isiZulu on this screen, needs native review:** the isiZulu block under the English reason (`Chelela isiqephu sombila A ngamalitha angu-300.` and `Umhlabathi womile. Umswakama ungu-18.5%, ngaphansi kuka-35%.`), the label `isiZulu`, and the ZU / EN toggle. The API's own `lang: "zu"` text is also marked draft in the spec.

| On screen | Field | Table | Source | Status |
|---|---|---|---|---|
| Title "Irrigate Maize Plot A with 300 L" | `action`, `litres`, plot name from `plotName` | AiSuggestion, Plot | `GET /api/v1/suggestions/{id}` + plots list | documented (sentence built on the phone; the API also returns the same text as `summary` in the 202 confirm response) |
| Reason text (English) | `reason` | AiSuggestion | `GET /api/v1/suggestions/{id}` | documented |
| isiZulu action line and reason | `reason` in isiZulu | AiSuggestion | `POST /api/v1/plots/{plotId}/advise` with `{ "lang": "zu" }` | documented that `zu` exists (and is a draft translation needing native-speaker review). Showing English and isiZulu **together** needs both texts: **assumed** `reasonEn` + `reasonZu` on the suggestion, or two advise calls. The isiZulu strings on screen are my own draft and **need native review**. |
| "Suggestion, written by AI" label | `ai.provider`, `ai.note` | (advise response) | `POST /advise` response | documented |
| Request id | `requestId` | AiSuggestion | Suggestion | documented |
| Step bar | `status` (`pending_approval` = step 3) | AiSuggestion | Suggestion | documented |
| Verdict "Passed all rules" | `verdict` = `approved_by_rules`, `rejectReasons` = `[]` | AiSuggestion | Suggestion | documented |
| Rule rows: values 4 min, 18.5%, 35%, 0 L, 1 500 L | `facts.readingAgeMinutes`, `facts.soilMoisturePct`, `facts.dryThresholdPct`, `facts.usedLast7DaysL`, `facts.weeklyWaterBudgetL` | SensorReading, Plot, AiSuggestion | `POST /advise` response (`facts`) | documented there. `GET /suggestions/{id}` does not list `facts`, so for a suggestion opened later: **assumed** `facts` is added to `GET /suggestions/{id}`, otherwise the app re-reads the plot and the newest reading. |
| Rule rows: max 500 L, current rain state | `maxIrrigationLitres` (Plot), `raining` (newest SensorReading) | Plot, SensorReading | plots list, readings | documented |
| The six rows themselves (name + code) | codes `ACTION_NOT_ALLOWED`, `LITRES_OUT_OF_RANGE`, `SENSOR_STALE`, `SOIL_NOT_DRY`, `RAIN_DETECTED`, `WATER_BUDGET_EXCEEDED` | n/a | reject codes list in the spec | documented codes. The API returns only the **failed** rules, so the green rows are computed on the phone from `facts` and the plot (**assumed**), or add a `checks: [{ code, passed, value, limit }]` array to the response (**assumed**). `PLOT_NOT_FOUND` and `NO_SENSOR_DATA` are not shown as rows because the screen cannot open without them. |
| Footer "Numbers come from OpenEdge" | static text | | | n/a |

Actions (all documented in API.md):

| Button | Call | Result |
|---|---|---|
| Decline | `POST /api/v1/suggestions/{id}/reject` with `{ "reason": "optional" }` | `200`, `status: "declined"`; no confirmation step |
| Approve (step 1) | `POST /api/v1/suggestions/{id}/approve` with `{}` | `202` `{ error: "CONFIRMATION_REQUIRED", confirmToken, summary, expiresInSeconds }`; nothing changes yet. Opens the confirm sheet. |
| Confirm and approve (step 2) | `POST /api/v1/suggestions/{id}/approve` with `{ "confirmToken": "cfm_..." }` | `200`, Suggestion with `status: "approved"`. Wrong, expired or reused token: `403 CONFIRMATION_INVALID`. Not approvable or already decided: `409`. |

> **isiZulu on the confirm sheet, needs native review:** the line under the title, `Qinisekisa isinqumo sakho.` (and the isiZulu block on the dimmed review behind it).

Confirm sheet (`mobile-2b-confirm`, `desktop-2b-confirm`) fields: `summary` ("Irrigate Maize Plot A with 300 L"), `expiresInSeconds` (the "Expires in 1:52" countdown starts at 120), `requestId`. The text "the rules run again when you confirm" is the spec's behaviour for step 2. What the app shows if the re-run now **rejects** is not specified: **assumed** `409` with `rejectReasons`, after which the app opens screen 3 for that suggestion. A success state after step 2 is not designed in this set.

---

## Screen 3: Rejected by OpenEdge (`mobile-3-rejected`, `desktop-3-rejected`)

> **isiZulu on this screen, needs native review:** `Akuvunyelwe. Imvula iyana manje.` (in the red banner), `Linda kuze kuyeke imvula.` (in "What you can do"), and the ZU / EN toggle.

| On screen | Field | Table | Source | Status |
|---|---|---|---|---|
| "Blocked by a rule", red verdict | `status` = `rejected`, `verdict` = `rejected_by_rules` | AiSuggestion | Suggestion | documented |
| Which rule | `rejectReasons[].code` (here `RAIN_DETECTED`) | AiSuggestion | Suggestion | documented |
| Server text for the rule | `rejectReasons[].message` | AiSuggestion | Suggestion | documented (English, technical, e.g. "Latest reading is 2880 min old (limit 15)."). The screen shows plain-language text instead, see mapping below. |
| Plain-language title, why, isiZulu line | none | | | **assumed**: a client-side map from `code` to text (table below), or `titlePlain` / `whyPlain` / `whyZu` added to each reject reason |
| Suggestion title and reason | `action`, `litres`, `reason`, `requestId` | AiSuggestion | Suggestion | documented |
| "Rain / raining: true" and "27%, dry limit 35%" | `raining`, `soilMoisturePct`, `dryThresholdPct` | SensorReading, Plot | `facts` or newest reading + plot | documented as for screen 2 |
| Numbers used (desktop): 400 L used, 1 200 L budget, 3 min | `facts.usedLast7DaysL`, `facts.weeklyWaterBudgetL`, `facts.readingAgeMinutes` | | `facts` | documented in advise response; same caveat as screen 2 |
| "4 other rules passed" | all codes minus the codes in `rejectReasons` | | computed | **assumed** (same as screen 2) |
| Approve locked | server returns `409 NOT_APPROVABLE` for a rejected suggestion | | | documented |

Options on the screen:

| Button | Call | Status |
|---|---|---|
| Ask again / Ask for new advice | `POST /api/v1/plots/{plotId}/advise` with `{ "lang": "en" }` | documented |
| Dismiss | `POST /api/v1/suggestions/{id}/reject` | **assumed** to be allowed on a `rejected` suggestion; the spec only says reject on a pending one sets `declined`. If not allowed, use `DELETE /api/v1/suggestions/{id}` (two-step confirmation, sets `deleted`, audit kept), which is documented. |

Plain-language map for the eight documented reject codes (**assumed** wording; only `RAIN_DETECTED` has isiZulu on screen (draft, needs native review); the other seven still need writing and checking):

| Code | Plain English title | Plain English why |
|---|---|---|
| `RAIN_DETECTED` | Not allowed while it is raining | The rain sensor on this plot is wet right now. Watering in the rain wastes water, so irrigation stays locked until the rain stops. (isiZulu on screen, **needs native review**: "Akuvunyelwe. Imvula iyana manje.") |
| `SOIL_NOT_DRY` | The soil is not dry enough | Soil moisture is at or above the dry limit for this plot. |
| `SENSOR_STALE` | The sensor reading is too old | The newest reading is older than 15 minutes. Check the sensor, then ask again. |
| `NO_SENSOR_DATA` | No sensor data for this plot | This plot has no readings yet. |
| `WATER_BUDGET_EXCEEDED` | Over the weekly water budget | This amount would take the plot over its weekly water budget. |
| `LITRES_OUT_OF_RANGE` | The amount is outside the allowed range | The suggested litres are above the plot's maximum or not a valid amount. |
| `ACTION_NOT_ALLOWED` | This action is not allowed | The suggested action is not one the rules allow. |
| `PLOT_NOT_FOUND` | Plot not found | The suggestion points to a plot that no longer exists. |

Screen 3 needs the demo to post a reading with `raining: true` for plot 2 (the optional raindrop field). The suggestion for plot 2 shown here is an example of the AI proposing 200 L while the rule engine refuses.

---

## Cross-screen assumptions (summary)

1. Plots 2 and 3, their devices (`esp32-02`, `esp32-03`) and their thresholds are seed data that does not exist yet.
2. No Farm endpoint, user endpoint, photo field or per-plot status in the spec.
3. `GET /suggestions/{id}` may need to return `facts` and, for the two-language card, both `reason` texts.
4. The passed-rule rows and the plain-language reject texts are client-side or need a new `checks` array.
5. Behaviour of confirm step 2 when the rules now reject, and of reject on an already-rejected suggestion, is not in the spec.
6. All isiZulu text on the screens (my own short lines, listed in the note at the top) needs native review before the demo.
