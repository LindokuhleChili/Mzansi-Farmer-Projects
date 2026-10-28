// Mzansi Farmer - ESP32 soil + water probes (Wi-Fi CLIENT / station mode).
// Board: ESP32 Dev Module. Arduino-ESP32 core 3.x. Libraries: built-in only.
//
// Wi-Fi name and password are read from secrets.h (copy secrets.example.h).
// They are not written in this file. The board joins that network, gets an
// address from DHCP and prints it on Serial (115200). Open http://<that IP>/
// or http://mzansi-farm.local/
//   GET /            dashboard
//   GET /data        live JSON (CORS *, no token)
//   GET /api/readings  same JSON (alias)
//   GET /history     recent raw samples
//   GET /calibrate?mode=wempty|wfull|sdry|swet
// Water signal GPIO34, soil AO GPIO35, calibration saved in Preferences.
//
// Optional cloud upload (OFF by default): #define ENABLE_CLOUD_UPLOAD 1 in
// secrets.h, with DEVICE_TOKEN / DEVICE_ID / API_BASE_URL, to POST readings to
// {API_BASE_URL}/api/v1/readings and /api/v1/tank-readings with X-Device-Token.
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
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
#ifndef WIFI_PASSWORD
#error "secrets.h must define WIFI_PASSWORD"
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
#ifndef PLOT_ID
#define PLOT_ID 1
#endif
#ifndef ENABLE_CLOUD_UPLOAD
#define ENABLE_CLOUD_UPLOAD 0
#endif
#ifndef CLIMATE_VALUES_ARE_REAL
#define CLIMATE_VALUES_ARE_REAL 0
#endif
#ifndef CLIMATE_TEMPERATURE_C
#define CLIMATE_TEMPERATURE_C 22.0
#endif
#ifndef CLIMATE_HUMIDITY_PCT
#define CLIMATE_HUMIDITY_PCT 55.0
#endif

static const char *MDNS_NAME = "mzansi-farm";
static const uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
static const int WIFI_CONNECT_TRIES = 5;

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
<title>Mzansi Farmer · Live Sensors</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:16px;font-family:system-ui,Segoe UI,Arial,sans-serif;background:radial-gradient(circle at 20% 0,#0f2a24,#070d18 60%);color:#e8f1f2;min-height:100vh}
.wrap{max-width:960px;margin:auto}.eye{color:#4ade80;font-size:12px;font-weight:700;letter-spacing:3px}
h1{margin:6px 0 2px;font-size:28px}.sub{color:#8fa3b3;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
.chip{background:#ffffff10;border:1px solid #ffffff1a;padding:6px 12px;border-radius:99px;font-size:13px;display:flex;gap:6px;align-items:center}
.dot{width:8px;height:8px;border-radius:50%;background:#64748b}.on{background:#4ade80;box-shadow:0 0 8px #4ade80}.off{background:#f87171}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.card{background:#0f1a2bcc;border:1px solid #1f2f45;border-radius:20px;padding:18px;backdrop-filter:blur(6px)}
.t{color:#8fa3b3;font-size:12px;letter-spacing:2px;font-weight:700}
.g{display:flex;gap:16px;align-items:center;margin:10px 0}
.ring{position:relative;width:140px;height:140px;flex:none}.ring svg{transform:rotate(-90deg)}
.ring circle{fill:none;stroke-width:12}.bg{stroke:#1f2f45}.fg{stroke-linecap:round;transition:stroke-dashoffset .6s}
.val{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.val b{font-size:34px}.val span{font-size:12px;color:#8fa3b3}
.m{color:#a7b8c6;font-size:13px;line-height:1.6}.st{font-weight:700;font-size:15px;margin-bottom:4px}
.hint{margin-top:8px;padding:8px 10px;border-radius:10px;background:#f59e0b1f;color:#fcd34d;font-size:13px}
.hint.ok{background:#4ade801f;color:#86efac}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
button{border:0;padding:11px;border-radius:12px;font-weight:700;color:#fff;cursor:pointer;font-size:14px}
button.done{outline:2px solid #4ade80}
.b1{background:#334155}.b2{background:#0284c7}.b3{background:#92400e}.b4{background:#15803d}
canvas{width:100%;height:170px;display:block;margin-top:8px}
.full{grid-column:1/-1}
@media(max-width:640px){.grid{grid-template-columns:1fr}.ring{width:120px;height:120px}}
</style></head><body><div class="wrap">
<div class="eye">MZANSI FARMER · ESP32 LIVE</div><h1>Farm Sensors</h1>
<div class="sub">Water tank and soil moisture, live from the field.</div>
<div class="chips"><div class="chip"><i class="dot" id="cd"></i><span id="conn">Connecting...</span></div>
<div class="chip"><i class="dot" id="wd"></i><span id="sta">Wi-Fi: --</span></div>
<div class="chip">☁ <span id="cloud">Cloud: --</span></div></div>
<div class="grid">
<div class="card"><div class="t">💧 WATER TANK</div><div class="g">
<div class="ring"><svg viewBox="0 0 140 140" width="100%" height="100%"><circle class="bg" cx="70" cy="70" r="58"/><circle class="fg" id="wg" cx="70" cy="70" r="58" stroke="#38bdf8"/></svg>
<div class="val"><b id="wp">--</b><span id="wu">raw</span></div></div>
<div><div class="st" id="ws">--</div><div class="m">Raw <b id="wr">--</b><br>Empty <b id="we">-</b> · Full <b id="wf">-</b></div></div></div>
<div class="hint" id="wh"></div>
<div class="row"><button class="b1" id="bwe" onclick="cal('wempty','sensor at EMPTY level')">Set EMPTY</button>
<button class="b2" id="bwf" onclick="cal('wfull','sensor at FULL level')">Set FULL</button></div></div>
<div class="card"><div class="t">🌱 SOIL MOISTURE</div><div class="g">
<div class="ring"><svg viewBox="0 0 140 140" width="100%" height="100%"><circle class="bg" cx="70" cy="70" r="58"/><circle class="fg" id="sg" cx="70" cy="70" r="58" stroke="#4ade80"/></svg>
<div class="val"><b id="sp">--</b><span id="su">raw</span></div></div>
<div><div class="st" id="ss">--</div><div class="m">Raw <b id="sr">--</b><br>Dry <b id="sd">-</b> · Wet <b id="sw">-</b></div></div></div>
<div class="hint" id="sh"></div>
<div class="row"><button class="b3" id="bsd" onclick="cal('sdry','probe in DRY air or dry soil')">Set DRY</button>
<button class="b4" id="bsw" onclick="cal('swet','probe in a cup of WATER or wet soil')">Set WET</button></div></div>
<div class="card"><div class="t">WATER HISTORY</div><canvas id="wc"></canvas></div>
<div class="card"><div class="t">SOIL HISTORY</div><canvas id="sc"></canvas></div>
<div class="card full"><div class="t">WIRING</div><div class="m">Water: signal GPIO34, + to 3V3, - to GND · Soil: AO to GPIO35, VCC to 3V3, GND to GND · JSON at /data, history at /history</div></div>
</div></div><script>
const $=i=>document.getElementById(i),N=120,C=2*Math.PI*58;let D=null,W=[],S=[];
['wg','sg'].forEach(i=>{$(i).style.strokeDasharray=C;$(i).style.strokeDashoffset=C});
function pct(r,a,b,as,bs){if(!as||!bs||a==b)return -1;let p=Math.round((r-a)*100/(b-a));return p<0?0:p>100?100:p}
function push(a,v){a.push(v);if(a.length>N)a.shift()}
function ring(g,b,u,p,raw){if(p>=0){$(b).textContent=p+'%';$(u).textContent='calibrated';$(g).style.strokeDashoffset=C*(1-p/100)}
 else{$(b).textContent=raw;$(u).textContent='raw 0-4095';$(g).style.strokeDashoffset=C*(1-raw/4095)}}
function hint(h,lo,hi,ln,hn,b1,b2){let e=$(h);$(b1).className=$(b1).className.replace(' done','')+(lo?' done':'');$(b2).className=$(b2).className.replace(' done','')+(hi?' done':'');
 if(lo&&hi){e.className='hint ok';e.textContent='✓ Calibrated: showing percentage'}
 else{e.className='hint';e.textContent=!lo&&!hi?'Step 1 of 2: set '+ln+' (then '+hn+')':'Step 2 of 2: '+(lo?hn:ln)+' point missing, set '+(lo?hn:ln)}}
function draw(id,arr,cal,col,lo,hi,as,bs){const c=$(id),r=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*r;c.height=h*r;
 const x=c.getContext('2d');x.scale(r,r);x.clearRect(0,0,w,h);const L=34,B=18,pw=w-L-6,ph=h-B-6,mx=cal?100:4095;
 x.font='10px sans-serif';x.fillStyle='#8fa3b3';x.strokeStyle='#1f2f45';x.lineWidth=1;
 for(let k=0;k<=4;k++){const y=4+ph*k/4;x.beginPath();x.moveTo(L,y);x.lineTo(L+pw,y);x.stroke();x.fillText(Math.round(mx*(1-k/4)),2,y+3)}
 x.fillText(cal?'% (calibrated)':'raw ADC 0-4095 (not calibrated)',L,h-4);x.textAlign='right';x.fillText('last '+N+' s',w-4,h-4);x.textAlign='left';
 if(arr.length<2)return;const v=arr.map(q=>cal?pct(q,lo,hi,as,bs):q);
 const g=x.createLinearGradient(0,4,0,4+ph);g.addColorStop(0,col+'66');g.addColorStop(1,col+'00');
 x.beginPath();v.forEach((q,i)=>{const X=L+pw*(i+N-v.length)/(N-1),Y=4+ph*(1-q/mx);i?x.lineTo(X,Y):x.moveTo(X,Y)});
 x.strokeStyle=col;x.lineWidth=2;x.stroke();x.lineTo(L+pw,4+ph);x.lineTo(L+pw*(N-v.length)/(N-1),4+ph);x.fillStyle=g;x.fill()}
function render(){if(!D)return;const d=D,wc=d.wEs&&d.wFs,sc=d.sDs&&d.sWs;
 draw('wc',W,wc,'#38bdf8',d.wE,d.wF,d.wEs,d.wFs);draw('sc',S,sc,'#4ade80',d.sD,d.sW,d.sDs,d.sWs)}
async function up(){try{const d=await(await fetch('/data?t='+Date.now(),{cache:'no-store'})).json();D=d;
 $('conn').textContent='Sensors live';$('cd').className='dot on';
 $('sta').textContent=d.sta?('Wi-Fi '+d.staIp+' · '+d.rssi+' dBm'):'Wi-Fi offline';$('wd').className='dot '+(d.sta?'on':'off');
 $('cloud').textContent='Cloud: '+d.cloud;
 $('wr').textContent=d.wRaw;$('we').textContent=d.wEs?d.wE:'-';$('wf').textContent=d.wFs?d.wF:'-';
 $('sr').textContent=d.sRaw;$('sd').textContent=d.sDs?d.sD:'-';$('sw').textContent=d.sWs?d.sW:'-';
 ring('wg','wp','wu',d.wPct,d.wRaw);ring('sg','sp','su',d.sPct,d.sRaw);
 $('ws').textContent=d.wPct<0?'Not calibrated':d.wPct<=20?'Low: refill the tank':d.wPct<70?'Medium level':'Tank is full';
 $('ss').textContent=d.sPct<0?'Not calibrated':d.sPct<=20?'Dry: needs water':d.sPct<70?'Moisture is good':'Wet: no watering needed';
 hint('wh',d.wEs,d.wFs,'EMPTY','FULL','bwe','bwf');hint('sh',d.sDs,d.sWs,'DRY','WET','bsd','bsw');
 push(W,d.wRaw);push(S,d.sRaw);render();
}catch(e){$('conn').textContent='Reconnecting...';$('cd').className='dot off'}}
async function cal(m,txt){if(!confirm('Is the '+txt+' right now?'))return;
 try{const r=await(await fetch('/calibrate?mode='+m)).json();if(!r.ok)throw 0;up()}catch(e){alert('Calibration failed.')}}
fetch('/history').then(r=>r.json()).then(h=>{if(!W.length){W=h.w.slice(-N);S=h.s.slice(-N)}}).catch(()=>0).finally(()=>{up();setInterval(up,1000)});
onresize=render;
</script></body></html>
)rawliteral";

static const int HIST_N = 120;
static int16_t histW[HIST_N], histS[HIST_N];
static int histCount = 0, histHead = 0;
static uint32_t nextHistAt = 0;

static void sampleHistory() {
  if ((int32_t)(millis() - nextHistAt) < 0) return;
  nextHistAt = millis() + 1000;
  histW[histHead] = (int16_t)readAvg(WATER_PIN);
  histS[histHead] = (int16_t)readAvg(SOIL_PIN);
  histHead = (histHead + 1) % HIST_N;
  if (histCount < HIST_N) histCount++;
}

static void allowBrowser() {
  server.sendHeader("Cache-Control", "no-store");
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
}

static void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.send(204);
}

static void handleHistory() {
  String w, s;
  w.reserve(histCount * 5); s.reserve(histCount * 5);
  for (int i = 0; i < histCount; i++) {
    int k = (histHead - histCount + i + HIST_N) % HIST_N;
    if (i) { w += ','; s += ','; }
    w += String(histW[k]); s += String(histS[k]);
  }
  allowBrowser();
  server.send(200, "application/json", "{\"intervalMs\":1000,\"w\":[" + w + "],\"s\":[" + s + "]}");
}

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
             "\",\"cloud\":\"" + jsonEscape(lastSendStatus) + "\",\"rssi\":" + String(sta ? WiFi.RSSI() : 0) + "}";
  allowBrowser();
  server.send(200, "application/json", j);
}

static void handleCal() {
  String mode = server.hasArg("mode") ? server.arg("mode") : "";
  if (mode == "wempty") { waterEmpty = readAvg(WATER_PIN); waterEmptySet = true; cachedWater = waterEmpty; }
  else if (mode == "wfull") { waterFull = readAvg(WATER_PIN); waterFullSet = true; cachedWater = waterFull; }
  else if (mode == "sdry") { soilDry = readAvg(SOIL_PIN); soilDrySet = true; cachedSoil = soilDry; }
  else if (mode == "swet") { soilWet = readAvg(SOIL_PIN); soilWetSet = true; cachedSoil = soilWet; }
  else { allowBrowser(); server.send(400, "application/json", "{\"ok\":false}"); return; }
  saveCal();
  Serial.println(String("Calibration saved: ") + mode);
  allowBrowser();
  server.send(200, "application/json", "{\"ok\":true}");
}

static void printWifiInfo() {
  Serial.println("[wifi] connected");
  Serial.printf("[wifi] SSID: %s\n", WiFi.SSID().c_str());
  Serial.printf("[wifi] IP (DHCP): %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("[wifi] RSSI: %d dBm\n", WiFi.RSSI());
  Serial.printf("[web] dashboard: http://%s/   JSON: http://%s/data\n",
                WiFi.localIP().toString().c_str(), WiFi.localIP().toString().c_str());
}

static void startMdns() {
  MDNS.end();
  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("http", "tcp", 80);
    Serial.printf("[mdns] http://%s.local/\n", MDNS_NAME);
  } else {
    Serial.println("[mdns] failed to start (use the IP instead)");
  }
}

// Blocking connect with timeout + retries (used at boot).
static bool connectWifi() {
  for (int attempt = 1; attempt <= WIFI_CONNECT_TRIES; attempt++) {
    Serial.printf("[wifi] connecting to %s (try %d/%d) ...\n", WIFI_SSID, attempt, WIFI_CONNECT_TRIES);
    WiFi.disconnect(true);
    delay(200);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);  // DHCP
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
      delay(250);
      Serial.print('.');
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) return true;
    Serial.printf("[wifi] timed out (status %d)\n", (int)WiFi.status());
  }
  Serial.println("[wifi] could not connect; will keep retrying in loop()");
  return false;
}

// Non-blocking reconnect (used in loop()).
static void ensureInternetWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if ((int32_t)(millis() - lastWifiAttempt) < (int32_t)WIFI_RETRY_MS) return;
  lastWifiAttempt = millis();
  Serial.printf("[wifi] reconnecting to %s ...\n", WIFI_SSID);
  WiFi.disconnect();
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
#if !ENABLE_CLOUD_UPLOAD
  lastSendStatus = "upload off (local only)";
  return;
#endif
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

  WiFi.mode(WIFI_STA);          // client only: no ESP32 hotspot
  WiFi.setHostname(MDNS_NAME);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  if (connectWifi()) { printWifiInfo(); startMdns(); }
  lastWifiAttempt = millis();
  configTime(0, 0, "pool.ntp.org", "time.google.com");

  server.on("/", HTTP_GET, []() { allowBrowser(); server.send_P(200, "text/html", page); });
  server.on("/data", HTTP_GET, handleData);
  server.on("/api/readings", HTTP_GET, handleData);
  server.on("/calibrate", HTTP_GET, handleCal);
  server.on("/history", HTTP_GET, handleHistory);
  server.onNotFound([]() {
    if (server.method() == HTTP_OPTIONS) {
      handleOptions();
      return;
    }
    server.send(404, "text/plain", "Try / or /data");
  });
  server.begin();
  Serial.println("[web] server started on port 80");
}

void loop() {
  server.handleClient();
  sampleHistory();
  ensureInternetWifi();
  static bool wasUp = false;
  bool up = WiFi.status() == WL_CONNECTED;
  if (up != wasUp) {
    if (up) { printWifiInfo(); startMdns(); }
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

