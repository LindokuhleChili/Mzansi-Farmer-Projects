# Community harvest-day market

Feature 1 of the roadmap in the project brief (section 8a). It replaces the old app's community page of posts and polls.

A farmer plans a **harvest day**: a date, a place and the produce they will sell. OpenEdge checks it. The farmer publishes it with the same two-step confirmation as approving an irrigation suggestion. Community members see the published days, can reserve some produce ahead if they want, and buy on the day at prices **below what a big retail buyer would pay the farmer**.

The pattern is the same as the rest of the platform: OpenEdge holds the data, ABL rules check everything, the farmer approves, and every step is written to the audit log.

**All events, venues, buyers and prices are fictional example data.** The retail-buyer prices in particular are made up. They are not quotes.

## 1. Decisions on the four open questions

| Question (brief 8a) | Decision |
|---|---|
| Which fields does an event need? | Name, venue, optional area, optional notes, start and end time (UTC in the API, SAST on screen), farm (default 1), and 1 to 20 items. Each item has a crop, an optional label (for example "Green mealies"), whole kilograms, a price per kg in Rand, and an optional co-op lot. |
| Is "below the retail-buyer price" enforced or only shown? | **Enforced by an ABL rule.** The `RetailBuyerPrice` table holds one reference price per crop. An item's price must be strictly lower (`PRICE_NOT_BELOW_RETAIL`, with a suggested price one cent below). A crop with no reference price is blocked (`NO_REFERENCE_PRICE`), so the rule never guesses. The screens also show the difference, for example "R2.30 below". |
| Reserve ahead or walk up? | **Both.** Reservations are optional. Each reservation is at most **50 kg**, and at most **50 % of an item** (rounded down) can be reserved ahead. The rest is kept for walk-up buyers. Reservations close when the event starts. |
| How do events link to co-op harvest lots? | **Optional `lotId` per item.** The item's crop must match the lot (`LOT_CROP_MISMATCH`), and its kg must not exceed the lot's **unallocated** kg: lot kg − kg in active (pending or approved) co-op allocations − kg already listed on other active market days − kg of earlier items of the same event from that lot (`LOT_STOCK_EXCEEDED`, with the kg that is still free). |

Other decisions:

* **The start must be in the future** (`EVENT_NOT_IN_FUTURE`). The end must be after the start (a 400 validation error).
* **Saving runs the rules, it never publishes.** A create or edit stores `pending_approval` (rules passed) or `rejected` (rules failed, with every reason). Publishing (`approve`) runs the rules again at that moment, because prices, lots and the date may have changed. If they fail, nothing is published and `market_publish_blocked_by_rules` is audited.
* **Editing** is allowed until the first confirmed reservation (`HAS_RESERVATIONS` after that) and never on a cancelled event. An edit replaces the fields and all items, runs the rules again and puts the event back to `pending_approval` or `rejected`, so a published event has to be published again.
* **Cancelling** a pending or published event also cancels its confirmed reservations and frees its lot kg. Declined, rejected and cancelled events cannot be cancelled (`NOT_CANCELLABLE`).
* **Reservations are checked by the rules only, with no farmer approval.** They move no stock and no money, and the farmer can cancel any reservation. A failed reservation is stored as `rejected` with its reasons, like a rejected suggestion.
* Market listings do **not** reduce the kg that the co-op can allocate to buyer contracts (see open items).

Statuses: event `pending_approval`, `published`, `rejected`, `declined`, `cancelled`. Reservation `confirmed`, `rejected`, `cancelled`.

## 2. Rules and codes

| Code | Checked on | Meaning |
|---|---|---|
| `EVENT_NOT_IN_FUTURE` | save, publish | The start time must be after now. |
| `NO_REFERENCE_PRICE` | save, publish | The crop has no retail-buyer reference price. |
| `PRICE_NOT_BELOW_RETAIL` | save, publish | Price per kg must be lower than the reference. `suggestedPricePerKg` is one cent below it. |
| `LOT_CROP_MISMATCH` | save, publish | The item's crop is not the lot's crop. |
| `LOT_STOCK_EXCEEDED` | save, publish | More kg than the lot has free. `suggestedKg` is what is still free. |
| `EVENT_NOT_OPEN` | reserve | The event is not published. |
| `RESERVATIONS_CLOSED` | reserve | The event has started (or is over). Walk up instead. |
| `RESERVE_CAP_EXCEEDED` | reserve | More than 50 kg in one reservation. `suggestedKg` is 50 (or less if less is left). |
| `RESERVE_STOCK_EXCEEDED` | reserve | More than is left of the 50 % that can be reserved. `suggestedKg` is what is left. |

Every failing rule is reported, not only the first. Event reasons carry `item`, the 1-based position of the item they are about. The limits are `MARKET_MAX_ITEMS` (20), `RESERVE_CAP_KG` (50) and `RESERVE_SHARE_PCT` (50) in `farm-api.p` and `mock-pasoe/constants.js`.

## 3. Data

Schema: `openedge/schema/004-market.df`. Example rows: `openedge/data/market-seed.json` (loaded by `seed.p` as its third file).

| Table | What it stores |
|---|---|
| `MarketEvent` | Name, venue, area, notes, `StartsAt` / `EndsAt` (DATETIME-TZ), status, verdict, rule reasons, created / decided times, request id |
| `MarketItem` | Event, order, crop, label, kg, price in cents, optional `LotId` |
| `MarketReservation` | Event, item, buyer name, kg, status, verdict, rule reasons, times, request id |
| `RetailBuyerPrice` | One reference price per crop (cents) and where it came from |

Sequences `MarketEventSeq`, `MarketItemSeq`, `ReservationSeq`. Seed: five reference prices (Beans R24, Cabbage R6.50, Maize R9.80, Spinach R18, Tomato R14 per kg); three events (31 Oct published with 300 kg green mealies from co-op lot 2, 120 kg spinach and 200 kg cabbage; 14 Nov published with tomatoes and beans; 17 Oct, already past); one reservation of 10 kg spinach.

## 4. Endpoints

OpenEdge (`/web/farm/...`, same handler as everything else):

| Method and path | Result |
|---|---|
| `GET /farm/market/prices` | reference prices per crop |
| `GET /farm/market/events[?status=]` | events sorted by start time |
| `GET /farm/market/events/{id}` | one event with items, `reservedKg`, `reservableKg`, `walkUpKg` per item |
| `POST /farm/market/events` | create, 201, `pending_approval` or `rejected` |
| `POST /farm/market/events/{id}` | edit, 200; 409 `HAS_RESERVATIONS` / `ALREADY_DECIDED` |
| `POST /farm/market/events/{id}/decision` | `approve`, `reject` or `cancel`; 409 `NOT_APPROVABLE` (rules failed again), `ALREADY_DECIDED`, `NOT_CANCELLABLE` |
| `GET /farm/market/reservations[?eventId=&itemId=&status=]` | reservations, oldest first |
| `POST /farm/market/reservations` | 201, `confirmed` or `rejected` |
| `POST /farm/market/reservations/{id}/decision` | `cancel` |

The Node API (`/api/v1`, app token) wraps them: `GET /market/prices`, `GET /market/events`, `GET /market/events/:id`, `GET /market/reservations`, `POST /market/events`, `POST /market/events/:id` (edit), `POST /market/events/:id/publish` and `POST /market/events/:id/cancel` (both two-step: the first call returns 202 with a `confirmToken`, the second call with that token does it), `POST /market/events/:id/decline`, `POST /market/reservations`, `POST /market/reservations/:id/cancel`. The local UI proxy allows `/ui/api/v1/market/*`.

Audit events: `market_rule_check`, `market_event_edited`, `market_event_published`, `market_publish_blocked_by_rules`, `market_event_declined`, `market_event_cancelled` (with the number of reservations cancelled), `reservation_rule_check`, `reservation_cancelled`, plus the usual `tool_call` rows from the API.

## 5. Screens

`apps/web/public/assets/js/market.js`. Routes `#/market` (list, grouped by month like a simple calendar, with filters Upcoming / Waiting for you / Blocked by rules / Past & cancelled), `#/market/{id}` (event: produce table with your price, retail price and how much below it is, what can still be reserved and what is kept for walk-up; the rule check; reservations and a reserve form; Publish / Decline / Edit / Cancel), `#/market/new` and `#/market/{id}/edit` (the farmer's form). Market is in the desktop side bar, and on the phone it takes the Audit tab's place; the audit log is linked from More (Settings).

The photo is a real Pexels photo, `market-stall.jpg` (LekePOV, "African Market Stall with Fresh Produce", photo 35726906, Pexels License, location not stated, not South African), credited in `docs/UI.md` and `docs/screens/credits.md`. Crop thumbnails reuse the plot photos. Cards are flat like the rest of the app: no glow and no highlighted "AI" borders.

### isiZulu (DRAFT, needs native-speaker review)

The approved isiZulu table (`zu` in `i18n.js`) is unchanged. The market lines below are new drafts. They are in a separate `zuMarket` table so they cannot be mistaken for approved lines. Every other market string stays in English. **Have a native speaker check these before any demo.**

| Key | English | isiZulu draft |
|---|---|---|
| `mk_nav` | Market | Imakethe |
| `mk_title` | Harvest-day market | Imakethe yosuku lokuvuna |
| `mk_new` | New market day | Usuku olusha lwemakethe |
| `mk_f_upcoming` | Upcoming | Ezizayo |
| `mk_st_published` | Published | Kushicilelwe |
| `mk_when` | When | Nini |
| `mk_where` | Where | Kuphi |
| `mk_produce` | Produce on sale | Okuthengiswayo |
| `mk_publish` | Publish | Shicilela |
| `mk_res_title` | Reservations | Ukubekisa |
| `mk_res_add` | Reserve | Bekisa |
| `mk_res_closed` | Reservations are closed. Walk up on the day. | Ukubekisa kuvaliwe. Woza ngosuku lwemakethe. |
| `mk_res_none` | No reservations yet. Buyers can still just walk up on the day. | Akekho osebekisile. Abathengi bangafika nje ngosuku. |

The Settings hint still says isiZulu covers only the approved lines; with these drafts that is no longer exactly true and should be reworded once they are reviewed.

## 6. Tests

* `eval/oe-contract-cases.json`: cases `MK01` to `MK51` (create, every rule, edit, publish with the re-check, decline, cancel with reservations, reservations and their limits, audit rows). They run against mock-pasoe in `npm test` and against the real ABL with `oe-run.ps1`.
* `eval/market.test.mjs` (`npm test` section 9): reserve-share rounding, one cent below retail, missing reference price, two items sharing one lot, cancelled kg going back to the lot, the `/api/v1/market` routes with the two-step publish and cancel, the UI proxy, and the isiZulu draft list above.

## 7. Run it on OpenEdge 12.8

A throw-away check that never touches the farm database or PASOE (safe while they run):

```powershell
.\scripts\oe-run.ps1 -Action scratch-test   # new scratch db next to the farm db, loads 001-004, seeds, runs every case single-user
```

To add the market to the real `farm` database (**needs the owner's go-ahead**: it stops the database server):

```powershell
.\scripts\oe-run.ps1 -Action stop-db
.\scripts\oe-run.ps1 -Action load-market     # loads 004-market.df only; fails loudly if farm.e is written
.\scripts\oe-run.ps1 -Action start-db
.\scripts\oe-run.ps1 -Action seed            # now also loads market-seed.json
.\scripts\oe-run.ps1 -Action test-market     # MK01-MK51 in batch mode
# restart PASOE farmops so it picks up the new farm-api.p / market.i, then:
.\scripts\oe-run.ps1 -Action test-http-market
```

Run `compile-check.p` after any ABL change (`farm-api.p` includes `coop.i` and `market.i`).

## 8. Open items

* Market kg does not reserve lot stock for the co-op: a buyer contract allocation can still take kg that a market day has listed. Decide whether market listings should count in the co-op's free kg.
* Reference prices are example data with no update process. Real prices need a source and a date, and probably a weekly update (roadmap item 3, market prices).
* Reservations have no buyer identity or contact, no payment and no no-show handling; they are a name and a kg amount.
* Community members have no separate view or login yet; the screens are the farmer's app. A public read-only page of published days is the obvious next step.
* The isiZulu drafts above need review.
