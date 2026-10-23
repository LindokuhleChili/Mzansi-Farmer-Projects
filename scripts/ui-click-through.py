#!/usr/bin/env python3
"""Click-through of the web UI with Playwright (headless Chrome / Chromium). Not part of `npm test` (keeps the repo dependency-light).
usage:  python3 scripts/ui-click-through.py mobile|desktop [--video]
env:    SHOT_DIR (default ./ui-shots)   CHROME_PATH (path to chrome/chromium; default: Playwright's own browser)
It starts the API with the MOCK OpenEdge and the MOCK AI on port 3000 (throwaway tokens, the real AI key is blanked), so every run begins
from the seed data, then drives: dashboard -> plot page -> simulate reading -> ask AI -> review -> ZU/EN -> confirm -> approve -> audit,
the rain / over-eager rejection, the weekly-budget rejection and the decline path. It exits 1 on any failed check or console error.
Setup once:  pip install playwright   (and `playwright install chromium`, or set CHROME_PATH)."""
import subprocess, sys, time, os, json, urllib.request, signal
from playwright.sync_api import sync_playwright

mode = sys.argv[1]; video = '--video' in sys.argv
VP = {'mobile': (390, 844), 'desktop': (1280, 800)}[mode]
OUT = os.environ.get('SHOT_DIR', './ui-shots'); BASE = 'http://localhost:3000'; os.makedirs(OUT, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(os.environ, OE_MODE='mock', AI_PROVIDER='mock', AI_API_KEY='', AI_BASE_URL='', AI_MODEL='', AI_MOCK_BEHAVIOUR='normal',
           APP_TOKEN='local-test-app-token-0123456789', PORT='3000', HOST='127.0.0.1', LOG_DIR=os.path.join(OUT, '_logs'), LOG_LEVEL='warn',
           DEVICE_REGISTRY=json.dumps([{'deviceId': f'esp32-0{i}', 'plotId': i, 'token': f'local-test-device-token-{i}'} for i in (1, 2, 3)]))
srv = subprocess.Popen(['node', 'apps/api/src/index.js'], cwd=ROOT, env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, preexec_fn=os.setsid)
for _ in range(40):
    try: urllib.request.urlopen(BASE + '/health', timeout=1); break
    except Exception: time.sleep(0.25)
console = []; failures = []
def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + (' ' + detail if detail and not cond else ''))
    if not cond: failures.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(**({'executable_path': os.environ['CHROME_PATH']} if os.environ.get('CHROME_PATH') else {}), args=['--no-sandbox'])
    kw = dict(viewport={'width': VP[0], 'height': VP[1]}, device_scale_factor=2 if not video else 1, locale='en-ZA', timezone_id='Africa/Johannesburg')
    if mode == 'mobile': kw.update(is_mobile=True, has_touch=True)
    if video: kw.update(record_video_dir=f'{OUT}/_vid-{mode}', record_video_size={'width': VP[0], 'height': VP[1]})
    ctx = b.new_context(**kw)
    pg = ctx.new_page()
    pg.on('console', lambda m: console.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: console.append('PAGEERROR ' + str(e)))
    pg.on('requestfailed', lambda r: console.append('REQFAILED ' + r.url))
    pause = (lambda ms=1100: pg.wait_for_timeout(ms)) if video else (lambda ms=250: pg.wait_for_timeout(ms))
    def shot(name, full=False):
        try: pg.wait_for_selector('.toast', state='detached', timeout=8000)   # screenshots without a lingering toast
        except Exception: pass
        pg.wait_for_timeout(200)
        over = pg.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        check(f'no sideways scrolling on {name}', over <= 1, f'(overflow {over}px)')
        if not video: pg.screenshot(path=f'{OUT}/{mode}-{name}.png', full_page=full)
    vis = lambda sel: pg.locator(','.join(x.strip() + ':visible' for x in sel.split(','))).first
    CARD = 'a.pc:visible, a.mc:visible'

    # 1. dashboard: seed readings are old, so every sensor shows offline
    pg.goto(BASE + '/'); pg.wait_for_selector(CARD); pause(1500)
    check('dashboard shows the 3 demo plots', pg.locator(CARD).count() == 3, str(pg.locator(CARD).count()))
    check('stale sensors flagged offline', pg.locator('#view :text("Sensor offline"):visible').count() >= 3)
    shot('01-dashboard-sensors-offline')
    pg.goto(BASE + '/#/plots'); pg.wait_for_selector(CARD); pause(600)
    check('all 5 plots reachable on /#/plots', pg.locator(CARD).count() == 5, str(pg.locator(CARD).count()))
    pg.goto(BASE + '/#/'); pg.wait_for_selector(CARD); pause(400)

    # 2. plot page: simulate a dry reading from the browser
    vis('a[href="#/plots/1"].pc, a[href="#/plots/1"].mc').click(); pg.wait_for_selector('#sim-form'); pause()
    shot('02-plot-detail-simulate')
    pg.click('[data-preset=dry]'); pause(500); pg.click('#sim-form button[type=submit]')
    pg.wait_for_selector('.toast'); pause(900)
    check('reading stored toast', 'Reading stored' in pg.inner_text('.toast'), pg.inner_text('.toast'))
    shot('03-plot-detail-after-reading')

    # 3. dashboard is now live and dry
    pg.goto(BASE + '/#/'); pg.wait_for_selector(CARD); pause(1500)
    check('plot 1 shows Dry soil', 'Dry soil' in vis('a[href="#/plots/1"].pc, a[href="#/plots/1"].mc').inner_text())
    check('waiting suggestions panel / hero visible', pg.locator('#view :text-matches("plots have dry soil|plot has dry soil|Waiting for you"):visible').count() >= 1)
    shot('04-dashboard-live-dry')

    # 4. ask AI -> review
    pg.goto(BASE + '/#/plots/1'); pg.wait_for_selector('#sim-form'); pause(500)
    vis('[data-act=ask]').click(); pg.wait_for_selector('.rrow:visible'); pause(1200)
    check('review shows suggestion', 'Irrigate Maize Plot A with' in vis('.sugtitle').inner_text(), vis('.sugtitle').inner_text())
    check('six rules listed', pg.locator('.rrow:visible').count() == 6, str(pg.locator('.rrow:visible').count()))
    check('SOIL_NOT_DRY row passes', pg.locator('.rrow:visible:has-text("SOIL_NOT_DRY") .ico.ok').count() == 1)
    sug_id = int(pg.url.split('/')[-1])
    shot('05-review-en')
    # language toggle
    vis('[data-act=lang][data-lang=zu]').click(); pg.wait_for_selector('.zu:visible'); pause(1200)
    check('isiZulu approved line shown', 'Chelela isiqephu sombila A ngamalitha' in vis('.zu').inner_text(), vis('.zu').inner_text())
    shot('06-review-zu')
    vis('[data-act=lang][data-lang=en]').click(); pause(500)

    # 5. approve step 1 -> confirm sheet -> step 2
    vis('[data-act=approve]').click(); pg.wait_for_selector('.sheet'); pause(1200)
    check('confirm sheet has countdown', pg.locator('[data-timer]').count() == 1 and ':' in pg.inner_text('[data-timer]'))
    shot('07-confirm-sheet-en')
    vis('.scrim [data-act=confirm]').click(); pg.wait_for_selector('.banner.mint:visible'); pause(1200)
    check('approved state', 'Approved' in vis('.banner.mint').inner_text())
    shot('08-review-approved')

    # 6. audit trail
    pg.goto(BASE + '/#/audit'); pg.wait_for_selector('.aud'); pause(1200)
    txt = pg.inner_text('#view')
    check('audit lists approval', 'Farmer approved' in txt or 'suggestion_approved' in txt, txt[:200])
    check('audit lists rule check', 'Rules checked a suggestion' in txt)
    shot('09-audit-log')

    # 7. rejected path: rain reading + over-eager (stand-in) AI -> rules say no
    pg.goto(BASE + '/#/plots/1'); pg.wait_for_selector('#sim-form'); pause(600)
    pg.click('[data-act=ai-mode][data-mode=greedy]'); pg.wait_for_selector('.toast'); pause(500)
    pg.click('[data-preset=rain]'); pg.click('#sim-form button[type=submit]'); pg.wait_for_selector('.toast'); pause(900)
    shot('10-plot-detail-rain-greedy-ai')
    vis('[data-act=ask]').click(); pg.wait_for_selector('.banner.red:visible'); pause(1200)
    t = pg.inner_text('#view')
    check('rejected: RAIN_DETECTED shown', 'RAIN_DETECTED' in t and 'Not allowed while it is raining' in t)
    check('rejected: SOIL_NOT_DRY shown', 'SOIL_NOT_DRY' in t)
    check('rejected: approve not offered', pg.locator('[data-act=approve]:visible').count() == 0)
    check('rejected: isiZulu rain line shown', 'Akuvunyelwe. Imvula iyana manje.' in t)
    shot('11-rejected-en')
    vis('[data-act=lang][data-lang=zu]').click(); pg.wait_for_selector('.banner.red:visible'); pause(1200)
    shot('12-rejected-zu')
    vis('[data-act=lang][data-lang=en]').click(); pause(400)
    # budget refusal on plot 1: dry reading again, over-eager AI asks 500 L, 1250 used -> over the 1500 L budget
    pg.goto(BASE + '/#/plots/1'); pg.wait_for_selector('#sim-form'); pg.click('[data-preset=dry]'); pg.click('#sim-form button[type=submit]'); pg.wait_for_selector('.toast'); pause(500)
    vis('[data-act=ask]').click(); pg.wait_for_selector('.banner.red:visible'); pause(1000)
    t = pg.inner_text('#view')
    check('rejected: WATER_BUDGET_EXCEEDED shown', 'WATER_BUDGET_EXCEEDED' in t and 'Over the weekly water budget' in t)
    shot('13-rejected-budget-en')

    # 8. decline path on plot 2 with the normal AI
    pg.goto(BASE + '/#/plots/2'); pg.wait_for_selector('#sim-form'); pg.click('[data-act=ai-mode][data-mode=normal]'); pg.wait_for_selector('.toast'); pause(400)
    pg.click('[data-preset=dry]'); pg.click('#sim-form button[type=submit]'); pg.wait_for_selector('.toast'); pause(500)
    vis('[data-act=ask]').click(); pg.wait_for_selector('.rrow:visible'); pause(800)
    check('plot 2 suggestion pending', pg.locator('[data-act=decline]:visible').count() >= 1)
    vis('[data-act=decline]').click(); pg.wait_for_selector('.banner.blue:visible'); pause(1200)
    check('declined state', 'Declined' in vis('.banner.blue').inner_text())
    shot('14-review-declined')

    # 9. dashboard + suggestions list + audit in isiZulu
    pg.goto(BASE + '/#/'); pg.wait_for_selector(CARD); vis('[data-act=lang][data-lang=zu]').click(); pause(1200)
    check('isiZulu greeting', 'Sawubona, Nomsa' in pg.inner_text('#view'))
    shot('15-dashboard-zu')
    vis('[data-act=lang][data-lang=en]').click(); pause(300)
    pg.goto(BASE + '/#/suggestions'); pg.wait_for_selector('.srow:visible'); pause(1200)
    check('suggestion list has rejected and approved', pg.locator('.srow:visible').count() >= 4, str(pg.locator('.srow:visible').count()))
    shot('16-suggestions-list')
    pg.goto(BASE + '/#/settings'); pg.wait_for_selector('#view h1'); pause(600)
    shot('17-settings')
    pg.goto(BASE + '/#/dashboard-none'); pause(300)
    ctx.close(); b.close()
print('console problems:', json.dumps(console, indent=1) if console else 'none')
os.killpg(os.getpgid(srv.pid), signal.SIGTERM)
print(f'RESULT {mode}: {"OK" if not failures else "FAILURES: " + ", ".join(failures)}')
sys.exit(1 if failures or console else 0)
