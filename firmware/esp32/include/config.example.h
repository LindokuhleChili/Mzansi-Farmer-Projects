// Copy this file to include/config.h (which is gitignored) and fill in real values.
// NEVER commit include/config.h.
#ifndef CONFIG_H
#define CONFIG_H

// --- Wi-Fi (2.4 GHz only; the ESP32 does not support 5 GHz) ---
#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// --- API ---
// Laptop LAN IP running the Mzansi API (find it with `ipconfig` on Windows). No trailing slash.
// The path (/api/v1/readings) and header name live in lib/feedcore/feedcore.h.
#define API_BASE_URL  "http://192.168.0.100:3000"
#define DEVICE_TOKEN  "REPLACE_WITH_DEVICE_TOKEN"

// --- Identity ---
#define DEVICE_ID     "esp32-01"
#define PLOT_ID       1            // integer plot id

// --- Pins (change to match your wiring) ---
#define PIN_SOIL_ANALOG 34         // ADC1 pin (input-only). Avoid ADC2 pins: unusable while Wi-Fi is on
#define PIN_DHT         4
#define DHT_TYPE        DHT22

// --- Soil calibration: raw 12-bit ADC (0..4095) in dry air and in a glass of water ---
#define SOIL_RAW_DRY  3200
#define SOIL_RAW_WET  1300

// --- Timing ---
#define READ_INTERVAL_S      30
#define HTTP_TIMEOUT_MS      8000
#define SEND_MAX_ATTEMPTS    5       // per reading, then the reading is dropped
#define BACKOFF_BASE_MS      1000
#define BACKOFF_MAX_MS       30000
#define WIFI_CONNECT_TIMEOUT_MS 15000

// --- Time (needed for the ISO-8601 UTC timestamp) ---
#define NTP_SERVER_1 "pool.ntp.org"
#define NTP_SERVER_2 "time.google.com"

#endif
