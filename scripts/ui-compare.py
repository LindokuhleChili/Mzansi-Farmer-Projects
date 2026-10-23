#!/usr/bin/env python3
"""Side-by-side check of the web UI against the approved demo screens (mockup left, build right).
usage:  python3 scripts/ui-compare.py OUT_DIR          env: CHROME_PATH (default /usr/bin/google-chrome), MOCKUPS (default /workspace/mzansi-demo-screens)
It starts the API with the MOCK OpenEdge and MOCK AI on port 3000 (throwaway tokens, no AI key), seeds three live plots through the device route
(Maize A dry, Beans B dry + raining, Spinach C wet), asks the stand-in AI once (waiting) and once in over-eager mode with rain (blocked by a rule),
then captures the build at the mockups' own viewports (desktop 1440x900, phone 390x844) and stitches the pairs."""
import subprocess, sys, os, time, json, urllib.request, signal, datetime
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
MOCK = os.environ.get('MOCKUPS', '/workspace/mzansi-demo-screens'); BASE = 'http://localhost:3000'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(os.environ, OE_MODE='mock', AI_PROVIDER='mock', AI_API_KEY='', AI_BASE_URL='', AI_MODEL='', AI_MOCK_BEHAVIOUR='normal',
           APP_TOKEN='local-test-app-token-0123456789', PORT='3000', HOST='127.0.0.1', LOG_DIR=os.path.join(OUT, '_logs'), LOG_LEVEL='warn',
           DEVICE_REGISTRY=json.dumps([{'deviceId': f'esp32-0{i}', 'plotId': i, 'token': f'local-test-device-token-{i}'} for i in (1, 2, 3)]))

def seed_demo():
    """Three live plots like the approved screens: 20 readings 30 s apart, newest 4 / 3 / 6 min old."""
    def post(plot, soil_end, soil_start, temp, hum, rain, age):
        last = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=age)
        for i in range(20):
            ts = (last - datetime.timedelta(seconds=30 * (19 - i))).strftime('%Y-%m-%dT%H:%M:%SZ')
            body = dict(deviceId=f'esp32-0{plot}', plotId=plot, timestamp=ts, soilMoisturePct=round(soil_start + (soil_end - soil_start) * i / 19, 1),
                        temperatureC=round(temp + ((i % 3) - 1) * 0.1, 1), humidityPct=hum + (1 if i % 4 == 0 else 0), raining=rain)
            urllib.request.urlopen(urllib.request.Request(BASE + '/api/v1/readings', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'X-Device-Token': f'local-test-device-token-{plot}'}))
    post(1, 18.5, 27.0, 29.4, 41, False, 4); post(2, 27.0, 29.0, 24.1, 88, True, 3); post(3, 52.0, 52.5, 26.8, 63, False, 6)
def ui(path, body=None):
    r = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers={'X-Requested-With': 'mzansi-ui', 'content-type': 'application/json'}, method='POST' if body is not None else 'GET')
    return json.load(urllib.request.urlopen(r))

def stitch(left, right, out, title, scale_left=None):
    L = Image.open(left).convert('RGB'); R = Image.open(right).convert('RGB')
    if scale_left: L = L.resize(scale_left, Image.LANCZOS)
    if R.size != L.size: R = R.resize(L.size, Image.LANCZOS)
    pad, head = 16, 34
    W = L.width * 2 + pad * 3; H = L.height + head + pad * 2
    im = Image.new('RGB', (W, H), '#ffffff'); d = ImageDraw.Draw(im)
    try: f = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 18)
    except Exception: f = None
    d.text((pad, 8), f'{title}  -  MOCKUP (approved)', fill='#0E3626', font=f); d.text((pad * 2 + L.width, 8), f'{title}  -  BUILD (web-ui)', fill='#0E3626', font=f)
    im.paste(L, (pad, head + pad)); im.paste(R, (pad * 2 + L.width, head + pad)); im.save(out)

srv = subprocess.Popen(['node', 'apps/api/src/index.js'], cwd=ROOT, env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, preexec_fn=os.setsid)
try:
    for _ in range(40):
        try: urllib.request.urlopen(BASE + '/health', timeout=1); break
        except Exception: time.sleep(0.25)
    seed_demo()
    wait = ui('/ui/api/v1/plots/1/advise', {'lang': 'en'}); ui('/ui/api/demo/ai-behaviour', {'behaviour': 'greedy'})
    rej = ui('/ui/api/v1/plots/2/advise', {'lang': 'en'}); ui('/ui/api/demo/ai-behaviour', {'behaviour': 'normal'})
    print('waiting suggestion', wait['suggestionId'], wait['status'], '| rejected', rej['suggestionId'], rej['status'])
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH', '/usr/bin/google-chrome'), args=['--no-sandbox'])
        for kind, vp, mk in (('desktop', (1440, 900), 'desktop'), ('mobile', (390, 844), 'mobile')):
            kw = dict(viewport={'width': vp[0], 'height': vp[1]}, device_scale_factor=2 if kind == 'mobile' else 1, locale='en-ZA', timezone_id='Africa/Johannesburg')
            if kind == 'mobile': kw.update(is_mobile=True, has_touch=True)
            ctx = b.new_context(**kw); pg = ctx.new_page(); problems = []
            pg.on('console', lambda m: problems.append(m.text) if m.type in ('error', 'warning') else None); pg.on('pageerror', lambda e: problems.append(str(e)))
            vis = lambda sel: pg.locator(sel + ':visible').first
            shots = {}
            def snap(name):
                pg.wait_for_timeout(500); path = f'{OUT}/_raw-{kind}-{name}.png'; pg.screenshot(path=path); shots[name] = path
            pg.goto(BASE + '/'); pg.wait_for_selector(':is(.pc,.mc):visible'); pg.wait_for_timeout(600); snap('1-dashboard')
            pg.goto(BASE + f"/#/suggestions/{wait['suggestionId']}"); pg.wait_for_selector('.rrow:visible'); snap('2-review')
            vis('[data-act=approve]').click(); pg.wait_for_selector('.sheet'); snap('2b-confirm'); vis('[data-act=sheet-cancel]').click()
            pg.goto(BASE + f"/#/suggestions/{rej['suggestionId']}"); pg.wait_for_selector('.banner.red:visible'); snap('3-rejected')
            names = {'1-dashboard': f'{mk}-1-dashboard', '2-review': f'{mk}-2-review', '2b-confirm': f'{mk}-2b-confirm', '3-rejected': f'{mk}-3-rejected'}
            for k, path in shots.items():
                m = f'{MOCK}/{names[k]}.png'
                stitch(m, path, f'{OUT}/compare-{names[k]}.png', names[k], scale_left=(vp[0] * (2 if kind == 'mobile' else 1), vp[1] * (2 if kind == 'mobile' else 1)))
            print(kind, 'console problems:', problems or 'none')
            ctx.close()
        b.close()
finally:
    os.killpg(os.getpgid(srv.pid), signal.SIGTERM)
