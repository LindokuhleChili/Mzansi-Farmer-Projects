# Re-hosting the demo on Windows Server 2022

The public demo was an AWS EC2 virtual machine running Windows. It was shut down after the AIGS hackathon (29 Oct 2026) because leaving the VM on is costly. This guide brings that same demo up on a new Windows Server 2022 VM.

It follows what is already in the repository:

- `scripts/oe-run.ps1` (create is separate; this script loads schema, starts the database, and seeds)
- `openedge/pasoe/README.md` (PASOE instance `farmops`)
- `docs/COOP.md` section 10, `docs/ESP32.md`, `docs/UI.md`, and `.env.example`

There is no `scripts/setup-mzansi-server.ps1` in this repository. The steps below are the manual setup.

**All data is fictional example data.** Do not put real passwords, API keys, Wi-Fi passwords, or device tokens in Git. `.env` and `firmware/esp32/MzansiFarmSensors/secrets.h` are gitignored. Example addresses below are documentation addresses (`203.0.113.0/24`), not a live host.

## 1. VM size, operating system, and ports

| Item | Use |
|---|---|
| Operating system | Windows Server 2022 |
| Size | 2 vCPU, 8 GB RAM, and at least 50 GB of disk. OpenEdge 12.8, Java, and Node all sit on this machine. An example AWS type is `t3.large`. |
| Public app | TCP **80** open to the people who should see the demo |
| Administration | TCP **3389** (RDP) open only to your own IP, for example `203.0.113.10/32` |
| Stay closed on the public interface | TCP **8820** (PASOE HTTP), **8821** (PASOE HTTPS), **8822** (PASOE shutdown), **20000** (database `farm`), and **3100–3199** (the database's extra server ports) |

PASOE and the database listen on localhost. The Node API is the only process that should accept traffic from the internet, and only on port 80. Mirror the same rules in Windows Defender Firewall: allow 80, allow 3389 from your IP, and do not add public inbound rules for 8820 or 20000.

## 2. Install Git, Node.js, Java 17, and OpenEdge 12.8

Install these on the VM. OpenEdge is a manual install. This repository does not ship an installer, a serial number, or a licence file.

1. **Git for Windows.** Confirm `git` works in PowerShell.
2. **Node.js 22 or newer** (the 22 LTS line is a good choice). `package.json` still says `>=20`, but `package-lock.json` locks `cookie@2` (`cookie@2.0.1`), and that package requires Node `>=22`. On Node 20, `npm install` can succeed and the API can still fail when that dependency loads.
3. **Java 17**, Eclipse Temurin. The project used Temurin 17.0.20.1. Any Temurin 17 build is fine. Set `JAVA_HOME` to the folder that contains `bin\java.exe` before you create the PASOE instance. PASOE will not start without it.
4. **OpenEdge 12.8** (database, ABL, and PAS for OpenEdge). Download it with your own Progress ID and install it to `C:\Progress\OpenEdge`. Set `DLC` to that folder and put `%DLC%\bin` on `PATH`.

```powershell
[System.Environment]::SetEnvironmentVariable('JAVA_HOME', 'C:\Program Files\Eclipse Adoptium\jdk-17', 'Machine')
[System.Environment]::SetEnvironmentVariable('DLC', 'C:\Progress\OpenEdge', 'Machine')
```

Change the `JAVA_HOME` value if the Temurin installer used a different folder. Open a new PowerShell window so the machine variables are visible, then check `java -version`, `node -v`, and `echo $env:DLC`.

## 3. Paths used by this project

| What | Path |
|---|---|
| Repository | `C:\apps\Mzansi-Farmer-Projects` |
| OpenEdge (`DLC`) | `C:\Progress\OpenEdge` |
| Database directory | `C:\OpenEdge\WRK\farm` (database name `farm`, server port **20000**) |
| PASOE instance | `farmops`, HTTP **8820**, HTTPS **8821**, shutdown **8822**. The folder that contains `bin\tcman.bat` was `C:\OpenEdge\WRK\farmops` |

```powershell
New-Item -ItemType Directory -Force -Path C:\apps | Out-Null
git clone https://github.com/LindokuhleChili/Mzansi-Farmer-Projects.git C:\apps\Mzansi-Farmer-Projects
Set-Location C:\apps\Mzansi-Farmer-Projects
npm install
```

`npm install` is required. There is no separate front-end build. The API serves `apps/web/public/` itself.

## 4. Create the database, load the schema, and seed

`scripts/oe-run.ps1 -Action load-schema` loads `002-farm-ops.df` through `010-tank.df`. It does **not** load `001-farm.df`. A brand-new empty database needs `001` first, because later files add columns on the `Farm` table (for example `Province` in `006-weather.df`) and `seed.p` writes `Farm` rows.

The server must be stopped for every schema load. These commands are single-user (`-1`). Run them from an elevated or normal PowerShell window that already has `DLC` set.

```powershell
$Dlc = 'C:\Progress\OpenEdge'
$env:DLC = $Dlc
$DbDir = 'C:\OpenEdge\WRK\farm'
$Repo = 'C:\apps\Mzansi-Farmer-Projects'
$Src = Join-Path $Repo 'openedge\src'

New-Item -ItemType Directory -Force -Path $DbDir | Out-Null
Push-Location $DbDir
& (Join-Path $Dlc 'bin\prodb.exe') farm empty
Pop-Location

# 001 is not part of -Action load-schema. Stay in openedge\src, same as oe-run.ps1.
Push-Location $Src
& (Join-Path $Dlc 'bin\_progres.exe') -b -db (Join-Path $DbDir 'farm') -1 -p load-schema.p -param (Join-Path $Repo 'openedge\schema\001-farm.df')
Pop-Location
$err = Join-Path $Src 'farm.e'
if (Test-Path $err) { Get-Content $err; throw "001-farm.df failed. See $err" }

Set-Location $Repo
.\scripts\oe-run.ps1 -Action load-schema   # 002 through 010, server still stopped
.\scripts\oe-run.ps1 -Action start-db      # port 20000, extra ports 3100-3199 (keeps 3000 free)
.\scripts\oe-run.ps1 -Action seed          # example farms, plots, co-op, market, weather, doctor, guides
```

`load-schema` throws if a `.df` writes `openedge\src\farm.e`. Delete that file only after you have read it and fixed the cause. `start-db` launches `proserve` and returns. `seed` talks to the running server.

On a later update, stop the database before another schema load (`.\scripts\oe-run.ps1 -Action stop-db`). Incremental loads (`load-coop`, `load-market`, `load-audit-chain`, `load-weather`, `load-doctor`, `load-assistant`, `load-similar`, `load-tank`) are for a database that already has the earlier files. A fresh VM uses `001` plus `load-schema`, then `seed`, once.

## 5. PASOE instance `farmops`

Full notes, including the role check inside ABL, are in `openedge/pasoe/README.md`. Short version for a new VM:

1. Create the instance with HTTP 8820, HTTPS 8821, and shutdown 8822. `JAVA_HOME` must already point at Java 17.

   ```powershell
   $env:DLC = 'C:\Progress\OpenEdge'
   $env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-17'   # your Temurin 17 folder
   New-Item -ItemType Directory -Force -Path C:\OpenEdge\WRK | Out-Null
   Set-Location C:\OpenEdge\WRK
   & "$env:DLC\bin\pasman.bat" create -p 8820 -P 8821 -s 8822 farmops
   ```

   If `pasman` prints a usage error, run `& "$env:DLC\bin\pasman.bat" help create` and keep those three ports and the name `farmops`. The instance directory is the folder that contains `bin\tcman.bat`. If that folder is not `C:\OpenEdge\WRK\farmops`, use the folder `pasman` actually created for every path below.

2. In `conf\openedge.properties`, set the agent to the database server and put this repo's ABL first on `PROPATH`:

   - `[AppServer.SessMgr.farmops]` `agentStartupParam=-T "${catalina.base}/temp" -db C:/OpenEdge/WRK/farm/farm -H localhost -S 20000`
   - `[AppServer.Agent.farmops]` `PROPATH=C:\apps\Mzansi-Farmer-Projects\openedge\src,...` (this repo's `openedge\src` first; leave the rest of the existing `PROPATH`)

3. Copy the handler map (it sends `/web/farm` and `/web/farm/{*}` to `web.FarmHandler`):

   ```powershell
   Copy-Item C:\apps\Mzansi-Farmer-Projects\openedge\pasoe\ROOT.handlers `
     C:\OpenEdge\WRK\farmops\webapps\ROOT\WEB-INF\adapters\web\ROOT\ROOT.handlers
   ```

4. Turn on basic login. Under `webapps\ROOT\WEB-INF\`:

   - `oeablSecurity.properties`: `client.login.model=basic` and `http.all.authmanager=local`
   - `oeablSecurity.csv`: `"/web/**","*","hasAnyRole('ROLE_PSCUser')"`
   - `users.properties`: remove the default `rest*` users and add three of your own. Passwords are random strings you invent on this machine. They live only in this file and in `.env`. Example shape (replace every password before you start PASOE):

     ```
     farmapi=replace-with-a-long-random-password,ROLE_PSCUser,enabled
     farmadmin=replace-with-a-different-random-password,ROLE_PSCUser,ROLE_PSCAdmin,enabled
     farmnone=replace-with-a-third-random-password,ROLE_None,enabled
     ```

     `farmapi` is the user the Node API uses for normal calls. `farmadmin` is for blocked-terms and alert-threshold changes. `farmnone` exists only so the 403 test has a user without `ROLE_PSCUser`.

5. Start PASOE from the instance directory. `tcman.bat start` does not return, so give it its own window:

   ```powershell
   Set-Location C:\OpenEdge\WRK\farmops
   .\bin\tcman.bat start
   ```

   From the VM, a call without a password is a 401. With `farmapi` it returns plots:

   ```powershell
   curl.exe -u farmapi:replace-with-a-long-random-password http://127.0.0.1:8820/web/farm/plots
   ```

   Do not open 8820 in the security group to check this. Use the VM's own localhost.

The Development licence allows one agent and five concurrent requests. That is enough for the demo. The instance speaks plain HTTP on localhost. Use HTTPS on 8821 if you expose PASOE beyond this machine. This guide keeps it private.

## 6. Create `.env` (no secrets in Git)

From the repository root:

```powershell
Set-Location C:\apps\Mzansi-Farmer-Projects
npm run setup
```

`npm run setup` copies `.env.example` to `.env` if needed and writes random `APP_TOKEN` and `DEVICE_REGISTRY` values. It does not print them. Then edit `.env` on the server only. Real environment variables win over the file.

Set at least these. Values shown are placeholders:

```
PORT=80
HOST=0.0.0.0

OE_MODE=pasoe
OE_BASE_URL=http://localhost:8820/web
OE_AUTH=farmapi:replace-with-a-long-random-password
OE_ADMIN_AUTH=farmadmin:replace-with-a-different-random-password
OE_NONE_AUTH=farmnone:replace-with-a-third-random-password

AI_PROVIDER=http
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
AI_MODEL=gemini-3.5-flash-lite
AI_API_KEY=replace-with-your-gemini-key

ESP32_DASHBOARD_URL=http://mzansi-farm.local
```

| Variable | What to put |
|---|---|
| `PORT` | `80`, so browsers open the site with no port in the URL. `HOST` stays `0.0.0.0`. |
| `APP_TOKEN` | Leave the random value `npm run setup` wrote. A value that starts with `replace-` makes the API refuse to start. Remote browsers paste this token when the page asks (see below). |
| `DEVICE_REGISTRY` | Leave the generated JSON. The ESP32 `DEVICE_TOKEN` must be that entry's `token`, for device `esp32-01` and plot `1`. It is not `APP_TOKEN`. |
| `OE_AUTH` / `OE_ADMIN_AUTH` | The same `user:password` pairs you wrote in `users.properties`. |
| `AI_MODEL` | `gemini-3.5-flash-lite` with `AI_PROVIDER=http` and your own Gemini key. The key is read from `.env` and is never logged. |
| `ESP32_DASHBOARD_URL` | The board's DHCP address (`http://192.168.0.50` is an example shape) or `http://mzansi-farm.local`. The API never connects to it. The station-mode board does not serve the unset default `http://192.168.4.1`. |

`git status` must not list `.env` as a file to commit. `.gitignore` already ignores `.env` and keeps `.env.example`.

A browser on another computer does not get the local `/ui/api` proxy. The page returns 403 `UI_LOCAL_ONLY` and asks for `APP_TOKEN`, which stays in that tab's `sessionStorage`. Leave `UI_ALLOW_REMOTE` unset. Details are in `docs/UI.md`.

## 7. Start the API

The database server and PASOE must already be running. From the repository root, in a window you leave open:

```powershell
Set-Location C:\apps\Mzansi-Farmer-Projects
node apps\api\src\index.js
```

`npm start` is the same command (`node apps/api/src/index.js`). A good start prints a line like:

```
mzansi-farmer-ops API on http://0.0.0.0:80  (OE_MODE=pasoe, AI=http)  EXAMPLE DATA ONLY
```

The working directory has to be the repository root. The process reads `.env` from the current directory.

**Known gotcha.** Launching Node with `Start-Process` exited silently: the command returned, no window stayed open, and nothing was listening. Do not start the API that way. Use the foreground window above or, better, a Windows service so it comes back on its own after a crash or a reboot.

[NSSM](https://nssm.cc/) (Non-Sucking Service Manager) is one way to do that. Install NSSM yourself. It is not in this repo. Point the service at `node.exe`, with the script path and the repo as the working directory, so `.env` still loads:

```powershell
nssm install MzansiFarmerApi "C:\Program Files\nodejs\node.exe" "C:\apps\Mzansi-Farmer-Projects\apps\api\src\index.js"
nssm set MzansiFarmerApi AppDirectory "C:\apps\Mzansi-Farmer-Projects"
nssm set MzansiFarmerApi AppStdout "C:\apps\Mzansi-Farmer-Projects\logs\api-stdout.log"
nssm set MzansiFarmerApi AppStderr "C:\apps\Mzansi-Farmer-Projects\logs\api-stderr.log"
nssm set MzansiFarmerApi AppRotateFiles 1
nssm set MzansiFarmerApi Start SERVICE_AUTO_START
nssm start MzansiFarmerApi
```

`logs\` is gitignored. If port 80 will not bind, check who already listens (`Get-NetTCPConnection -LocalPort 80 -State Listen`) and whether Windows has reserved the port (`netsh interface ipv4 show excludedportrange protocol=tcp`).

After a reboot, start in this order. The Node service does not start OpenEdge for you.

1. `.\scripts\oe-run.ps1 -Action start-db`
2. `C:\OpenEdge\WRK\farmops\bin\tcman.bat start` (its own window, or its own service)
3. The `MzansiFarmerApi` service, or the foreground `node` command

If Node starts first, the site can load and then fail its OpenEdge calls until the database and PASOE are up. Set the Node service to delayed automatic start if you also start OpenEdge at boot.

## 8. ESP32 sensor board

The live field page and the cloud upload are described in `docs/ESP32.md`. The server never proxies the board. A browser on the same Wi-Fi as the board reads it directly.

- **Station mode, 2.4 GHz only.** The sketch `firmware/esp32/MzansiFarmSensors/MzansiFarmSensors.ino` joins the network in `secrets.h`. It does not start a hotspot. The ESP32 cannot use 5 GHz, a captive portal, or WPA2-Enterprise. A phone or laptop hotspot on 2.4 GHz is enough.
- **`secrets.h` is not committed.** Copy `firmware/esp32/MzansiFarmSensors/secrets.example.h` to `secrets.h` and fill in the Wi-Fi name, the Wi-Fi password, and `DEVICE_TOKEN` (the `DEVICE_REGISTRY` token, not `APP_TOKEN`). For cloud upload set `ENABLE_CLOUD_UPLOAD` to `1` and set `API_BASE_URL` to the public site with no trailing slash, for example `http://203.0.113.50`. Leave `CLIMATE_VALUES_ARE_REAL` at `0` until the temperature and humidity numbers are real, or the soil upload stays off on purpose.
- **Calibration.** The device page and the app call `GET /calibrate?mode=` with one of `wempty`, `wfull`, `sdry`, `swet` (water empty, water full, soil dry, soil wet). Percents stay at `-1` until both points for that sensor are saved. Water is GPIO34 and soil is GPIO35.
- **Browser Local Network Access.** Chrome can block a public page from calling a private address such as `http://mzansi-farm.local`. On `/#/sensors`, allow Local network access for the site, or use **Open dashboard**. The page explains this and can embed the device page when the direct read is blocked. The address is not a secret. Do not put a password in `ESP32_DASHBOARD_URL`.

Serial at 115200 prints the DHCP address. `http://mzansi-farm.local/` works when mDNS works. School or office Wi-Fi that isolates clients will hide the board from the laptop even when both have an address.

## 9. Cost

Stop the EC2 instance when nobody is using the demo. The running VM is the bill. An Elastic IP keeps the same public address across a stop and a start, and AWS bills that address while the instance is stopped. Release the Elastic IP if you do not need the address to stay the same. A new start without an Elastic IP gets a new public address, and the ESP32 `API_BASE_URL` has to change with it.

## 10. Checklist

Run these before you call the host done. Use your own token and passwords. Do not paste them into a ticket, a commit, or a screenshot you publish.

1. On the VM, `curl.exe http://127.0.0.1/health` returns JSON with `"status":"ok"`, `"oeMode":"pasoe"`, and `"aiProvider":"http"` (or `"mock"` if you left the AI on the mock).
2. From another computer, `http://203.0.113.50/` (your real public address, port 80) loads the web UI. The page asks for the app token. Paste `APP_TOKEN` from the server `.env`. The five example plots are listed (Maize A, Beans B, Spinach C, Tomato D, Cabbage E).
3. On the VM only, `curl.exe -u farmapi:<password> http://127.0.0.1:8820/web/farm/plots` returns those plots. The same URL from the internet does not connect, because 8820 is closed. Port 20000 from the internet does not connect either.
4. RDP on 3389 answers only from your IP.
5. `npm test` in the repo still passes. It uses the mock OpenEdge and the mock AI. It does not need this VM's database.
6. Live sensors: a browser on the board's 2.4 GHz Wi-Fi opens `/#/sensors`, allows Local network access if asked, and shows gauges after calibration. **Open dashboard** opens the device page.
7. `git status` in `C:\apps\Mzansi-Farmer-Projects` does not show `.env` or `secrets.h` as staged changes.
