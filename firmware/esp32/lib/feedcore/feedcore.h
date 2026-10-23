// feedcore: hardware-free payload builder + HTTP response policy.
// No Arduino/ESP32 includes here, so it compiles under PlatformIO `native`.
#ifndef FEEDCORE_H
#define FEEDCORE_H

#include <stddef.h>
#include <stdint.h>

// ============================================================================
// API CONTRACT  (single place to edit on the firmware side; sim twin: sim/payload.js)
// POST {API_BASE_URL}FEED_API_PATH
// Header   FEED_AUTH_HEADER: <DEVICE_TOKEN>
// Body     {"deviceId":"esp32-01","plotId":1,"timestamp":"2026-10-24T08:00:00Z",
//           "soilMoisturePct":0-100,"temperatureC":n,"humidityPct":0-100}
// Replies  201 {id} | 400 {error,field} | 401 | 409 duplicate (deviceId+timestamp)
// ============================================================================
#define FEED_API_PATH        "/api/v1/readings"
#define FEED_AUTH_HEADER     "X-Device-Token"
#define FEED_KEY_DEVICE_ID   "deviceId"
#define FEED_KEY_PLOT_ID     "plotId"
#define FEED_KEY_TIMESTAMP   "timestamp"
#define FEED_KEY_SOIL        "soilMoisturePct"
#define FEED_KEY_TEMP        "temperatureC"
#define FEED_KEY_HUMIDITY    "humidityPct"
// ============================================================================

// Plausibility limits for the DHT22 (datasheet: -40..80 C).
#define FEED_TEMP_MIN_C (-40.0f)
#define FEED_TEMP_MAX_C (80.0f)

// Smallest buffer that always fits a payload (deviceId up to 32 chars).
#define FEED_PAYLOAD_BUF_SIZE 256

typedef struct {
  const char *deviceId;
  int plotId;           // INTEGER per contract
  int64_t epochSeconds; // UTC seconds since 1970
  float soilMoisturePct;
  float temperatureC;
  float humidityPct;
} FeedReading;

typedef enum {
  FEED_OK = 0,
  FEED_ERR_NAN_SOIL,
  FEED_ERR_NAN_TEMP,
  FEED_ERR_NAN_HUMIDITY,
  FEED_ERR_TEMP_RANGE,
  FEED_ERR_BAD_TIME,
  FEED_ERR_BAD_ARGS,
  FEED_ERR_BUFFER
} FeedStatus;

const char *feedStatusName(FeedStatus s);

// Round half away from zero to `decimals` places (0..3). NaN stays NaN.
float feedRound(float v, int decimals);
// Clamp to 0..100. NaN stays NaN.
float feedClampPct(float v);
// Map a raw ADC value to 0..100 % (dryRaw = air/dry, wetRaw = in water). NaN-safe.
float feedSoilRawToPct(int raw, int dryRaw, int wetRaw);

// "YYYY-MM-DDTHH:MM:SSZ" (UTC, no milliseconds). `out` needs >= 21 bytes.
// Returns false for epoch < 0 or a too-small buffer.
bool feedFormatIso8601Utc(int64_t epochSeconds, char *out, size_t outLen);

// Validate, clamp (percentages), round (1 dp) and serialise to JSON.
// NaN readings and implausible temperatures are rejected (nothing is sent).
FeedStatus feedBuildPayload(const FeedReading *r, char *out, size_t outLen);

typedef enum {
  FEED_ACT_SUCCESS,       // 2xx: stored
  FEED_ACT_SKIP_DUPLICATE,// 409: already stored -> treat as success
  FEED_ACT_DROP_BAD,      // 400 (and other 4xx except 401/409): do not retry
  FEED_ACT_DROP_AUTH,     // 401: do not retry, token is wrong
  FEED_ACT_RETRY          // <=0 (network error), 5xx, 408/429, anything else
} FeedAction;

// code <= 0 means a transport/network error (HTTPClient negative codes).
FeedAction feedClassifyHttp(int httpCode);
bool feedShouldRetry(FeedAction a);

// Extract the string value of "field" from an error body such as
// {"error":"out of range","field":"soilMoisturePct"}. Returns false if absent.
bool feedExtractErrorField(const char *body, char *out, size_t outLen);

// Exponential backoff with cap: base * 2^attempt (attempt 0-based), <= maxMs.
uint32_t feedBackoffMs(unsigned attempt, uint32_t baseMs, uint32_t maxMs);

#endif
