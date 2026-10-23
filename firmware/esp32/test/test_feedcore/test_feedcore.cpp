#include <math.h>
#include <string.h>
#include <unity.h>

#include "feedcore.h"

void setUp(void) {}
void tearDown(void) {}

static FeedReading sample() {
  FeedReading r;
  r.deviceId = "esp32-01";
  r.plotId = 1;
  r.epochSeconds = 1792828800; // 2026-10-24T08:00:00Z
  r.soilMoisturePct = 42.34f;
  r.temperatureC = 23.46f;
  r.humidityPct = 61.04f;
  return r;
}

void test_iso8601_known_values(void) {
  char b[32];
  TEST_ASSERT_TRUE(feedFormatIso8601Utc(0, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING("1970-01-01T00:00:00Z", b);
  TEST_ASSERT_TRUE(feedFormatIso8601Utc(1792828800, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING("2026-10-24T08:00:00Z", b);
  TEST_ASSERT_TRUE(feedFormatIso8601Utc(951782400, b, sizeof b)); // leap day 2000-02-29
  TEST_ASSERT_EQUAL_STRING("2000-02-29T00:00:00Z", b);
  TEST_ASSERT_TRUE(feedFormatIso8601Utc(1709251199, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING("2024-02-29T23:59:59Z", b);
}

void test_iso8601_rejects_bad_input(void) {
  char b[32];
  TEST_ASSERT_FALSE(feedFormatIso8601Utc(-1, b, sizeof b));
  TEST_ASSERT_FALSE(feedFormatIso8601Utc(0, b, 10));
  TEST_ASSERT_FALSE(feedFormatIso8601Utc(0, NULL, 32));
}

void test_payload_exact_json_and_field_names(void) {
  FeedReading r = sample();
  char b[FEED_PAYLOAD_BUF_SIZE];
  TEST_ASSERT_EQUAL(FEED_OK, feedBuildPayload(&r, b, sizeof b));
  TEST_ASSERT_EQUAL_STRING(
      "{\"deviceId\":\"esp32-01\",\"plotId\":1,\"timestamp\":\"2026-10-24T08:00:00Z\","
      "\"soilMoisturePct\":42.3,\"temperatureC\":23.5,\"humidityPct\":61.0}",
      b);
}

void test_payload_plotid_is_integer_not_string(void) {
  FeedReading r = sample();
  r.plotId = 7;
  char b[FEED_PAYLOAD_BUF_SIZE];
  TEST_ASSERT_EQUAL(FEED_OK, feedBuildPayload(&r, b, sizeof b));
  TEST_ASSERT_NOT_NULL(strstr(b, "\"plotId\":7,"));
}

void test_payload_timestamp_has_z_and_no_millis(void) {
  FeedReading r = sample();
  char b[FEED_PAYLOAD_BUF_SIZE];
  feedBuildPayload(&r, b, sizeof b);
  TEST_ASSERT_NOT_NULL(strstr(b, "\"timestamp\":\"2026-10-24T08:00:00Z\""));
  TEST_ASSERT_NULL(strstr(b, ".000Z"));
}

void test_payload_clamps_percentages(void) {
  FeedReading r = sample();
  r.soilMoisturePct = 101.7f;
  r.humidityPct = -3.0f;
  char b[FEED_PAYLOAD_BUF_SIZE];
  TEST_ASSERT_EQUAL(FEED_OK, feedBuildPayload(&r, b, sizeof b));
  TEST_ASSERT_NOT_NULL(strstr(b, "\"soilMoisturePct\":100.0"));
  TEST_ASSERT_NOT_NULL(strstr(b, "\"humidityPct\":0.0"));
}

void test_payload_negative_zero_is_printed_as_zero(void) {
  FeedReading r = sample();
  r.temperatureC = -0.04f;
  char b[FEED_PAYLOAD_BUF_SIZE];
  TEST_ASSERT_EQUAL(FEED_OK, feedBuildPayload(&r, b, sizeof b));
  TEST_ASSERT_NOT_NULL(strstr(b, "\"temperatureC\":0.0"));
  TEST_ASSERT_NULL(strstr(b, "-0.0"));
}

void test_payload_nan_rejected(void) {
  char b[FEED_PAYLOAD_BUF_SIZE];
  FeedReading r = sample();
  r.soilMoisturePct = NAN;
  TEST_ASSERT_EQUAL(FEED_ERR_NAN_SOIL, feedBuildPayload(&r, b, sizeof b));
  r = sample(); r.temperatureC = NAN;
  TEST_ASSERT_EQUAL(FEED_ERR_NAN_TEMP, feedBuildPayload(&r, b, sizeof b));
  r = sample(); r.humidityPct = NAN;
  TEST_ASSERT_EQUAL(FEED_ERR_NAN_HUMIDITY, feedBuildPayload(&r, b, sizeof b));
}

void test_payload_temperature_range_and_inf(void) {
  char b[FEED_PAYLOAD_BUF_SIZE];
  FeedReading r = sample();
  r.temperatureC = 120.0f;
  TEST_ASSERT_EQUAL(FEED_ERR_TEMP_RANGE, feedBuildPayload(&r, b, sizeof b));
  r.temperatureC = -50.0f;
  TEST_ASSERT_EQUAL(FEED_ERR_TEMP_RANGE, feedBuildPayload(&r, b, sizeof b));
  r.temperatureC = INFINITY;
  TEST_ASSERT_EQUAL(FEED_ERR_TEMP_RANGE, feedBuildPayload(&r, b, sizeof b));
}

void test_payload_bad_args_time_buffer(void) {
  char b[FEED_PAYLOAD_BUF_SIZE];
  FeedReading r = sample();
  r.epochSeconds = -1;
  TEST_ASSERT_EQUAL(FEED_ERR_BAD_TIME, feedBuildPayload(&r, b, sizeof b));
  r = sample(); r.deviceId = "";
  TEST_ASSERT_EQUAL(FEED_ERR_BAD_ARGS, feedBuildPayload(&r, b, sizeof b));
  r = sample(); r.deviceId = "bad\"id";
  TEST_ASSERT_EQUAL(FEED_ERR_BAD_ARGS, feedBuildPayload(&r, b, sizeof b));
  r = sample();
  TEST_ASSERT_EQUAL(FEED_ERR_BUFFER, feedBuildPayload(&r, b, 20));
  TEST_ASSERT_EQUAL(FEED_ERR_BAD_ARGS, feedBuildPayload(NULL, b, sizeof b));
}

void test_round_half_away_from_zero(void) {
  TEST_ASSERT_EQUAL_FLOAT(2.5f, feedRound(2.46f, 1));
  TEST_ASSERT_EQUAL_FLOAT(-2.5f, feedRound(-2.46f, 1));
  TEST_ASSERT_EQUAL_FLOAT(3.0f, feedRound(2.5f, 0));
  TEST_ASSERT_TRUE(isnan(feedRound(NAN, 1)));
}

void test_soil_raw_to_pct(void) {
  TEST_ASSERT_EQUAL_FLOAT(0.0f, feedSoilRawToPct(3200, 3200, 1300));
  TEST_ASSERT_EQUAL_FLOAT(100.0f, feedSoilRawToPct(1300, 3200, 1300));
  TEST_ASSERT_EQUAL_FLOAT(50.0f, feedSoilRawToPct(2250, 3200, 1300));
  TEST_ASSERT_EQUAL_FLOAT(0.0f, feedSoilRawToPct(4095, 3200, 1300));   // drier than dry: clamp
  TEST_ASSERT_EQUAL_FLOAT(100.0f, feedSoilRawToPct(0, 3200, 1300));    // wetter than wet: clamp
  TEST_ASSERT_TRUE(isnan(feedSoilRawToPct(100, 2000, 2000)));          // bad calibration
}

void test_http_classification(void) {
  TEST_ASSERT_EQUAL(FEED_ACT_SUCCESS, feedClassifyHttp(201));
  TEST_ASSERT_EQUAL(FEED_ACT_SKIP_DUPLICATE, feedClassifyHttp(409));
  TEST_ASSERT_EQUAL(FEED_ACT_DROP_BAD, feedClassifyHttp(400));
  TEST_ASSERT_EQUAL(FEED_ACT_DROP_AUTH, feedClassifyHttp(401));
  TEST_ASSERT_EQUAL(FEED_ACT_RETRY, feedClassifyHttp(500));
  TEST_ASSERT_EQUAL(FEED_ACT_RETRY, feedClassifyHttp(503));
  TEST_ASSERT_EQUAL(FEED_ACT_RETRY, feedClassifyHttp(-1));   // connection refused
  TEST_ASSERT_EQUAL(FEED_ACT_RETRY, feedClassifyHttp(0));
  TEST_ASSERT_TRUE(feedShouldRetry(FEED_ACT_RETRY));
  TEST_ASSERT_FALSE(feedShouldRetry(FEED_ACT_DROP_BAD));
  TEST_ASSERT_FALSE(feedShouldRetry(FEED_ACT_DROP_AUTH));
  TEST_ASSERT_FALSE(feedShouldRetry(FEED_ACT_SKIP_DUPLICATE));
  TEST_ASSERT_FALSE(feedShouldRetry(FEED_ACT_SUCCESS));
}

void test_extract_error_field(void) {
  char f[32];
  TEST_ASSERT_TRUE(feedExtractErrorField("{\"error\":\"out of range\",\"field\":\"soilMoisturePct\"}", f, sizeof f));
  TEST_ASSERT_EQUAL_STRING("soilMoisturePct", f);
  TEST_ASSERT_TRUE(feedExtractErrorField("{\"field\" : \"plotId\"}", f, sizeof f));
  TEST_ASSERT_EQUAL_STRING("plotId", f);
  TEST_ASSERT_FALSE(feedExtractErrorField("{\"error\":\"x\"}", f, sizeof f));
  TEST_ASSERT_FALSE(feedExtractErrorField("", f, sizeof f));
}

void test_backoff(void) {
  TEST_ASSERT_EQUAL_UINT32(1000, feedBackoffMs(0, 1000, 30000));
  TEST_ASSERT_EQUAL_UINT32(2000, feedBackoffMs(1, 1000, 30000));
  TEST_ASSERT_EQUAL_UINT32(8000, feedBackoffMs(3, 1000, 30000));
  TEST_ASSERT_EQUAL_UINT32(30000, feedBackoffMs(10, 1000, 30000));
  TEST_ASSERT_EQUAL_UINT32(30000, feedBackoffMs(1000, 1000, 30000));
}

int main(int argc, char **argv) {
  (void)argc; (void)argv;
  UNITY_BEGIN();
  RUN_TEST(test_iso8601_known_values);
  RUN_TEST(test_iso8601_rejects_bad_input);
  RUN_TEST(test_payload_exact_json_and_field_names);
  RUN_TEST(test_payload_plotid_is_integer_not_string);
  RUN_TEST(test_payload_timestamp_has_z_and_no_millis);
  RUN_TEST(test_payload_clamps_percentages);
  RUN_TEST(test_payload_negative_zero_is_printed_as_zero);
  RUN_TEST(test_payload_nan_rejected);
  RUN_TEST(test_payload_temperature_range_and_inf);
  RUN_TEST(test_payload_bad_args_time_buffer);
  RUN_TEST(test_round_half_away_from_zero);
  RUN_TEST(test_soil_raw_to_pct);
  RUN_TEST(test_http_classification);
  RUN_TEST(test_extract_error_field);
  RUN_TEST(test_backoff);
  return UNITY_END();
}
