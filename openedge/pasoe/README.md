# Hosting farm-api.p on PAS for OpenEdge (what was actually done on the laptop)

Instance `farmops` was created with `pasman create` (HTTP 8820, HTTPS 8821, shutdown 8822), then:

1. `conf/openedge.properties`
   - `[AppServer.SessMgr.farmops]` `agentStartupParam=-T "${catalina.base}/temp" -db C:/OpenEdge/WRK/farm/farm -H localhost -S 20000`
     (agents connect to the farm database server on port 20000)
   - `[AppServer.Agent.farmops]` `PROPATH=<repo>/openedge/src,...` (put the repo's `openedge/src` first)
2. Copy `ROOT.handlers` (this folder) to `webapps/ROOT/WEB-INF/adapters/web/ROOT/ROOT.handlers`.
   It maps `/web/farm/...` to `web.FarmHandler` (`openedge/src/web/FarmHandler.cls`), which calls `farm-api.p`.
   The same `/farm` and `/farm/{*}` handlers cover the co-op routes (`/web/farm/members`, credits, lots, contracts, allocations, payouts). `farm-api.p` includes `coop.i`, so there is no second handler class.
   After changing it: `tcman.bat jmx refreshWeb -appname farmops -webappname ROOT`.
3. **Basic login and roles** (since 26 Oct 2026; before that `/web/**` was `permitAll()` with the anonymous login model).
   Pattern from the starter kit's REST lessons 5 and 6. In `webapps/ROOT/WEB-INF/`:
   - `oeablSecurity.properties`: `client.login.model=basic`, `http.all.authmanager=local` (users come from `users.properties`).
   - `oeablSecurity.csv`: `"/web/**","*","hasAnyRole('ROLE_PSCUser')"`. No login is a 401; a user without
     `ROLE_PSCUser` is a 403 from PASOE before any ABL runs.
   - `users.properties` (format `user=password,ROLE_...,enabled`). The default `rest*` users were removed:
     | User | Roles | Used by |
     |---|---|---|
     | `farmapi` | `ROLE_PSCUser` | the Node API for every normal call (`OE_AUTH`) |
     | `farmadmin` | `ROLE_PSCUser`, `ROLE_PSCAdmin` | admin changes (`OE_ADMIN_AUTH`) |
     | `farmnone` | `ROLE_None` | only the 403 test (`OE_NONE_AUTH`) |
   The passwords are random, set only in that file and in the laptop's git-ignored `.env` (`OE_AUTH=farmapi:...` etc.,
   see `.env.example`). They are never committed. To set your own: edit `users.properties`, put the same values in `.env`,
   restart PASOE.

   **Role check in ABL.** `web/FarmHandler.cls` reads `SESSION:CURRENT-REQUEST-INFO:GetClientPrincipal()` and copies the
   user id and roles into `web.AuthContext` for the length of the request. `farm-api.p` then:
   - answers **403 `FORBIDDEN_ROLE`** for admin routes unless the caller has `PSCAdmin`: `POST /farm/doctor/blocked-terms`,
     `POST /farm/doctor/blocked-terms/{id}` (the no-doses word list) and `POST /farm/alert-thresholds/{id}`;
   - records the **real PASOE user** (e.g. `farmadmin`) as `UpdatedBy` and as the `AuditLog` actor for those changes,
     whatever name the request body claims. Farmer decisions keep the farmer as actor (the API calls as `farmapi` on the
     farmer's behalf, after the app-token check).
   - With no principal (batch runs: `run-contract.p`, `seed.p`, the tamper test; or the anonymous model) nothing changes,
     so the 259 batch cases still run as before.

   Proof: `.\scripts\oe-run.ps1 -Action test-security` (`eval/pasoe-security.mjs`): no login 401, wrong password 401,
   `ROLE_None` 403, `farmapi` on an admin route 403 `FORBIDDEN_ROLE`, `farmadmin` 201 with itself in the audit log, and
   the audit chain still verifies. `test-http` sends `OE_AUTH`, and `OE_ADMIN_AUTH` for the admin routes.
   Still demo-grade: plain HTTP on localhost (use the HTTPS port 8821 for anything real) and plain-text passwords in
   `users.properties`.
4. Start: `tcman.bat start` (run it with a hidden/background process; it does not return). Check:
   `curl -u farmapi:<password> http://localhost:8820/web/farm/plots` (without `-u` it is a 401).

The OpenEdge classes `OpenEdge.Web.*` live in `OpenEdge.Net.pl`; `compile-check.p` adds it to PROPATH for batch compiles.
The PASOE instance runs on the Development licence limits (1 agent, 5 concurrent requests), which is plenty for the demo.
