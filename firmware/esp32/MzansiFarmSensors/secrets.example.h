#pragma once
// Copy this file to secrets.h in the same folder. secrets.h is gitignored.
// Never commit a real Wi-Fi password, device token, or private URL.
//
// DEVICE_REGISTRY in the server .env is a JSON array. This board's entry must
// match DEVICE_ID and PLOT_ID below, and DEVICE_TOKEN must be that entry's token
// (the X-Device-Token value). It is not APP_TOKEN.
//   [{"deviceId":"esp32-01","plotId":1,"token":"replace-with-random-device-token"}]
// Generate a token and put it only in .env and in secrets.h:
//   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
//   PowerShell: -join ((1..32 | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) }))

#define WIFI_SSID "PASTE_WIFI_NAME_HERE"             // phone hotspot, 2.4 GHz only
#define WIFI_PASSWORD "PASTE_WIFI_PASSWORD_HERE"
#define API_BASE_URL "http://13.43.92.196"           // no trailing slash. Plain HTTP.
#define DEVICE_TOKEN "PASTE_DEVICE_TOKEN_HERE"
#define DEVICE_ID "esp32-01"
#define PLOT_ID 1

// POST /api/v1/readings also requires temperatureC (-20..60) and humidityPct (0..100).
// GPIO34 / GPIO35 are the water and soil probes. They do not measure air climate.
// Write a real thermometer reading below, then set CLIMATE_VALUES_ARE_REAL to 1.
// While it stays 0 the local dashboard still works and nothing is uploaded, so
// these placeholder numbers are never stored as a sensor reading.
#define CLIMATE_VALUES_ARE_REAL 0
#define CLIMATE_TEMPERATURE_C 22.0
#define CLIMATE_HUMIDITY_PCT 55.0
