# Hosting farm-api.p on PAS for OpenEdge (what was actually done on the laptop)

Instance `farmops` was created with `pasman create` (HTTP 8820, HTTPS 8821, shutdown 8822), then:

1. `conf/openedge.properties`
   - `[AppServer.SessMgr.farmops]` `agentStartupParam=-T "${catalina.base}/temp" -db C:/OpenEdge/WRK/farm/farm -H localhost -S 20000`
     (agents connect to the farm database server on port 20000)
   - `[AppServer.Agent.farmops]` `PROPATH=<repo>/openedge/src,...` (put the repo's `openedge/src` first)
2. Copy `ROOT.handlers` (this folder) to `webapps/ROOT/WEB-INF/adapters/web/ROOT/ROOT.handlers`.
   It maps `/web/farm/...` to `web.FarmHandler` (`openedge/src/web/FarmHandler.cls`), which calls `farm-api.p`.
   After changing it: `tcman.bat jmx refreshWeb -appname farmops -webappname ROOT`.
3. **Demo-only security relaxation:** in `webapps/ROOT/WEB-INF/oeablSecurity.csv` the line for `/web/**` was changed from
   `hasAnyRole('ROLE_PSCUser')` to `permitAll()` (login model is `anonymous`). This is acceptable only because the instance
   listens on the laptop and the Node API is the only caller. For anything real use basic or form login and set `OE_AUTH`.
4. Start: `tcman.bat start` (run it with a hidden/background process; it does not return). Check:
   `curl http://localhost:8820/web/farm/plots`.

The OpenEdge classes `OpenEdge.Web.*` live in `OpenEdge.Net.pl`; `compile-check.p` adds it to PROPATH for batch compiles.
The PASOE instance runs on the Development licence limits (1 agent, 5 concurrent requests), which is plenty for the demo.
