# Lobby search: a public room shows in another device's Play screen, going private
# hides it at once, going public shows it again, joining from the list works,
# and a full or started room drops out.
#   npm run build && npx wrangler dev --port 8799 &   then   python3 test/test-lobby-search.py
import sys, time
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8799/'
fails, errs = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)
with sync_playwright() as pw:
    b = pw.chromium.launch()
    def page(name):
        ctx = b.new_context(viewport={'width':430,'height':900})
        pg = ctx.new_page()
        pg.on('pageerror', lambda e, n=name: errs.append(n+': '+str(e)))
        pg.goto(BASE); pg.wait_for_function("LIB && LIB.cards.length > 40", timeout=10000)
        return pg
    host, guest = page('host'), page('guest')
    host.click('[data-on="open"]'); host.fill('[data-on-input="name"]', 'Kal')
    host.click('[data-on="host"]'); host.wait_for_selector('.room-code', timeout=10000)
    code = host.evaluate('ON.code')
    check(host.locator('[data-on-input="private"]').count()==1, 'the host has a Private lobby option')
    guest.click('[data-on="open"]'); guest.fill('[data-on-input="name"]', 'Sam')
    guest.wait_for_selector('.ls', timeout=5000)
    def listed(want=True):
        for _ in range(4):
            guest.evaluate("lsLoad()"); guest.wait_for_timeout(600)
            got = guest.locator(f'[data-on="joinlisted"][data-code="{code}"]').count() > 0
            if got == want: break
        return got
    check(listed(), 'the public room shows in the lobby search')
    row = guest.locator('.ls-row').filter(has=guest.locator(f'[data-code="{code}"]')).inner_text()
    check('Kal' in row and '1/2' in row, 'the row names the host and the free seat: ' + row.replace('\n',' | '))
    guest.screenshot(path='shots/ls1-list.png')
    host.check('[data-on-input="private"]'); host.wait_for_timeout(500)
    check(not listed(False), 'going private removes it from the search')
    host.uncheck('[data-on-input="private"]'); host.wait_for_timeout(500)
    check(listed(), 'going public again brings it back')
    guest.click(f'[data-on="joinlisted"][data-code="{code}"]')
    guest.wait_for_function(f"ON.code==='{code}' && ON.seat===1", timeout=8000)
    check(True, 'joining from the list puts the guest in seat 2')
    third = page('third'); third.click('[data-on="open"]'); third.fill('[data-on-input="name"]', 'Ada')
    third.wait_for_timeout(600); third.evaluate("lsLoad()"); third.wait_for_timeout(700)
    check(third.locator(f'[data-code="{code}"]').count()==0, 'a full room drops out of the search')
    check(not errs, 'no page errors: ' + str(errs[:3]))
    b.close()
print('lobby search: ' + ('all checks passed' if not fails else f'{len(fails)} failures'))
sys.exit(1 if fails else 0)
