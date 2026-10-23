// Mzansi Farmer AI - ESP32 sensor feed.
// Reads soil moisture (analog) + DHT22 temp/humidity every READ_INTERVAL_S and POSTs JSON.
#include <Arduino.h>
#include <DHT.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <time.h>

#include "config.h"
#include "feedcore.h"

static DHT dht(PIN_DHT, DHT_TYPE);
static int64_t lastSentEpoch = -1;

static bool wifiEnsure() {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT_MS) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  Serial.println("[wifi] connect failed");
  return false;
}

// Returns epoch seconds, or -1 if NTP has not synced yet.
static int64_t nowEpoch() {
  time_t t = time(nullptr);
  return t < 1700000000 ? -1 : (int64_t)t; // before Nov 2023 => not synced
}

static float readSoilPct() {
  // Average a few samples to smooth ADC noise.
  long sum = 0;
  for (int i = 0; i < 8; i++) { sum += analogRead(PIN_SOIL_ANALOG); delay(5); }
  return feedSoilRawToPct((int)(sum / 8), SOIL_RAW_DRY, SOIL_RAW_WET);
}

static float readWithRetry(float (*fn)()) {
  float v = fn();
  for (int i = 0; i < 2 && isnan(v); i++) { delay(2100); v = fn(); } // DHT22 needs >=2 s between reads
  return v;
}
static float readTemp() { return dht.readTemperature(); }
static float readHum() { return dht.readHumidity(); }

// Returns true if the reading is finished with (stored, duplicate, or permanently rejected).
static bool sendPayload(const char *json) {
  String url = String(API_BASE_URL) + FEED_API_PATH;
  for (unsigned attempt = 0; attempt < SEND_MAX_ATTEMPTS; attempt++) {
    int code = -1;
    String body;
    if (wifiEnsure()) {
      HTTPClient http;
      http.setTimeout(HTTP_TIMEOUT_MS);
      if (http.begin(url)) {
        http.addHeader("Content-Type", "application/json");
        http.addHeader(FEED_AUTH_HEADER, DEVICE_TOKEN);
        code = http.POST((uint8_t *)json, strlen(json));
        if (code > 0) body = http.getString();
        http.end();
      }
    }
    FeedAction act = feedClassifyHttp(code);
    switch (act) {
      case FEED_ACT_SUCCESS: Serial.printf("[send] %d stored %s\n", code, body.c_str()); return true;
      case FEED_ACT_SKIP_DUPLICATE: Serial.println("[send] 409 duplicate, treated as success"); return true;
      case FEED_ACT_DROP_AUTH: Serial.println("[send] 401 unauthorized: check DEVICE_TOKEN; not retrying"); return true;
      case FEED_ACT_DROP_BAD: {
        char field[48] = "?";
        feedExtractErrorField(body.c_str(), field, sizeof field);
        Serial.printf("[send] %d rejected (field=%s) body=%s; not retrying\n", code, field, body.c_str());
        return true;
      }
      case FEED_ACT_RETRY: break;
    }
    uint32_t wait = feedBackoffMs(attempt, BACKOFF_BASE_MS, BACKOFF_MAX_MS);
    Serial.printf("[send] code=%d, retry %u/%d in %lu ms\n", code, attempt + 1, SEND_MAX_ATTEMPTS, (unsigned long)wait);
    delay(wait);
  }
  Serial.println("[send] giving up on this reading");
  return false;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SOIL_ANALOG, ADC_11db);
  dht.begin();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  wifiEnsure();
  configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
}

void loop() {
  uint32_t started = millis();

  int64_t epoch = nowEpoch();
  if (epoch < 0) {
    Serial.println("[time] waiting for NTP");
  } else if (epoch <= lastSentEpoch) {
    Serial.println("[time] same second as last reading, skipping");
  } else {
    FeedReading r;
    r.deviceId = DEVICE_ID;
    r.plotId = PLOT_ID;
    r.epochSeconds = epoch;
    r.soilMoisturePct = readSoilPct();
    r.temperatureC = readWithRetry(readTemp);
    r.humidityPct = readWithRetry(readHum);

    char json[FEED_PAYLOAD_BUF_SIZE];
    FeedStatus st = feedBuildPayload(&r, json, sizeof json);
    if (st != FEED_OK) {
      Serial.printf("[sensor] reading skipped: %s\n", feedStatusName(st));
    } else {
      Serial.printf("[send] %s\n", json);
      lastSentEpoch = epoch;
      sendPayload(json);
    }
  }

  uint32_t elapsed = millis() - started;
  uint32_t period = (uint32_t)READ_INTERVAL_S * 1000UL;
  if (elapsed < period) delay(period - elapsed);
}
