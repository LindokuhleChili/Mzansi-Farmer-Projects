# ESP32

Two ESP32 uses live in this project. They do not share a network path.

| Use | Where | What talks to it |
|---|---|---|
| Live field dashboard | The board's own Wi-Fi hotspot `WaterLevel-ESP32`, page at `ESP32_DASHBOARD_URL` (default `http://192.168.4.1`) | The farmer's **browser** only. The Node API never connects to it. |
| Sensor feed | `firmware/esp32` and `sim/` posting to `/api/v1/readings` | The board (or the simulator) calls the API. That feed is unchanged by the dashboard page. |

The live dashboard sketch is not in this repository. Do not replace `firmware/esp32` with it. Water level is GPIO34 and soil moisture is GPIO35 on that sketch. The feed firmware uses a different sensor layout (soil on GPIO34, DHT22 on GPIO4) and posts readings to the API.

## Live field dashboard (browser only)

The board starts its own access point and serves a page:

| Item | Value |
|---|---|
| Wi-Fi name | `WaterLevel-ESP32` |
| Default address | `http://192.168.4.1` |
| Page | `GET /` (HTML). The page polls itself. |
| JSON | `GET /data` returns `wRaw`, `wPct`, `sRaw`, `sPct`, plus calibration fields `wE`, `wF`, `wEs`, `wFs`, `sD`, `sW`, `sDs`, `sWs`. `wPct` and `sPct` are `-1` until both calibration points for that sensor are saved. |
| Calibration | `GET /calibrate?mode=` one of `wempty`, `wfull`, `sdry`, `swet` |
| Pins | Water-level signal GPIO34. Soil-moisture AO GPIO35. Both use 3V3 and GND. |

The app shows this on **`/#/sensors`** (Live field sensors), linked from the dashboard, the sidebar, and Settings.

### Config key

| | |
|---|---|
| Environment variable | `ESP32_DASHBOARD_URL` |
| Default, if unset or blank | `http://192.168.4.1` |
| Invalid value (not http/https, or a username/password in the URL) | The API refuses to start |
| How the page learns it | `GET /ui/session` field `esp32DashboardUrl` (also when `mode` is `token`, because the live site is not on the device) |
| Per-browser override | `localStorage` key `mf.esp32Url`, edited on the Live sensors page. **Use server default** deletes it. |

The address is not a secret. It is not an app token, a device token, or the AI key. Do not put a password in the URL.

### Why the server does not proxy

The live app is served from the cloud (port 80). `192.168.4.1` exists only on the hotspot. The server cannot open it, so there is no server-side fetch, rewrite, or proxy to the device. A browser that has joined `WaterLevel-ESP32` is the only client that can load the page. Joining that hotspot can drop the route back to this website unless mobile data or Ethernet stays up.

The device sends **no CORS headers**. A page on another origin cannot read `GET /data` or `GET /calibrate`. The Live sensors page therefore:

* embeds `GET /` in an iframe (the device page itself polls `/data`)
* offers **Open dashboard** (a normal link; top-level navigation)
* checks reachability with a browser `fetch` in `no-cors` mode

That check does not read a body. An opaque response means the browser reached the device. A failure shows a clear offline state (join the hotspot, or allow local-network access if the browser blocks a public site from opening a private address). **Show the embed anyway** is there when the check is blocked but the iframe might still load.

Content-Security-Policy keeps `script-src 'self'`. `frame-src` and `connect-src` also allow `http:` and `https:`, because the saved address is chosen in the browser and is not one fixed host. The app and the device are both plain HTTP, so the iframe is not mixed content.

The iframe is sandboxed with `allow-scripts`, `allow-same-origin`, and `allow-modals` so the device page can update and calibrate. It is not allowed to navigate this app.

These readings are **not** stored in OpenEdge and do **not** drive irrigation suggestions. That still requires the sensor feed below.

### Deploy on the Windows server (port 80)

This change is Node and static files only. It does not change the OpenEdge schema, ABL, or the database. **Do not stop the database** (port 20000) or PASOE.

From the repository root in PowerShell:

```powershell
git pull
npm install
```

There is no build step.

Add this line to `.env` on the server (do not commit `.env`). If the line is missing, the API still uses `http://192.168.4.1`.

```
ESP32_DASHBOARD_URL=http://192.168.4.1
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

The sketch sets the hotspot address to `192.168.4.1`. If that address changes, two places can still point at the old one:

1. A browser that saved an address (`mf.esp32Url`) keeps it until someone types the new address on Live sensors and presses **Save address**, or presses **Use server default**.
2. Browsers with no saved address use `ESP32_DASHBOARD_URL`. Change that line in `.env` and restart Node. A restart does not clear a saved browser address.

Nothing in the database, the device token, or `POST /api/v1/readings` uses this address. Changing it does not move plots or suggestions.

## Sensor feed (firmware + simulator)

The ESP32 feed of **Mzansi Farmer Ops**. It has three parts:

| Part | Path | What it does |
|---|---|---|
| Firmware | `firmware/esp32` | PlatformIO/Arduino. Reads soil moisture, temperature and humidity every 30 s and POSTs JSON over Wi-Fi to the API. |
| Simulator | `sim/esp32-sim.js` | Pretends to be the ESP32 (`normal`, `drought`, `stale`, `invalid`) for demos and QA. |
| Mock API | `sim/mock-server.js` | Tiny standalone server that implements only the device contract (201/400/401/409). Not needed when you run the real Node API (`npm start`); use it to test the feed alone. |

Both sides use the same API contract (`docs/API.md`, section on `POST /api/v1/readings`). **Only local: nothing here pushes, publishes or phones home.**

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
- The sim reads the token from the `DEVICE_TOKEN` env var.
