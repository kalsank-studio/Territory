# The Studio's admin lock in a real browser, through a local Worker.
#   npm run build && npx wrangler dev --port 8799 &   then   python3 test/test-admin-ui.py http://127.0.0.1:8799/
import sys, os, re
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8799/'
PW = os.environ.get('ADMIN_PW') or re.search(r'ADMIN_PASSWORD\s*=\s*"?([^"\n]*)"?', open('.dev.vars').read()).group(1)
os.makedirs('shots', exist_ok=True)
fails, errs = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_context(viewport={'width':390, 'height':844}).new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE); pg.wait_for_function("LIB && LIB.cards.length > 40 && ADM.checked", timeout=10000)
    check('browse' in pg.inner_text('.title-actions'), 'the title offers the Studio to browse')
    pg.click('[data-screen="studio"]'); pg.wait_for_selector('.studio-ro')
    check(pg.query_selector('[data-act="pickcard"]') is not None, 'without the password the Studio opens read only')
    check(pg.evaluate("[...document.querySelectorAll('.studio-ro input,.studio-ro select,.studio-ro textarea')].every(e=>e.disabled)"), 'every field is locked')
    check(pg.query_selector('.studio-ro [data-act="newcard"]:not(.ro-hide)') is None, 'and there are no edit buttons')
    check(pg.query_selector('[data-act="tab"][data-v="import"]') is None, 'Import and Art & data are admin only')
    pg.evaluate("()=>{ UI.screen='decks'; render(); }")
    check(pg.query_selector('[data-act="pickdeck"]') is not None and pg.query_selector('.studio-ro [data-act="deckplus"]:not(.ro-hide)') is None, 'decks can be read, not changed')
    pg.click('[data-act="admopen"]'); pg.wait_for_selector('[data-adm="pw"]')
    pg.fill('[data-adm="pw"]', 'not it'); pg.click('[data-act="admunlock"]')
    pg.wait_for_selector('.admin-gate .acct-err', timeout=8000)
    check('admin password' in pg.inner_text('.admin-gate .acct-err'), 'a wrong password says so')
    pg.screenshot(path='shots/ad1-gate.png')
    pg.fill('[data-adm="pw"]', PW); pg.press('[data-adm="pw"]', 'Enter')
    pg.wait_for_selector('[data-act="admlock"]', timeout=8000)
    check(pg.evaluate("isAdmin()"), 'the right password opens the Studio')
    pg.reload(); pg.wait_for_function("LIB && ADM.checked", timeout=10000)
    check(pg.evaluate("isAdmin()"), 'and it stays open after a reload')
    pg.evaluate("()=>{ UI.screen='studio'; render(); }")
    pg.click('[data-act="admlock"]')
    check(not pg.evaluate("isAdmin()") and pg.query_selector('.studio-ro') is not None, 'Lock turns it back to read only')
    pg.reload(); pg.wait_for_function("LIB && ADM.checked", timeout=10000)
    check(not pg.evaluate("isAdmin()"), 'and it stays shut')
    b.close()
print('page errors:', errs[:5])
print(('%d failures' % len(fails)) if fails or errs else 'admin ui: all checks passed')
sys.exit(1 if fails or errs else 0)
