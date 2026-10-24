# Co-op rules

A co-op member orders inputs on credit, harvest lots are pooled, and a buyer contract takes a share of a lot. The rules decide what is allowed. A farmer or an admin then approves. **Nothing is applied without that explicit decision.** Creating a row stores `pending_approval` or `rejected`. It does not approve it.

The rules live in `openedge/src/coop.i`, which `openedge/src/farm-api.p` includes, so PASOE (`web/FarmHandler.cls`) and the batch runner (`run-contract.p`) both use them. `mock-pasoe/coop-rules.js` and `mock-pasoe/coop-handler.js` are the same rules in Node. The 76 cases `CO01` to `CO76` in `eval/oe-contract-cases.json` are the shared check.

**All names, places, prices and quantities are fictional example data.**

The ABL in this branch was written to match the Node rules. It has **not** been compiled or run on OpenEdge here (OpenEdge is not installed in this environment). Section 10 is how to load the schema and run the cases on a machine with OpenEdge 12.8.

## 1. Purpose

Irrigation stays as it is (`docs/NOTES.md`). Co-op is a second set of rules on the same `farm` database and the same `/web/farm/*` service. There is no co-op screen. Callers use the HTTP contract below.

## 2. Data

Schema: `openedge/schema/003-coop.df`. Example rows: `openedge/data/coop-seed.json`. Sequences start at 0, so the first `NEXT-VALUE` is 1. Seed order is the id order: members 1 to 4, credits 1 to 3 (the next credit is 4), lots 1 to 3, contracts 1 to 5.

| Table | What it stores |
|---|---|
| `Member` | Name, location, preferred language, credit limit in Rand |
| `InputCredit` | An input order. `ItemName` is the item. `CreditStatus` is `pending_approval`, `approved`, `rejected` or `declined` |
| `HarvestLot` | One crop, quantity in whole kilograms (the sum of the contributions) |
| `LotContribution` | Kilograms each member put into a lot. This is the payout weight |
| `BuyerContract` | Buyer, crop, quantity, price per kg, `open` or `closed` |
| `Allocation` | Kilograms of a lot assigned to a contract, the contract price, and the decision |
| `Payout` | Gross, credit deducted and net for one member of one lot |

Seed sketch (example only): member 1 limit R5 000 with R2 500 and R1 350 already approved; member 3 has R1 000 approved. Lot `HL-0042` is maize, 1 200 + 800 + 400 kg. Lot `HL-0044` is beans, 300 + 150 kg. Contract `BC-0104` is maize and closed. The other four contracts are open.

## 3. Money and kilograms

Inside the rules, money is integer cents and kilograms are whole numbers. JSON and the database store Rand as a number with two decimals (`9800`, `6533.33`). `MAX_AMOUNT_RAND` and `MAX_KG` are both `10000000` (`mock-pasoe/constants.js` and the scoped-defines at the top of `farm-api.p`).

Products such as `1960000` cents times `1200` kg do not fit in a 32-bit integer. The ABL pro-rata maths uses `INT64`. Division truncates toward zero. Messages use `R1600.00` with no thousands separator (`fPlain` in `coop.i`). OpenEdge `STRING()` would insert spaces or commas, so the ABL does not use it for these numbers.

## 4. Credit rules

A member's **committed** credit is:

- each `approved` order: amount minus what has been repaid
- each `pending_approval` order: the full amount

`declined` and `rejected` do not count. Equal to the limit is allowed. One cent over is not.

| Code | When |
|---|---|
| `CREDIT_LIMIT_EXCEEDED` | requested amount plus committed credit is above the limit. `suggestedAmount` is the headroom (never below 0) |

On approval the check runs again and **excludes the order being approved**, so a pending order is not counted twice.

## 5. Payout rules

A member's share of a lot is that member's pro-rata part of the **delivered** value (section 7). Weight is contributed kilograms. Only allocations with status `delivered` count. Value is kilograms times the price stored on the allocation, in cents.

**Remaining share** is that share minus gross already committed on other payouts for the same lot and member. Committed payout statuses are `pending_approval` and `approved`. The payout being re-checked is excluded.

**Open credit** a payout may still deduct is approved credit not yet repaid, minus credit already deducted on other `pending_approval` payouts for that member (again excluding the payout being re-checked), and never below 0.

If the request omits `grossAmount`, gross is the remaining share. If it omits `creditDeducted`, the deduction is `min(open credit, gross)`.

| Code | When |
|---|---|
| `MEMBER_NOT_IN_LOT` | the member has no contribution on the lot |
| `PAYOUT_NOT_DELIVERED` | the lot has no delivered allocation |
| `PAYOUT_NOTHING_DUE` | there is delivered stock, the member contributed, and gross is 0 (the share is already paid or waiting for approval) |
| `PAYOUT_EXCEEDS_SHARE` | the member contributed and gross is above the remaining share. `suggestedGrossAmount` is the remaining share |
| `CREDIT_DEDUCTION_INVALID` | the deduction is above the open credit or above the gross. `suggestedCreditDeducted` is `min(open credit, gross)` |
| `CREDIT_NOT_DEDUCTED` | the deduction is below that same minimum (the open credit must be taken) |

`PAYOUT_NOT_DELIVERED` and `PAYOUT_NOTHING_DUE` are alternatives: a lot with no delivery does not also report nothing due. The other codes are independent and can appear together. `CREDIT_DEDUCTION_INVALID` and `CREDIT_NOT_DEDUCTED` are alternatives.

Approving a payout repays approved credit oldest `CreditId` first, up to the deducted amount, and writes one `credit_repaid_by_payout` audit row per credit that received money. That row is written after `payout_approved`.

Example from the cases: after 2 000 kg of lot 1 is delivered at R9.80, the shares of R19 600.00 are R9 800.00, R6 533.33 and R3 266.67. Member 1's default payout is gross R9 800.00, credit deducted R5 000.00, net R4 800.00.

## 6. Allocation rules

An allocation is active when its status is `pending_approval`, `approved` or `delivered`. Active kilograms count against the lot and against the contract. The check can exclude one allocation (the one being approved).

Every failing reason is returned, in this order:

| Code | When |
|---|---|
| `CROP_MISMATCH` | lot crop and contract crop differ, ignoring letter case |
| `CONTRACT_CLOSED` | the contract status is not `open` |
| `LOT_EXCEEDS_CONTRACT` | kilograms are above the contract's remaining kilograms |
| `LOT_STOCK_EXCEEDED` | kilograms are above the lot's kilograms not yet allocated |

`suggestedKg` on the last two is the smaller of the lot's free kilograms and the contract's remaining kilograms. The price stored on the allocation is the contract's price at the time of the insert.

## 7. Fair allocation (pro rata by default)

`POST /farm/lots/{id}/fair-allocation` plans how to share the lot's free kilograms across **open** contracts of the **same crop** (letter case ignored) that still have remaining kilograms. Contracts are taken in `contractId` order.

| Stock | Method | Result |
|---|---|---|
| free kilograms or demand is 0 | `none` | no rows |
| free kilograms cover every remaining kilogram | `full` | each contract gets its remaining kilograms; the rest of the lot stays unallocated |
| not enough | `pro_rata` | largest-remainder split of the free kilograms by each contract's remaining kilograms |

Pro rata, for a total and a list of `{id, weight}`:

1. Sort by id.
2. If the total is 0 or the weights sum to 0, every id gets 0.
3. Otherwise each id gets `floor(total * weight / sum of weights)`.
4. The leftover units go one each to the largest remainder (`total * weight` modulo the sum of weights). Equal remainders go to the lowest id.
5. The parts sum to the total. A part is never above the weight when the weight is the contract's remaining kilograms and the total is not above the demand.

`commit` omitted or `false` returns 200 and writes nothing. `commit: true` returns 201, inserts one pending allocation per planned row through the allocation rules, audits `allocation_rule_check` for each, then audits `fair_allocation_committed`. The plan is calculated before those inserts.

Examples: 450 kg over remaining 500 and 300 is 281 + 169. R19 600.00 over weights 1 200 / 800 / 400 is 9 800.00 / 6 533.33 / 3 266.67 (the extra cent goes to member 3).

## 8. Approval gate and audit

| Action | Who | What is stored |
|---|---|---|
| Create credit, allocation or payout | the rules (`actor` `abl-rules`) | `pending_approval` if the rules pass, otherwise `rejected` with the reasons. The response is 201 and includes `facts` |
| `decision: approve` | `actor`, default `farmer` | re-runs the rules. Pass: `approved`. Fail: the row becomes `rejected`, 409 `NOT_APPROVABLE`, event `*_approve_blocked_by_rules` |
| `decision: reject` | same | `declined`, only from `pending_approval` |
| `decision: deliver` | allocations only | only from `approved`. Sets `deliveredAt` and does not set `decidedAt`. Already delivered is 409 `ALREADY_DECIDED` ("Allocation is already delivered."). Any other status is 409 `NOT_DELIVERABLE` |

A row that was `rejected` by the rules cannot be approved (409 `NOT_APPROVABLE`, no write). A row that is already decided returns 409 `ALREADY_DECIDED`. A refused request does not write an audit row. A decision response does not include `facts`.

Audit events: `credit_rule_check`, `credit_approved`, `credit_declined`, `credit_approve_blocked_by_rules`, `allocation_rule_check`, `allocation_approved`, `allocation_declined`, `allocation_delivered`, `allocation_approve_blocked_by_rules`, `payout_rule_check`, `payout_approved`, `payout_declined`, `payout_approve_blocked_by_rules`, `credit_repaid_by_payout`, `fair_allocation_committed`.

Detail text is fixed, for example `credit 4 member 1 R1600.00 => rejected_by_rules`, `allocation 1 lot 1 contract 1 2400 kg => rejected_by_rules`, `credit 5 repaid R1150.00 by payout 3`, `lot 3: 2 allocation(s), 450 kg, method pro_rata`. Rule-check rows use actor `abl-rules`. Decision rows use the request actor.

If another session holds the row, the decision returns 409 `RECORD_LOCKED` with message "The record is being changed by someone else. Try again." The batch cases do not hit that path.

## 9. HTTP endpoints

Paths are under `/web` (PASOE) or the mock server. Bodies are JSON. Errors are `{ "error", "message", "field"? }`. `asOf` is optional ISO 8601 UTC and makes the tests repeatable. `requestId` is optional. Unknown co-op paths are 404 `NOT_FOUND`. Other methods are 405.

| Method and path | Success |
|---|---|
| `GET /farm/members` and `GET /farm/members/{id}` | 200, or 404 `MEMBER_NOT_FOUND` |
| `GET /farm/credits?memberId=&status=` and `GET /farm/credits/{id}` | 200, or 404 `CREDIT_NOT_FOUND`. A bad query id returns an empty list |
| `POST /farm/credits` `{memberId, amount, item?, requestId?, asOf?}` | 201 |
| `POST /farm/credits/{id}/decision` `{decision: approve\|reject, actor?, requestId?, asOf?}` | 200 or 409 |
| `GET /farm/lots` and `GET /farm/lots/{id}` | 200, or 404 `LOT_NOT_FOUND`. A lot includes each contribution and its share of delivered value |
| `POST /farm/lots/{id}/fair-allocation` `{commit?, requestId?, asOf?}` | 200 plan, or 201 when `commit` is true |
| `GET /farm/contracts` and `GET /farm/contracts/{id}` | 200, or 404 `CONTRACT_NOT_FOUND` |
| `GET /farm/allocations?lotId=&contractId=&status=` and `GET /farm/allocations/{id}` | 200, or 404 `ALLOCATION_NOT_FOUND` |
| `POST /farm/allocations` `{lotId, contractId, kg, requestId?, asOf?}` | 201 |
| `POST /farm/allocations/{id}/decision` `{decision: approve\|reject\|deliver, actor?, requestId?, asOf?}` | 200 or 409 |
| `GET /farm/payouts?lotId=&memberId=&status=` and `GET /farm/payouts/{id}` | 200, or 404 `PAYOUT_NOT_FOUND` |
| `POST /farm/payouts` `{lotId, memberId, grossAmount?, creditDeducted?, requestId?, asOf?}` | 201 |
| `POST /farm/payouts/{id}/decision` `{decision: approve\|reject, actor?, requestId?, asOf?}` | 200 or 409 |

`GET /farm/audit?limit=` is the existing audit read. Limit 500 is the maximum. The list is newest first.

PASOE already maps `/farm` and `/farm/{*}` to `web.FarmHandler` (`openedge/pasoe/ROOT.handlers`). No second handler was added. The mock server (`node mock-pasoe/server.js`, or in-process) exposes the same paths.

## 10. Load the schema and run the cases on OpenEdge 12.8

Use the Windows machine where OpenEdge 12.8 is installed (`DLC` defaults to `C:\Progress\OpenEdge`, database directory `C:\OpenEdge\WRK\farm` or `FARM_DB_DIR`). Node must be on `PATH`. Run PowerShell from the repository root. The database server listens on port **20000**.

These commands were not run in the environment that added this file.

1. Stop the database server if it is running.

   ```powershell
   .\scripts\oe-run.ps1 -Action stop-db
   ```

2. Load `003-coop.df`. The server must be stopped (the load is single-user).

   - The farm database **already has** `002-farm-ops.df` (the usual case on the laptop):

     ```powershell
     .\scripts\oe-run.ps1 -Action load-coop
     ```

   - A **new** database that does not have `002-farm-ops.df` yet. `001-farm.df` is the original `Farm` table and is not part of `load-schema`; the database is expected to already contain it.

     ```powershell
     .\scripts\oe-run.ps1 -Action load-schema
     ```

   - Dry-run `001-farm.df`, `002-farm-ops.df` and `003-coop.df` into a throw-away database (does not touch `farm`):

     ```powershell
     .\scripts\oe-run.ps1 -Action scratch-schema
     ```

3. Start the database server (port 20000, extra ports 3100 to 3199 so port 3000 stays free for the Node API).

   ```powershell
   .\scripts\oe-run.ps1 -Action start-db
   ```

4. Reseed before every run. This loads `openedge/data/seed.json` and `openedge/data/coop-seed.json` and resets the co-op sequences.

   ```powershell
   .\scripts\oe-run.ps1 -Action seed
   ```

5. Batch mode, real ABL.

   Every contract case, including `CO01` to `CO76`. Expect the irrigation result (60 passed and 1 intentional failure, `FAIL01`) and a co-op subtotal of 76 passed.

   ```powershell
   .\scripts\oe-run.ps1 -Action test
   ```

   Co-op cases only (reseed, then `run-contract.p` with prefix `CO`, then `node eval/compare-oe.mjs eval/abl-results.json --coop`). Expect 76 passed and 0 intentional failures.

   ```powershell
   .\scripts\oe-run.ps1 -Action test-coop
   ```

6. Compile after any ABL edit. `compile-check.p` compiles `farm-api.p`, which pulls in `coop.i`. If PASOE is already running, refresh the agent sessions (`openedge/pasoe/README.md`). The instance `PROPATH` must list this repo's `openedge/src` first.

7. HTTP mode. Start PASOE instance `farmops` (`tcman.bat start`, HTTP 8820) first. The script reseeds, then calls the running server. `npm run test:oe-http` does **not** reseed; run `seed` before it.

   ```powershell
   $env:OE_BASE_URL = 'http://localhost:8820/web'
   .\scripts\oe-run.ps1 -Action test-http
   .\scripts\oe-run.ps1 -Action test-http-coop
   ```

   The same HTTP check without the script (reseed first):

   ```powershell
   node eval/compare-oe.mjs --http http://localhost:8820/web
   node eval/compare-oe.mjs --http http://localhost:8820/web --coop
   ```

   Set `OE_AUTH` to `user:password` if the PASOE app is not anonymous. The API and PASOE must run on a machine that can reach the database. A cloud machine cannot reach the laptop's localhost.

`eval/abl-results.json` is gitignored. A full results file checked without `--coop` must contain every case. A co-op-only file must be checked with `--coop`.
