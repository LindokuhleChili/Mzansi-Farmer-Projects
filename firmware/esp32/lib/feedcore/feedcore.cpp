#include "feedcore.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

const char *feedStatusName(FeedStatus s) {
  switch (s) {
    case FEED_OK: return "ok";
    case FEED_ERR_NAN_SOIL: return "soil moisture is NaN";
    case FEED_ERR_NAN_TEMP: return "temperature is NaN";
    case FEED_ERR_NAN_HUMIDITY: return "humidity is NaN";
    case FEED_ERR_TEMP_RANGE: return "temperature out of plausible range";
    case FEED_ERR_BAD_TIME: return "clock not set";
    case FEED_ERR_BAD_ARGS: return "bad arguments";
    case FEED_ERR_BUFFER: return "buffer too small";
  }
  return "unknown";
}

float feedRound(float v, int decimals) {
  if (isnan(v) || isinf(v)) return v;
  if (decimals < 0) decimals = 0;
  if (decimals > 3) decimals = 3;
  double scale = 1.0;
  for (int i = 0; i < decimals; i++) scale *= 10.0;
  double x = (double)v * scale;
  x = (x >= 0.0) ? floor(x + 0.5) : -floor(-x + 0.5);
  return (float)(x / scale);
}

float feedClampPct(float v) {
  if (isnan(v)) return v;
  if (v < 0.0f) return 0.0f;
  if (v > 100.0f) return 100.0f;
  return v;
}

float feedSoilRawToPct(int raw, int dryRaw, int wetRaw) {
  if (dryRaw == wetRaw) return NAN;
  double pct = ((double)(dryRaw - raw) * 100.0) / (double)(dryRaw - wetRaw);
  return feedClampPct((float)pct);
}

bool feedFormatIso8601Utc(int64_t epochSeconds, char *out, size_t outLen) {
  if (!out || outLen < 21 || epochSeconds < 0) return false;
  int64_t days = epochSeconds / 86400;
  int64_t rem = epochSeconds % 86400;
  int hh = (int)(rem / 3600);
  int mm = (int)((rem % 3600) / 60);
  int ss = (int)(rem % 60);
  // civil-from-days (Howard Hinnant), proleptic Gregorian
  int64_t z = days + 719468;
  int64_t era = z / 146097;
  int64_t doe = z - era * 146097;
  int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int64_t y = yoe + era * 400;
  int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  int64_t mp = (5 * doy + 2) / 153;
  int d = (int)(doy - (153 * mp + 2) / 5 + 1);
  int m = (int)(mp < 10 ? mp + 3 : mp - 9);
  if (m <= 2) y += 1;
  snprintf(out, outLen, "%04d-%02d-%02dT%02d:%02d:%02dZ", (int)y, m, d, hh, mm, ss);
  return true;
}

// Print a float with exactly one decimal, avoiding "-0.0".
static void fmt1(char *dst, size_t n, float v) {
  float r = feedRound(v, 1);
  if (r == 0.0f) r = 0.0f; // -0.0 == 0.0, so this normalises the sign
  snprintf(dst, n, "%.1f", (double)r);
}

FeedStatus feedBuildPayload(const FeedReading *r, char *out, size_t outLen) {
  if (!r || !out || outLen == 0 || !r->deviceId || r->deviceId[0] == '\0') return FEED_ERR_BAD_ARGS;
  if (strlen(r->deviceId) > 32) return FEED_ERR_BAD_ARGS;
  for (const char *p = r->deviceId; *p; p++) {
    if (*p == '"' || *p == '\\' || (unsigned char)*p < 0x20) return FEED_ERR_BAD_ARGS;
  }
  if (isnan(r->soilMoisturePct)) return FEED_ERR_NAN_SOIL;
  if (isnan(r->temperatureC)) return FEED_ERR_NAN_TEMP;
  if (isnan(r->humidityPct)) return FEED_ERR_NAN_HUMIDITY;
  if (isinf(r->temperatureC) || r->temperatureC < FEED_TEMP_MIN_C || r->temperatureC > FEED_TEMP_MAX_C)
    return FEED_ERR_TEMP_RANGE;
  if (isinf(r->soilMoisturePct)) return FEED_ERR_NAN_SOIL;
  if (isinf(r->humidityPct)) return FEED_ERR_NAN_HUMIDITY;

  char ts[24];
  if (!feedFormatIso8601Utc(r->epochSeconds, ts, sizeof ts)) return FEED_ERR_BAD_TIME;

  char soil[16], temp[16], hum[16];
  fmt1(soil, sizeof soil, feedClampPct(r->soilMoisturePct));
  fmt1(temp, sizeof temp, r->temperatureC);
  fmt1(hum, sizeof hum, feedClampPct(r->humidityPct));

  int n = snprintf(out, outLen,
                   "{\"" FEED_KEY_DEVICE_ID "\":\"%s\",\"" FEED_KEY_PLOT_ID "\":%d,"
                   "\"" FEED_KEY_TIMESTAMP "\":\"%s\",\"" FEED_KEY_SOIL "\":%s,"
                   "\"" FEED_KEY_TEMP "\":%s,\"" FEED_KEY_HUMIDITY "\":%s}",
                   r->deviceId, r->plotId, ts, soil, temp, hum);
  if (n < 0 || (size_t)n >= outLen) return FEED_ERR_BUFFER;
  return FEED_OK;
}

FeedAction feedClassifyHttp(int c) {
  if (c >= 200 && c < 300) return FEED_ACT_SUCCESS;
  if (c == 409) return FEED_ACT_SKIP_DUPLICATE;
  if (c == 401) return FEED_ACT_DROP_AUTH;
  if (c == 408 || c == 429) return FEED_ACT_RETRY;
  if (c >= 400 && c < 500) return FEED_ACT_DROP_BAD;
  return FEED_ACT_RETRY; // <=0 network error, 5xx, unexpected 1xx/3xx
}

bool feedShouldRetry(FeedAction a) { return a == FEED_ACT_RETRY; }

bool feedExtractErrorField(const char *body, char *out, size_t outLen) {
  if (!body || !out || outLen == 0) return false;
  const char *k = strstr(body, "\"field\"");
  if (!k) return false;
  k += 7;
  while (*k == ' ' || *k == ':') k++;
  if (*k != '"') return false;
  k++;
  size_t i = 0;
  while (*k && *k != '"' && i + 1 < outLen) out[i++] = *k++;
  if (*k != '"') return false;
  out[i] = '\0';
  return true;
}

uint32_t feedBackoffMs(unsigned attempt, uint32_t baseMs, uint32_t maxMs) {
  uint64_t v = baseMs;
  for (unsigned i = 0; i < attempt && v < maxMs; i++) v *= 2;
  return v > maxMs ? maxMs : (uint32_t)v;
}
