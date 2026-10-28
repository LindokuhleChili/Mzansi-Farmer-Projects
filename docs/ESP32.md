# ESP32

Two ESP32 uses live in this project. They do not share a network path.

| Use | Where | What talks to it |
|---|---|---|
| Live field page | The board joins the farmer's Wi-Fi (station mode). Address `ESP32_DASHBOARD_URL`, also `http://mzansi-farm.local` when mDNS works | The farmer's **browser** only. The Node API never connects to it. |
| Sensor feed | `firmware/esp32` (PlatformIO) and `sim/` posting to `/api/v1/readings`, plus optional uploads from `firmware/esp32/MzansiFarmSensors/` | The board (or the simulator) calls the API. The live page does not write those rows. |

The station-mode sketch is `firmware/esp32/MzansiFarmSensors/MzansiFarmSensors.ino`. Water level is GPIO34 and soil moisture is GPIO35. The separate PlatformIO feed (`firmware/esp32/src`) uses a different sensor layout (soil on GPIO34, DHT22 on GPIO4) and posts readings to the API.

## Live field page (browser only)

The board joins the Wi-Fi named in `secrets.h`. It does not start a hotspot. Serial (115200) prints the DHCP address. The same board answers `http://mzansi-farm.local/` when mDNS works.

| Item | Value |
|---|---|
| Wi-Fi | The farmer's network (phone or laptop hotspot, 2.4 GHz), from `secrets.h` |
| Name on the network | `mzansi-farm.local` |
| Page | `GET /` (HTML dashboard on the device) |
| JSON | `GET /data` returns `wRaw`, `wPct`, `wE`, `wF`, `wEs`, `wFs`, `sRaw`, `sPct`, `sD`, `sW`, `sDs`, `sWs`, `sta`, `staIp`, `cloud`, `rssi`. `wPct` and `sPct` are `-1` until both calibration points for that sensor are saved. |
| History | `GET /history` returns `{intervalMs, w:[raw...], s:[raw...]}` |
| Calibration | `GET /calibrate?mode=` one of `wempty`, `wfull`, `sdry`, `swet` |
| CORS | `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Private-Network: true` on those JSON responses and on `OPTIONS` |
| Pins | Water-level signal GPIO34. Soil-moisture AO GPIO35. Both use 3V3 and GND. |

The app shows this on **`/#/sensors`** (Live sensors), linked from the dashboard, the sidebar, and Settings. The page fetches `/data` about every 1.5 s and `/history` once when a reading loads. It draws water and soil gauges (percent when calibrated, raw ADC with a not-calibrated hint otherwise), line charts, Wi-Fi and RSSI, and the four calibration buttons. **Open dashboard** still opens `GET /` in a new tab.

### Config key

| | |
|---|---|
| Environment variable | `ESP32_DASHBOARD_URL` |
| Default, if unset or blank | `http://192.168.4.1` |
| What to set for this sketch | The DHCP address printed on Serial, or `http://mzansi-farm.local` |
| Invalid value (not http/https, or a username/password in the URL) | The API refuses to start |
| How the page learns it | `GET /ui/session` field `esp32DashboardUrl` (also when `mode` is `token`, because the live site is not on the device) |
| Per-browser override | `localStorage` key `mf.esp32Url`, edited on the Live sensors page. **Use server default** deletes it. |

The address is not a secret. It is not an app token, a device token, or the AI key. Do not put a password in the URL. `http://192.168.4.1` remains the value when the variable is missing, so an old `.env` still starts. This sketch does not use that address.

### Why the server does not proxy

The live app is served from the cloud (plain HTTP, for example `http://13.43.92.196`). The ESP32 address exists only on the farmer's Wi-Fi. The server cannot open it, so there is no server-side fetch, rewrite, or proxy to the device. A browser on that same Wi-Fi reads `GET /data` directly.

Chrome can block a public site from calling a private address (Local network access). A failed fetch shows a short message: allow Local network access for this site, or use **Open dashboard**. The device page is embedded in an iframe under that message, so a browser that still allows the frame can show it. The iframe is sandboxed with `allow-scripts`, `allow-same-origin`, and `allow-modals`. It is not allowed to navigate this app.

Content-Security-Policy keeps `script-src 'self'`. `frame-src` and `connect-src` also allow `http:` and `https:`, because the saved address is chosen in the browser and is not one fixed host. The app and the device are both plain HTTP, so the iframe is not mixed content.

These readings are **not** stored in OpenEdge by this page and do **not** drive irrigation suggestions. That still requires the sensor feed below, or `ENABLE_CLOUD_UPLOAD` on the sketch.

### Deploy on the Windows server (port 80)

This change is Node and static files only. It does not change the OpenEdge schema, ABL, or the database. **Do not stop the database** (port 20000) or PASOE.

From the repository root in PowerShell:

```powershell
git pull
npm install
```

There is no build step. `npm install` is only needed when `package-lock.json` changed. This page does not.

Add this line to `.env` on the server (do not commit `.env`). Use the address the board prints, or `http://mzansi-farm.local`. If the line is missing, the API still uses `http://192.168.4.1`, which this station-mode board does not serve.

```
ESP32_DASHBOARD_URL=http://mzansi-farm.local
```

Restart the Node process that listens on port 80. Leave the database and PASOE running.

```powershell
Get-NetTCPConnection -LocalPort 80 -State Listen | Select-Object OwningProcess
```

Stop that process the same way it is supervised, then start it again the same way so it keeps port 80. Real environment variables win over `.env`. If the service already sets `PORT=80`, do not change `PORT` inside `.env` unless that file is what the service reads. A hand start looks like:

```powershell
$env:PORT = '80'
npm start
```

Then open `http://<server>/#/sensors`.

### If the device address changes

The board gets its address from DHCP. `mzansi-farm.local` stays the same when mDNS works. If you use a numeric address, two places can still point at the old one:

1. A browser that saved an address (`mf.esp32Url`) keeps it until someone types the new address on Live sensors and presses **Save address**, or presses **Use server default**.
2. Browsers with no saved address use `ESP32_DASHBOARD_URL`. Change that line in `.env` and restart Node. A restart does not clear a saved browser address.

Nothing in the database, the device token, or `POST /api/v1/readings` uses this address. Changing it does not move plots or suggestions.

## Sensor feed (firmware + simulator)

The ESP32 feed of **Mzansi Farmer Ops**. It has these parts:

| Part | Path | What it does |
|---|---|---|
| Soil + water sketch | `firmware/esp32/MzansiFarmSensors/` | Arduino sketch for the analog board (water GPIO34, soil GPIO35). Station-mode dashboard at `mzansi-farm.local`. Cloud upload is off unless `ENABLE_CLOUD_UPLOAD` is `1`. |
| Firmware | `firmware/esp32` | PlatformIO/Arduino. Reads soil moisture, temperature and humidity every 30 s and POSTs JSON over Wi-Fi to the API. |
| Simulator | `sim/esp32-sim.js` | Pretends to be the ESP32 (`normal`, `drought`, `stale`, `invalid`) for demos and QA. |
| Mock API | `sim/mock-server.js` | Tiny standalone server that implements only the device contract (201/400/401/409). Not needed when you run the real Node API (`npm start`); use it to test the feed alone. |

All of them use the same readings contract (`docs/API.md`, section on `POST /api/v1/readings`). Each sketch posts only to the URL in its gitignored config. Nothing in the repo adds a hidden endpoint.

## MzansiFarmSensors (soil on the existing readings path)

Sketch folder: `firmware/esp32/MzansiFarmSensors/`. Built-in libraries only (Wi-Fi, WebServer, ESPmDNS, HTTPClient, Preferences).

The board measures **soil** on GPIO35 and **water** on GPIO34. Calibration (dry/wet and empty/full) is stored in Preferences under the namespace `cal` and survives restarts. `WiFi.mode(WIFI_STA)` joins the network named in `secrets.h` (2.4 GHz) and serves the dashboard on that address. The board is a Wi-Fi client only.

Cloud upload is off unless `secrets.h` sets `ENABLE_CLOUD_UPLOAD` to `1`. When it is on, about every 10 seconds, once soil is calibrated, the sketch POSTs:

```
POST {API_BASE_URL}/api/v1/readings
X-Device-Token: <DEVICE_TOKEN>
Content-Type: application/json

{
  "deviceId": "esp32-01",
  "plotId": 1,
  "timestamp": "2026-10-28T10:00:00Z",
  "soilMoisturePct": 42,
  "temperatureC": 22.0,
  "humidityPct": 55.0,
  "raining": false
}
```

Field names, the integer `plotId`, and the header are the ones `apps/api/src/app.js` checks. `deviceId` and `plotId` must match the `DEVICE_REGISTRY` entry for that token. `201` is stored, `409` (same device and timestamp) is treated as success, `400` is not retried as the same body, `401` stops uploads until reboot. Other HTTP and network errors use a non-blocking backoff (10 s, 20 s, 40 s … capped at 5 min). Wi-Fi reconnects are also scheduled with `millis()` (every 15 s) so the dashboard loop is not stuck in a connect wait. The POST itself uses `HTTPClient`, which blocks for that one request (timeout 8 s). The dashboard shows the last cloud status, and the internet Wi-Fi address, on the same page.

`temperatureC` and `humidityPct` are required by the soil route and by `SensorReading` (both columns are mandatory). This analog board does not measure them. `secrets.h` has `CLIMATE_TEMPERATURE_C` and `CLIMATE_HUMIDITY_PCT`. The soil post stays off until `CLIMATE_VALUES_ARE_REAL` is `1`, so the placeholder numbers in `secrets.example.h` are never stored as a soil reading. Put a real thermometer reading there first. `raining` is `false` (no rain sensor). The water post does not wait for that flag. Irrigation rules use soil moisture, rain, reading age, and the water budget. The temperature and humidity tiles show whatever was stored.

The plot cards show the latest soil percentage beside a water-level tile (`apps/web/public/assets/js/views.js`). The page reloads both about every 30 s. An uncalibrated tank shows "Not calibrated". A calibrated one shows the percent.

### Water level (`POST /api/v1/tank-readings`)

Same header `X-Device-Token`, same `deviceId` and `plotId` as the soil post. The body is:

```
{
  "deviceId": "esp32-01",
  "plotId": 1,
  "timestamp": "2026-10-28T10:00:10Z",
  "waterLevelRaw": 1834,
  "waterLevelPct": 46,
  "calibrated": true
}
```

`waterLevelRaw` is an integer from 0 to 4095. `waterLevelPct` is 0 to 100 when `calibrated` is true, and `null` when `calibrated` is false (the probe has not had both EMPTY and FULL saved). `201` stores a row, `409` is the same device and timestamp, `401` stops both uploads until reboot. The app reads `GET /api/v1/plots/{id}/tank-readings` with the farmer bearer token.

The table is `TankReading` in `openedge/schema/010-tank.df` (`TankReadingId`, `PlotId`, `DeviceId`, `ReadAt`, nullable `LevelPct`, `LevelRaw`, `Calibrated`). `scripts/oe-run.ps1 -Action load-tank` loads that file only, the same way `load-similar` loads `009-similar.df`. `load-schema` and the throw-away scratch database also include it. The mock OpenEdge store (`mock-pasoe`) accepts the route with no database, which is what `npm test` uses.

`npm test` does not stop a database and does not call the public host.

### Windows deploy (backup, stop, load, start)

Run this on the Windows machine that hosts the farm database (OpenEdge 12.8, `DLC` default `C:\Progress\OpenEdge`, database directory default `C:\OpenEdge\WRK\farm`, PASOE instance `farmops`). PowerShell, from the repo root, after this branch is checked out there. These commands were not run from the agent, and nothing was run on the public server.

Do not run `seed` as part of this load. Seed replaces the example readings. The new table starts empty.

```powershell
$Dlc = if ($env:DLC) { $env:DLC } else { 'C:\Progress\OpenEdge' }
$DbDir = if ($env:FARM_DB_DIR) { $env:FARM_DB_DIR } else { 'C:\OpenEdge\WRK\farm' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = 'C:\OpenEdge\WRK\backup'
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$bk = Join-Path $backupDir "farm-before-010-tank-$stamp.bk"

# 1. Online backup WHILE the database server is still running. This is the backup before the stop.
#    If this command fails, stop here. Do not stop the database.
& (Join-Path $Dlc 'bin\probkup.bat') online (Join-Path $DbDir 'farm') $bk
if ($LASTEXITCODE -ne 0) { throw "Backup failed ($bk). The database was not stopped." }
Write-Output "Backup written: $bk"

# 2. Stop PASOE so its agent disconnects. Use the farmops instance directory
#    (the folder that contains bin\tcman.bat). Example:
#    Set-Location C:\OpenEdge\WRK\farmops
#    .\bin\tcman.bat stop

# 3. Stop the database server (single-user schema load cannot run while it is up).
#    Run the next commands from the repository root.
.\scripts\oe-run.ps1 -Action stop-db

# 4. Load 010-tank.df only. A farm.e file next to openedge\src means the load failed.
.\scripts\oe-run.ps1 -Action load-tank

# 5. Start the database again (port 20000).
.\scripts\oe-run.ps1 -Action start-db

# 6. Start PASOE again so it compiles farm-api.p, which now uses TankReading.
#    From the farmops instance directory: .\bin\tcman.bat start
#    Do not point PASOE at this branch's farm-api.p before step 4. The old
#    database has no TankReading table, so that compile fails.

# 7. Restart the Node API on that machine (OE_MODE=pasoe) so POST /api/v1/tank-readings is served.
#    Copy the new DEVICE_REGISTRY token into .env only if the device is not already esp32-01 on plot 1.
```

Until step 4 has been done on that database, a PASOE process running this branch's `farm-api.p` will not compile. The Node mock (`OE_MODE=mock`) does not need the stop.

### secrets.h

```bash
cd firmware/esp32/MzansiFarmSensors
cp secrets.example.h secrets.h
# edit WIFI_SSID, WIFI_PASSWORD, DEVICE_TOKEN, and the climate lines
```

`secrets.h` is gitignored. `secrets.example.h` has placeholders only.

Token (same value as that device's `token` inside `DEVICE_REGISTRY` in `.env`, not `APP_TOKEN`):

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

PowerShell:

```powershell
-join ((1..32 | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) }))
```

`npm run setup` writes a random device token into `.env` for `esp32-01` / plot `1`. Copy that token into `secrets.h`. A token that starts with `replace-` is rejected when the API starts.

### Upload

Board: ESP32 Dev Module. Port example: `COM10`. Serial monitor: 115200. Hold BOOT if the upload stays on "Connecting".

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/esp32/MzansiFarmSensors
arduino-cli upload -p COM10 --fqbn esp32:esp32:esp32 firmware/esp32/MzansiFarmSensors
```

School Wi-Fi with a captive portal or WPA2-Enterprise will not work, and 5 GHz will not either. Use the farmer's 2.4 GHz Wi-Fi or a laptop hotspot, and put that name in `secrets.h`. The ESP32 needs NTP (UDP 123) before a cloud upload. The local dashboard does not. Plain HTTP means the device token is not encrypted on the wire. Fine for this demo, not for production.

### curl (same body the sketch sends)

Use a timestamp that is not already stored, in UTC, with a trailing `Z` and no milliseconds. `$DEVICE_TOKEN` is the registry token.

```bash
curl -i -X POST http://localhost:3000/api/v1/readings \
  -H "Content-Type: application/json" -H "X-Device-Token: $DEVICE_TOKEN" \
  -d '{"deviceId":"esp32-01","plotId":1,"timestamp":"2026-10-28T10:00:10Z","soilMoisturePct":42,"temperatureC":22.0,"humidityPct":55,"raining":false}'
```

Expect `201` and a JSON `id`. Then open the maize plot in the app (or `GET /api/v1/plots/1/readings` with `Authorization: Bearer <APP_TOKEN>`). The newest row's soil percentage is the value you posted. Soil uses the existing `SensorReading` table, so that post does not need a schema load.

Tank, same token, a new timestamp:

```bash
curl -i -X POST http://localhost:3000/api/v1/tank-readings \
  -H "Content-Type: application/json" -H "X-Device-Token: $DEVICE_TOKEN" \
  -d '{"deviceId":"esp32-01","plotId":1,"timestamp":"2026-10-28T10:00:10Z","waterLevelRaw":1834,"waterLevelPct":46,"calibrated":true}'
```

`GET /api/v1/plots/1/tank-readings` with the bearer token returns that row, and the plot card shows 46% next to soil. On `OE_MODE=mock` this works with no database stop. On the real farm database, load `010-tank.df` first (the Windows steps above). An uncalibrated probe sends `"waterLevelPct":null,"calibrated":false`.

## API contract

```
POST http://<laptop-LAN-IP>:3000/api/v1/readings
X-Device-Token: <DEVICE_TOKEN>          (not "Authorization: Bearer")
Content-Type: application/json

{
  "deviceId": "esp32-01",
  "plotId": 1,                           // INTEGER
  "timestamp": "2026-10-24T08:00:00Z",   // ISO-8601 UTC, trailing Z, no milliseconds
  "soilMoisturePct": 42.3,               // 0-100
  "temperatureC": 23.5,
  "humidityPct": 61.0                    // 0-100
}
```

| Status | Meaning | Firmware and sim behaviour |
|---|---|---|
| `201 {id}` | stored | success |
| `400 {error, field}` | validation failed | **no retry**; logs the offending `field` |
| `401` | bad or missing token | **no retry**; logs "check DEVICE_TOKEN" |
| `409` | duplicate (`deviceId` + `timestamp`) | treated as success and skipped |
| 5xx, 408, 429, network error/timeout | transient | retry with exponential backoff (1 s, 2 s, 4 s ... capped at 30 s; 5 attempts on the firmware, 4 in the sim), then the reading is dropped |

Each reading gets a unique timestamp (whole seconds, strictly increasing), so there are no accidental 409s. Values are rounded to 1 decimal.

**Where to change the contract:** path, header name and JSON field names each live in one marked block:
- Firmware: `firmware/esp32/lib/feedcore/feedcore.h` (the `API CONTRACT` block).
- Sim and mock: `sim/payload.js` (the `CONTRACT` object).

## Hardware and wiring (22-in-1 sensor kit)

| Sensor | Pin on the ESP32 | Notes |
|---|---|---|
| Analog soil-moisture module, `AO` | **GPIO34** (ADC1) | Power at 3.3 V. GPIO34 is input-only. Don't use ADC2 pins (GPIO 0, 2, 4, 12-15, 25-27) for analog sensors: the ADC doesn't work there while Wi-Fi is on. (The DHT on GPIO4 is digital, so that is fine.) |
| DHT22 / AM2302, data | **GPIO4** | 3.3 V, GND. Needs a 10 kΩ pull-up from data to 3.3 V if your module doesn't have one. |

Pins, sensor type and calibration are `#define`s in `include/config.h`. If your kit's temperature/humidity module is a DHT11, set `DHT_TYPE DHT11`.

**Calibrate soil moisture:** print the raw value with the probe in dry air and again in a glass of water, then set `SOIL_RAW_DRY` and `SOIL_RAW_WET`. The defaults (3200 and 1300) are typical for capacitive modules, so check yours.

## Firmware setup

```bash
pip install platformio              # or the PlatformIO IDE extension
cd firmware/esp32
cp include/config.example.h include/config.h     # config.h is gitignored: never commit it
# edit include/config.h: WIFI_SSID, WIFI_PASSWORD, API_BASE_URL (laptop LAN IP), DEVICE_TOKEN, DEVICE_ID, PLOT_ID
pio run -e esp32dev -t upload
pio device monitor                  # 115200 baud
```

- The ESP32 only supports **2.4 GHz** Wi-Fi.
- Windows firewall: allow inbound TCP 3000 on the laptop, and keep the laptop and ESP32 on the same network. A phone hotspot works for the demo.
- The ESP32 needs NTP (`pool.ntp.org`) for the UTC timestamp. It won't send until the clock has synced.
- A reading is **skipped, not sent**, if any value is NaN (sensor failure), the temperature is outside -40..80 °C, or the clock isn't set. Percentages are clamped to 0-100.

How the firmware is laid out:
- `lib/feedcore/` has the payload builder, timestamp formatter, response classifier and backoff. It has **no hardware dependencies**, so it also builds on the host.
- `src/main.cpp` has the Arduino glue: Wi-Fi reconnect, sensor reads, HTTP POST and the retry loop.

## Tests

### Node (simulator, payload builder, mock server)
Needs Node 18+ and has no dependencies.
```bash
cd sim
node --test            # or: npm test
```
It covers field names, rounding, ISO-8601 UTC timestamp, NaN handling, scenario output ranges, unique timestamps, the retry policy, and end-to-end runs of the sim against the mock server (201/400/401/409).

### Firmware payload builder (PlatformIO `native`, Unity)
```bash
cd firmware/esp32
pio test -e native
```
This needs a host C++ compiler (`g++`/`clang++`). It covers the exact JSON, ISO-8601 formatting (including leap days), rounding, clamping, NaN/Inf/out-of-range rejection, HTTP classification, error-field extraction and backoff.

## Running the simulator

```bash
cd sim
# 1. start the mock API (any token you like; the sim must use the same one)
DEVICE_TOKEN=demo-token node mock-server.js --port 3000

# 2. in another terminal
export DEVICE_TOKEN=demo-token
node esp32-sim.js --scenario normal  --url http://localhost:3000 --interval 2 --count 10
node esp32-sim.js --scenario drought --url http://localhost:3000 --interval 2 --count 40
node esp32-sim.js --scenario stale   --url http://localhost:3000 --interval 2 --stale-after 3
node esp32-sim.js --scenario invalid --url http://localhost:3000 --count 1     # expect 400 on soilMoisturePct

# Print payloads only (no network, no token needed)
node esp32-sim.js --scenario drought --dry-run --count 5
```

Against the real API (`npm start` in the repo root), use `--url http://<laptop-ip>:3000` and the device token from `.env` (`DEVICE_REGISTRY`, created by `npm run setup`). `npm test` also runs the simulator against the Node API automatically (`eval/run-sim-api.mjs`).

Options: `--scenario`, `--url`, `--interval <seconds, default 30>`, `--count <default 10, 0 = forever>`, `--dry-run`, `--device-id`, `--plot-id`, `--seed`, `--stale-after <n>`, `--stale-mode stop|old`, `--max-attempts`. The token comes from the `DEVICE_TOKEN` env var only, never a flag. Run `node esp32-sim.js --help` for details.

| Scenario | What it sends |
|---|---|
| `normal` | Soil about 45% (±6), temperature about 23 °C (±3), humidity about 60% (±5), with noise. |
| `drought` | Soil decays exponentially from about 40% to about 8%, temperature 34-38 °C, humidity falling from about 25% to about 17%. |
| `stale` | Normal values for `--stale-after` readings (default 3), then **stops** (`--stale-mode stop`, the default). With `--stale-mode old` it keeps sending but with timestamps about 2 hours in the past, each unique so there are no 409s. Use this to exercise stale-data detection. |
| `invalid` | Normal values but `soilMoisturePct: 150`, so QA gets a `400 {"error":..., "field":"soilMoisturePct"}`. |

The mock server (`sim/mock-server.js`) checks `X-Device-Token`, validates the body per the contract, answers 401/400/409/201, and logs every reading. Extras: `GET /health` and `GET /api/v1/readings` (lists what it stored). It keeps readings in memory only.

## Secrets

- `firmware/esp32/include/config.h` (Wi-Fi password, API URL, token) is gitignored. Only `config.example.h` with placeholders is committed.
- `firmware/esp32/MzansiFarmSensors/secrets.h` (Wi-Fi SSID and password, API URL, device id, device token, climate numbers) is gitignored. Only `secrets.example.h` is committed. The sketch reads `WIFI_SSID` and `WIFI_PASSWORD` from that file.
- The sim reads the token from the `DEVICE_TOKEN` env var.
