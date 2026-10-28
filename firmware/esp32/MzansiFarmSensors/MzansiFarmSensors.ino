// Mzansi Farmer - ESP32 soil + water probes.
// Board: ESP32 Dev Module. Arduino-ESP32 core 3.x. Libraries: built-in only.
//
// Local backup dashboard (always, even with no internet):
//   join Wi-Fi "WaterLevel-ESP32" / "Water1234", open http://192.168.4.1
//   water signal GPIO34, soil AO GPIO35, calibration saved in Preferences.
//
// Cloud: WIFI_AP_STA also joins the phone hotspot from secrets.h and, about
// every 10 s, POSTs with header X-Device-Token:
//   {API_BASE_URL}/api/v1/readings
//     deviceId, plotId, timestamp, soilMoisturePct, temperatureC, humidityPct, raining
//   {API_BASE_URL}/api/v1/tank-readings
//     deviceId, plotId, timestamp, waterLevelRaw, waterLevelPct, calibrated
// Tank storage is openedge/schema/010-tank.df. Loading it stops the database.
// See docs/ESP32.md. Do not run that load until the backup and stop steps there.
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <time.h>
#include <stdio.h>
#include <string.h>

#if defined(__has_include)
#  if __has_include("secrets.h")
#    include "secrets.h"
#  else
#    include "secrets.example.h"
#  endif
#else
#  include "secrets.h"
#endif

#ifndef WIFI_SSID
#error "secrets.h must define WIFI_SSID"
#endif
#ifndef DEVICE_TOKEN
#error "secrets.h must define DEVICE_TOKEN"
#endif
#ifndef DEVICE_ID
#error "secrets.h must define DEVICE_ID"
#endif
#ifndef API_BASE_URL
#error "secrets.h must define API_BASE_URL"
#endif

static const char *AP_SSID = "WaterLevel-ESP32";
static const char *AP_PASSWORD = "Water1234";
static const IPAddress LOCAL_IP(192, 168, 4, 1);
static const IPAddress GATEWAY(192, 168, 4, 1);
static const IPAddress SUBNET(255, 255, 255, 0);

static const int WATER_PIN = 34;
static const int SOIL_PIN = 35;
static const char *API_PATH = "/api/v1/readings";
static const char *TANK_PATH = "/api/v1/tank-readings";
static const uint32_t SEND_INTERVAL_MS = 10000;
static const uint32_t HTTP_TIMEOUT_MS = 8000;
static const uint32_t WIFI_RETRY_MS = 15000;

static WebServer server(80);
static Preferences prefs;

static int waterEmpty = 0, waterFull = 4095;
static bool waterEmptySet = false, waterFullSet = false;
static int soilDry = 0, soilWet = 4095;
static bool soilDrySet = false, soilWetSet = false;

static uint32_t nextSendAt = 8000;
static uint8_t failCount = 0;
static uint32_t lastWifiAttempt = 0;
static bool apiGaveUp = false;
static bool waitShort = false;
static String lastSendStatus = "not sent yet";
static int cachedWater = -1, cachedSoil = -1;

static int readAvg(int pin) {
  long total = 0;
  for (int i = 0; i < 10; i++) {
    total += analogRead(pin);
    delay(2);
  }
  return (int)(total / 10);
}

static int cachedRaw(int pin, int *slot) {
  if (*slot < 0) *slot = readAvg(pin);
  return *slot;
}

static void refreshCached() {
  cachedWater = readAvg(WATER_PIN);
  cachedSoil = readAvg(SOIL_PIN);
}

// Works in both directions (some sensors read lower when wet).
static int toPct(int raw, int lo, int hi, bool loSet, bool hiSet) {
  if (!loSet || !hiSet || lo == hi) return -1;
  long p = ((long)raw - lo) * 100L / ((long)hi - lo);
  if (p < 0) p = 0;
  if (p > 100) p = 100;
  return (int)p;
}

static void loadCal() {
  prefs.begin("cal", true);
  waterEmpty = prefs.getInt("wE", 0);
  waterFull = prefs.getInt("wF", 4095);
  waterEmptySet = prefs.getBool("wEs", false);
  waterFullSet = prefs.getBool("wFs", false);
  soilDry = prefs.getInt("sD", 0);
  soilWet = prefs.getInt("sW", 4095);
  soilDrySet = prefs.getBool("sDs", false);
  soilWetSet = prefs.getBool("sWs", false);
  prefs.end();
}

static void saveCal() {
  prefs.begin("cal", false);
  prefs.putInt("wE", waterEmpty);
  prefs.putInt("wF", waterFull);
  prefs.putBool("wEs", waterEmptySet);
  prefs.putBool("wFs", waterFullSet);
  prefs.putInt("sD", soilDry);
  prefs.putInt("sW", soilWet);
  prefs.putBool("sDs", soilDrySet);
  prefs.putBool("sWs", soilWetSet);
  prefs.end();
}

static const char page[] PROGMEM = R"rawliteral(
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mzansi Farm Sensors</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:18px;font-family:Arial,sans-serif;background:#0b1120;color:#f1f5f9}
.wrap{max-width:760px;margin:auto}.eye{color:#4ade80;font-size:12px;font-weight:bold;letter-spacing:2px}
h1{margin:8px 0 4px;font-size:30px}.sub{color:#94a3b8;font-size:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px}
.card{background:#151e30;border:1px solid #26334a;border-radius:18px;padding:20px}
.t{color:#94a3b8;font-size:12px;letter-spacing:1px}.big{font-size:48px;font-weight:bold;margin:8px 0}
.u{font-size:20px;color:#38bdf8}.bar{height:14px;background:#26334a;border-radius:20px;overflow:hidden;margin:10px 0}
.fill{height:100%;width:0;transition:width .4s}.w{background:linear-gradient(90deg,#0ea5e9,#2dd4bf)}
.s{background:linear-gradient(90deg,#a16207,#4ade80)}.m{color:#94a3b8;font-size:13px;line-height:1.6}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
button{border:0;padding:12px;border-radius:10px;font-weight:bold;color:#fff;cursor:pointer}
.b1{background:#334155}.b2{background:#0891b2}.b3{background:#854d0e}.b4{background:#15803d}
.st{display:inline-block;margin:10px 8px 0 0;background:#102d38;color:#67e8f9;padding:7px 12px;border-radius:20px;font-size:13px}
@media(max-width:560px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<div class="eye">MZANSI FARMER · ESP32 LIVE</div><h1>Farm Sensors</h1>
<div class="sub">Water tank and soil on this page. Both are sent to the app about every 10 seconds.</div>
<div class="st" id="conn">Connecting...</div>
<div class="st" id="sta">Internet Wi-Fi: --</div>
<div class="st" id="cloud">Cloud: --</div>
<div class="grid">
 <div class="card"><div class="t">WATER LEVEL</div>
  <div><span class="big" id="wp">--</span><span class="u">%</span></div>
  <div class="bar"><div class="fill w" id="wb"></div></div>
  <div class="m" id="ws">Calibrate to see a percentage.</div>
  <div class="m">Raw: <b id="wr">--</b> · Empty: <b id="we">-</b> · Full: <b id="wf">-</b></div>
  <div class="row"><button class="b1" onclick="cal('wempty','sensor at EMPTY level')">Set EMPTY</button>
  <button class="b2" onclick="cal('wfull','sensor at FULL level')">Set FULL</button></div></div>
 <div class="card"><div class="t">SOIL MOISTURE</div>
  <div><span class="big" id="sp">--</span><span class="u">%</span></div>
  <div class="bar"><div class="fill s" id="sb"></div></div>
  <div class="m" id="ss">Calibrate to see a percentage.</div>
  <div class="m">Raw: <b id="sr">--</b> · Dry: <b id="sd">-</b> · Wet: <b id="sw">-</b></div>
  <div class="row"><button class="b3" onclick="cal('sdry','probe in DRY air or dry soil')">Set DRY</button>
  <button class="b4" onclick="cal('swet','probe in a cup of WATER or wet soil')">Set WET</button></div></div>
</div>
<div class="card" style="margin-top:14px"><div class="t">WIRING AND CLOUD</div><div class="m">
Water sensor: signal D34, + to 3V3, - to GND<br>
Soil sensor: AO to D35, VCC to 3V3, GND to GND<br>
Soil goes to /api/v1/readings. Water goes to /api/v1/tank-readings. Temperature and humidity in the soil post come from secrets.h (this board does not measure those).</div></div>
</div><script>
const $=i=>document.getElementById(i);
function show(p,big,bar,st,labels){
 if(p>=0){$(big).textContent=p;$(bar).style.width=p+'%';$(st).textContent=p<=20?labels[0]:p<70?labels[1]:labels[2];}
 else{$(big).textContent='--';$(bar).style.width='0%';$(st).textContent='Save both calibration points to see a percentage.';}
}
async function up(){try{const d=await(await fetch('/data?t='+Date.now(),{cache:'no-store'})).json();
 $('conn').textContent='● Sensors connected';
 $('sta').textContent=d.sta?('Internet Wi-Fi: '+d.staIp):'Internet Wi-Fi: offline';
 $('cloud').textContent='Cloud: '+d.cloud;
 $('wr').textContent=d.wRaw;$('we').textContent=d.wEs?d.wE:'-';$('wf').textContent=d.wFs?d.wF:'-';
 $('sr').textContent=d.sRaw;$('sd').textContent=d.sDs?d.sD:'-';$('sw').textContent=d.sWs?d.sW:'-';
 show(d.wPct,'wp','wb','ws',['Low water: refill the tank','Medium water level','Tank is full']);
 show(d.sPct,'sp','sb','ss',['Soil is dry: needs water','Soil moisture is good','Soil is wet: no watering needed']);
}catch(e){$('conn').textContent='Reconnecting...';}}
async function cal(m,txt){if(!confirm('Is the '+txt+' right now?'))return;
 try{const r=await(await fetch('/calibrate?mode='+m)).json();if(!r.ok)throw 0;up();}catch(e){alert('Calibration failed.');}}
up();setInterval(up,1000);
</script></body></html>
)rawliteral";

static String jsonEscape(const String &s) {
  String out;
  out.reserve(s.length() + 4);
  for (unsigned i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') out += '\\';
    if ((uint8_t)c >= 0x20) out += c;
  }
  return out;
}

static void handleData() {
  refreshCached();
  int wPct = toPct(cachedWater, waterEmpty, waterFull, waterEmptySet, waterFullSet);
  int sPct = toPct(cachedSoil, soilDry, soilWet, soilDrySet, soilWetSet);
  bool sta = WiFi.status() == WL_CONNECTED;
  String staIp = sta ? WiFi.localIP().toString() : String("");
  String j = "{\"wRaw\":" + String(cachedWater) + ",\"wPct\":" + String(wPct) +
             ",\"wE\":" + String(waterEmpty) + ",\"wF\":" + String(waterFull) +
             ",\"wEs\":" + (waterEmptySet ? "true" : "false") + ",\"wFs\":" + (waterFullSet ? "true" : "false") +
             ",\"sRaw\":" + String(cachedSoil) + ",\"sPct\":" + String(sPct) +
             ",\"sD\":" + String(soilDry) + ",\"sW\":" + String(soilWet) +
             ",\"sDs\":" + (soilDrySet ? "true" : "false") + ",\"sWs\":" + (soilWetSet ? "true" : "false") +
             ",\"sta\":" + (sta ? "true" : "false") + ",\"staIp\":\"" + jsonEscape(staIp) +
             "\",\"cloud\":\"" + jsonEscape(lastSendStatus) + "\"}";
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", j);
}

static void handleCal() {
  String mode = server.hasArg("mode") ? server.arg("mode") : "";
  if (mode == "wempty") { waterEmpty = readAvg(WATER_PIN); waterEmptySet = true; cachedWater = waterEmpty; }
  else if (mode == "wfull") { waterFull = readAvg(WATER_PIN); waterFullSet = true; cachedWater = waterFull; }
  else if (mode == "sdry") { soilDry = readAvg(SOIL_PIN); soilDrySet = true; cachedSoil = soilDry; }
  else if (mode == "swet") { soilWet = readAvg(SOIL_PIN); soilWetSet = true; cachedSoil = soilWet; }
  else { server.send(400, "application/json", "{\"ok\":false}"); return; }
  saveCal();
  Serial.println(String("Calibration saved: ") + mode);
  server.send(200, "application/json", "{\"ok\":true}");
}

static void ensureInternetWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if ((int32_t)(millis() - lastWifiAttempt) < (int32_t)WIFI_RETRY_MS) return;
  lastWifiAttempt = millis();
  Serial.printf("[wifi] connecting to %s ...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

static bool timestampNow(char *out, size_t n) {
  time_t t = time(nullptr);
  if (t < 1700000000) return false;
  struct tm g;
  gmtime_r(&t, &g);
  return strftime(out, n, "%Y-%m-%dT%H:%M:%SZ", &g) > 0;
}

static uint32_t backoffMs(uint8_t fails) {
  uint32_t shift = fails > 4 ? 4 : fails;
  uint32_t ms = SEND_INTERVAL_MS << shift;
  return ms > 300000 ? 300000 : ms;
}

static bool tokenReady() {
  const char *t = DEVICE_TOKEN;
  if (!t || !t[0]) return false;
  if (strncmp(t, "PASTE_", 6) == 0) return false;
  if (strncmp(t, "replace-", 8) == 0) return false;
  return true;
}

static bool idReady() {
  const char *id = DEVICE_ID;
  if (!id || !id[0] || strlen(id) > 40) return false;
  for (const char *p = id; *p; p++) {
    if (*p == '"' || *p == '\\' || (unsigned char)*p < 0x20) return false;
  }
  return true;
}

static bool climateReady() {
#if CLIMATE_VALUES_ARE_REAL
  float t = (float)CLIMATE_TEMPERATURE_C;
  float h = (float)CLIMATE_HUMIDITY_PCT;
  return t >= -20.0f && t <= 60.0f && h >= 0.0f && h <= 100.0f;
#else
  return false;
#endif
}

static int postJson(const char *path, const char *body, String *detail) {
  int code = -1;
  String err;
  Serial.printf("[send] POST %s%s %s\n", API_BASE_URL, path, body);
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  if (http.begin(String(API_BASE_URL) + path)) {
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Token", DEVICE_TOKEN);
    code = http.POST((uint8_t *)body, strlen(body));
    if (code > 0) *detail = http.getString();
    else err = http.errorToString(code);
    http.end();
  }
  if (code == 201 || code == 200) *detail = String("sent OK (") + code + ")";
  else if (code == 409) *detail = "duplicate, treated as sent";
  else if (code == 401) *detail = "401";
  else if (code == 400) *detail = "400 rejected";
  else if (code == 404) *detail = "404 route missing";
  else *detail = String("error ") + code + (err.length() ? " " + err : "");
  Serial.printf("[send] %s -> %d %s\n", path, code, detail->c_str());
  return code;
}

static bool transportFailed(int code) {
  return code <= 0 || code == 408 || code == 429 || code >= 500;
}

static void sendReading() {
  waitShort = false;
  if (apiGaveUp) return;
  if (!tokenReady() || !idReady()) {
    waitShort = true;
    lastSendStatus = "set DEVICE_TOKEN and DEVICE_ID in secrets.h";
    Serial.println("[send] skipped: secrets.h still has a placeholder token or a bad device id");
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    waitShort = true;
    lastSendStatus = "no internet Wi-Fi";
    Serial.println("[send] skipped: internet Wi-Fi offline");
    return;
  }
  char ts[25];
  if (!timestampNow(ts, sizeof ts)) {
    waitShort = true;
    lastSendStatus = "waiting for clock (NTP)";
    Serial.println("[send] skipped: waiting for NTP");
    return;
  }

  if (cachedSoil < 0 || cachedWater < 0) refreshCached();
  int soilPct = toPct(cachedSoil, soilDry, soilWet, soilDrySet, soilWetSet);
  int waterPct = toPct(cachedWater, waterEmpty, waterFull, waterEmptySet, waterFullSet);
  String soilStatus;
  String waterStatus;
  bool soilTried = false;
  int soilCode = 0;
  int waterCode = 0;

  if (soilPct < 0) soilStatus = "calibrate soil first";
  else if (!climateReady()) {
#if CLIMATE_VALUES_ARE_REAL
    soilStatus = "climate values out of range";
#else
    soilStatus = "set CLIMATE_VALUES_ARE_REAL";
#endif
  } else {
    char body[320];
    snprintf(body, sizeof body,
             "{\"deviceId\":\"%s\",\"plotId\":%d,\"timestamp\":\"%s\",\"soilMoisturePct\":%d,\"temperatureC\":%.1f,\"humidityPct\":%.1f,\"raining\":false}",
             DEVICE_ID, (int)PLOT_ID, ts, soilPct, (double)CLIMATE_TEMPERATURE_C, (double)CLIMATE_HUMIDITY_PCT);
    soilCode = postJson(API_PATH, body, &soilStatus);
    soilTried = true;
  }

  char waterBody[320];
  if (waterPct >= 0) {
    snprintf(waterBody, sizeof waterBody,
             "{\"deviceId\":\"%s\",\"plotId\":%d,\"timestamp\":\"%s\",\"waterLevelRaw\":%d,\"waterLevelPct\":%d,\"calibrated\":true}",
             DEVICE_ID, (int)PLOT_ID, ts, cachedWater, waterPct);
  } else {
    snprintf(waterBody, sizeof waterBody,
             "{\"deviceId\":\"%s\",\"plotId\":%d,\"timestamp\":\"%s\",\"waterLevelRaw\":%d,\"waterLevelPct\":null,\"calibrated\":false}",
             DEVICE_ID, (int)PLOT_ID, ts, cachedWater);
  }
  waterCode = postJson(TANK_PATH, waterBody, &waterStatus);

  if ((soilTried && soilCode == 401) || waterCode == 401) {
    apiGaveUp = true;
    lastSendStatus = "401: check DEVICE_TOKEN (stopped until restart)";
    Serial.println("[send] 401 unauthorized: check DEVICE_TOKEN / DEVICE_ID; stopped until restart");
    return;
  }

  bool failed = (soilTried && transportFailed(soilCode)) || transportFailed(waterCode);
  if (failed) failCount = failCount < 255 ? failCount + 1 : 255;
  else if ((soilTried && (soilCode == 400 || soilCode == 404)) || waterCode == 400 || waterCode == 404) {
    failCount = failCount < 255 ? failCount + 1 : 255;
  } else failCount = 0;

  lastSendStatus = "soil: " + soilStatus + " · water: " + waterStatus;
}

static uint32_t nextWaitMs() {
  if (waitShort) return 2000;
  if (failCount) return backoffMs(failCount);
  return SEND_INTERVAL_MS;
}

void setup() {
  Serial.begin(115200);
  delay(400);
  analogReadResolution(12);
  analogSetPinAttenuation(WATER_PIN, ADC_11db);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);
  loadCal();
  Serial.println("\nMzansi Farmer - soil and water sensors");

  WiFi.mode(WIFI_AP_STA);
  WiFi.setAutoReconnect(true);
  if (!WiFi.softAPConfig(LOCAL_IP, GATEWAY, SUBNET)) Serial.println("[ap] warning: static IP failed");
  if (!WiFi.softAP(AP_SSID, AP_PASSWORD)) Serial.println("[ap] ERROR: hotspot did not start");
  Serial.printf("[ap] %s -> http://%s\n", AP_SSID, WiFi.softAPIP().toString().c_str());
  lastWifiAttempt = millis() - WIFI_RETRY_MS;
  ensureInternetWifi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  server.on("/", HTTP_GET, []() { server.send_P(200, "text/html", page); });
  server.on("/data", HTTP_GET, handleData);
  server.on("/calibrate", HTTP_GET, handleCal);
  server.onNotFound([]() { server.send(404, "text/plain", "Open http://192.168.4.1"); });
  server.begin();
  Serial.println("[web] dashboard ready at http://192.168.4.1");
}

void loop() {
  server.handleClient();
  ensureInternetWifi();
  static bool wasUp = false;
  bool up = WiFi.status() == WL_CONNECTED;
  if (up != wasUp) {
    if (up) Serial.printf("[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
    else Serial.println("[wifi] internet Wi-Fi dropped");
    wasUp = up;
  }
  if ((int32_t)(millis() - nextSendAt) >= 0) {
    if (cachedSoil < 0) refreshCached();
    sendReading();
    uint32_t wait = apiGaveUp ? 60000 : nextWaitMs();
    cachedWater = cachedSoil = -1;
    nextSendAt = millis() + wait;
  }
}
