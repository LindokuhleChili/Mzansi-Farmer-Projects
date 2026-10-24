# Web interface (farmer app)

A small, build-free web app served by the same Node API: **`npm start`, then open <http://localhost:3000/>**. It follows the four approved demo screens (`docs/screens/`: dashboard, review, confirm, rejected) and works on a phone and on a desktop.

It is a client of the API in `docs/API.md`. It adds no OpenEdge code and changes no OpenEdge behaviour: every number it shows comes from OpenEdge through the API, and every rule check, confirmation gate and audit write is still done by the API and the ABL rules.

All data is fictional example data. The AI suggests, OpenEdge rules check it, the farmer approves.

## Pages

| Address | What it shows |
|---|---|
| `/#/` Dashboard | Desktop: "N of M plots have dry soil", **three plot cards in one row** (photo, status, soil moisture with the dry-limit tick, temperature, humidity, rain, reading age; the whole card opens the plot), the soil chart with the dry limit and the last readings, and "Waiting for you" (suggestions that wait for a decision plus recent rule rejections), all visible without scrolling at 1440 x 900. Phone: full-bleed photo hero with the big "2 of 3" numeral, location pill, ZU/EN switch, avatar and status chips, then a white sheet with "Your plots". **Ask AI for advice** is on each plot page (and on the dashboard when nothing is waiting). Refreshes every 30 s. |
| `/#/settings` | Language, what the app talks to (stand-in or real OpenEdge, AI), session. |
| `/#/plots` | All plots (the dashboard shows three of them) with their limits (dry limit, max litres per irrigation, weekly budget). |
| `/#/plots/{id}` | One plot: latest readings, soil chart, 20-reading history, **Ask AI for advice**, and the demo tools below. |
| `/#/suggestions` | Every suggestion, newest first, with filters (waiting, approved, blocked by rules, declined). |
| `/#/suggestions/{id}` | **Review**: the suggestion written by the AI, the OpenEdge rule check (six rows with the rule codes, pass or fail, and the numbers), the numbers used, **Decline** and **Approve**. **Approve** opens the **confirm** sheet (single-use token, 2 minute countdown, "the rules run again when you confirm"). The same page shows the **rejected** view (red banner per failing rule with the plain-language reason and the server's message, "what you can do"), and the approved / declined result. |
| `/#/audit` | The audit trail from OpenEdge. By default rule checks and decisions; filters for everything and for tool calls. Each row expands to the full record, with its request id. |

Language: the **ZU / EN** switch (top right) is remembered in the browser. Times are shown in South African time.

## How it talks to the API and how the token is handled

The browser never holds the app token, a device token or the AI key.

* **Same computer (normal demo).** The page calls `/ui/api/v1/*`. The API re-issues the call to its own `/api/v1/*` inside the process with its own `APP_TOKEN`, so nothing changes in the rules, the two-step confirmation or the audit log. The proxy only forwards `plots`, `suggestions` and `audit`, never `readings` (that is the device route).
* The `/ui/*` routes answer **only** when all of these hold: the client is on loopback (127.0.0.1 or ::1), the `Host` header is `localhost`, `127.0.0.1` or `[::1]`, and the request carries `X-Requested-With: mzansi-ui`. The last two stop other web pages in the same browser (and DNS-rebinding tricks) from using the proxy. `UI_ALLOW_REMOTE=1` lifts only the loopback check; it is off by default and is not recommended.
* **Another device (a phone on the LAN).** The proxy answers 403 `UI_LOCAL_ONLY`, the page shows "Enter the app token", the farmer pastes `APP_TOKEN`, and it is kept in `sessionStorage` (that tab only) and sent to `/api/v1/*`. Windows Firewall must allow TCP 3000 for this (see `docs/NOTES.md`). The demo tools are not available this way.
* `GET /ui/session` tells the page which mode applies. It returns the OpenEdge mode, the AI provider name and the demo tools that exist. It never returns a token, a key or a device token (a test checks this).
* The static files are served with a strict Content-Security-Policy (`default-src 'self'`) and `nosniff`; only files under `apps/web/public/` can be read.
* `UI_ENABLED=0` removes the UI and the `/ui/*` routes completely; `/api/v1` is unchanged.

| Variable | Default | Effect |
|---|---|---|
| `UI_ENABLED` | `1` | `0`, `false`, `off` or `no` switches the web UI off. |
| `UI_ALLOW_REMOTE` | `0` | `1` lets non-loopback clients use the `/ui/api` proxy (only the loopback check is lifted). |

## Demo tools (this computer only, not part of the farmer app)

Shown on the plot page in a dashed card, only when the page is on the same computer as the API.

* **Simulate a sensor reading**: soil %, temperature, humidity and a "Raining" box, with presets (dry soil, wet soil, raining). The API posts it as the plot's registered sensor, using that device's token **on the server**. This closes the live loop from the browser: reading, ask AI, review, approve. It works only for plots that have a device in `DEVICE_REGISTRY` (the default `.env.example` has `esp32-01` for plot 1; add more entries to simulate other plots). The timestamp is "now" and moves forward a second if the same second was already stored.
* **AI behaviour (stand-in AI only)**: *Normal* or *Over-eager*. The over-eager mock always asks for the plot's maximum litres. With a wet or rainy reading it lets you show the OpenEdge rules saying no (`SOIL_NOT_DRY`, `RAIN_DETECTED`, `WATER_BUDGET_EXCEEDED`). It is hidden and refused (409) when the real model is configured.

Without a rejection from the AI, a rejection is still reachable with the real or normal AI: approve one or two irrigations on plot 1 (1 000 L are already used, the weekly budget is 1 500 L) and the next suggestion is refused with `WATER_BUDGET_EXCEEDED`. Run the OpenEdge `seed` action to reset between demo runs (see `docs/NOTES.md`).

## isiZulu

English is the source of truth. The ZU toggle uses **only the approved lines** from the demo-screen table (`docs/screens/api-fields.md`):

| isiZulu | Where |
|---|---|
| `Sawubona, Nomsa` | dashboard greeting |
| `Chelela isiqephu sombila A ngamalitha angu-300.` (litres and plot letter filled in) | review, for maize plots only |
| `Umhlabathi womile. Umswakama ungu-18.5%, ngaphansi kuka-35%.` (numbers filled in) | review, when the soil is below the dry limit |
| `Qinisekisa isinqumo sakho.` | confirm sheet |
| `Akuvunyelwe. Imvula iyana manje.` | rejected view, rain rule |
| `Linda kuze kuyeke imvula.` | rejected view, "what you can do" |

Everything else (menus, labels, buttons, rule names) stays in English, because no approved isiZulu exists for it. The strings are in one file, `apps/web/public/assets/js/i18n.js`; adding an approved isiZulu line means adding the key to the small `zu` table. For any suggestion without an approved sentence, the page shows the isiZulu advice the API wrote when the farmer asked in ZU mode (the API's `lang: "zu"` text), with the API's bracketed "draft" note removed from the farmer's screen.

> ### isiZulu: NEEDS NATIVE REVIEW (not shown to farmers)
> Every isiZulu line above and every isiZulu line from the API's `lang: "zu"` text is an unreviewed draft. Before the demo a native speaker should check: "sombila" (plot of maize), "ngamalitha angu-300" and "ungu-18.5%" / "kuka-35%" when the numbers change (the prefix depends on the number; the page uses the approved pattern for every number), and "Chelela" as the verb for irrigate. The page only has these approved forms for maize plots; other crops fall back to the API's text. This note lives here and in `docs/screens/api-fields.md`, not in the app.

## Design

* Colour tokens, radii, type (Plus Jakarta Sans for headings, Inter for text, bundled as subset WOFF2, SIL Open Font License), card layout and the rule-check rows are taken from the approved screens. Mobile first: one column, a full-bleed photo hero and a floating pill navigation (Home, map, suggestions, audit log, more) under 900 px; a 176 px sidebar (with Settings, Log out and the suggestions badge), a top bar with search and bell, wider cards and a two-column review from 900 px.
* **Real photographs only**, no illustrations, and **no glowing or "AI highlight" outlines**: borders are plain 1 px lines, shadows are small and neutral, the focus ring is a plain 2 px outline.
* Status is never colour only: every status has text and an icon.

### Photo credits

All photos are **Pexels License** (free to use and modify, attribution not required, credit given anyway; no implied endorsement; identifiable people must not be shown in a bad light). They are resized and compressed for the web. They are **not South African fields**; swap in South African photos if you have some. The first seven are the approved screen photos; the last two were added for the Beans and Spinach plots, which the approved screens did not have. For those two I could not re-open the Pexels pages (the site blocks automated fetches), so the photographer and title come from the search listing and the file came from the Pexels image CDN; please check them once in a browser.

| File (`apps/web/public/assets/photos/`) | Used for | Photographer | Pexels title (photo id) | Where |
|---|---|---|---|---|
| `field-header-maize.jpg` | dashboard and review header | Los Muertos Crew | A Close Up on a Full-grown Maize Plants (10041333) | not stated |
| `plot-maize.jpg` | Maize plot | Los Muertos Crew | A Close Up on a Full-grown Maize Plants (10041332) | not stated |
| `rain-wheat-storm-kenya.jpg` | rejected-by-rain header | Vince Pictures | Lush Wheat Field Under Dark Stormy Sky in Kenya (30255145) | Mau Narok, Kenya (per the page) |
| `plot-tomato-greenhouse.jpg` | Tomato plot | Lyn Ong | Fresh Cherry Tomatoes Growing on a Greenhouse (5005518) | not verified |
| `plot-cabbage.jpg` | Cabbage plot | Mark Stebnicki | Cabbage Field in Countryside (22156650) | not verified |
| `farmer-inspecting-crops.jpg` | desktop sidebar card | mk_photoz | African Farmer Inspecting Crops in Field (34411687) | Nigeria (per the page) |
| `avatar-nomsa.jpg` | avatar of the made-up user "Nomsa" | Andrea Piacquadio | Happy African American female smiling at camera (3959954) | studio portrait; stands in for a made-up user |
| `plot-beans.jpg` | Beans plot | Faisal Ahammad | Close-up of Green Beans on Plant in Garden (37270950) | not stated; see note above |
| `plot-spinach.jpg` | Spinach plot | Sayeed Chowdhury | Fresh Green Spinach Growing in Rows Outdoors (35252799) | not stated; see note above |
| `market-stall.jpg` | harvest-day market list header, event header and confirm sheet (docs/MARKET.md) | LekePOV | African Market Stall with Fresh Produce (35726906) | not stated on the page; not South African |

## Tests

* `npm test` section 7 (`eval/ui.test.mjs`, no browser needed): static routes and path traversal, the local-only proxy (loopback, Host, header, never a token in any response), `UI_ENABLED=0`, the whole loop through the proxy (simulate reading, ask AI, two-step approve, audit), the rejected and declined paths, the demo tools' limits, the field names of every API response the UI reads, and front-end file checks (modules parse, assets exist, only the approved isiZulu table, every photo credited, no glow effects, no keys in the web files).
* Click-through (headless Chrome with Playwright, both languages, phone 390 x 844 and desktop 1280 x 800): `python3 scripts/ui-click-through.py mobile|desktop [--video]` drives dashboard (3 plots, all 5 on `/#/plots`), plot page, simulated reading, ask AI, review, language switch, confirm, approve, audit, the rain / over-eager rejection, the budget rejection and decline; `python3 scripts/ui-compare.py OUT_DIR` captures the four approved screens (dashboard, review, confirm, rejected) at 1440 x 900 and 390 x 844 and writes side-by-side images next to the mockups in `mzansi-demo-screens/`. It needs `pip install playwright` and a Chrome or Chromium (set `CHROME_PATH` if it is not in the default place) and is **not** part of `npm test`, so the repo stays dependency-light.

## Limits

* The UI is tested against the mock OpenEdge and the mock AI here. Against the real PASOE it makes the same API calls; use `OE_MODE=pasoe` (see `docs/NOTES.md` section 4) and look at it once on the laptop before the demo.
* The "numbers used" and rule rows of a suggestion use the numbers from the moment the AI answered when that browser tab asked for it; for any other suggestion they are the current OpenEdge numbers and the card says so.
* The page throttles itself to 3 calls at a time and refreshes every 30 s, because the OpenEdge development licence allows 5 concurrent requests. Every call is also written to the audit log, so the audit page hides tool calls by default.
* One made-up user (Nomsa). There is no login for farmers; access control is the loopback rule or the pasted app token.
