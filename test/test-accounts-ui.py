# Accounts in real browsers: a profile made in one browser, signed into from
# another, through a local Worker. Each browser has its own storage, like two devices.
#   npm run build && npx wrangler dev --port 8799 &   then   python3 test/test-accounts-ui.py http://127.0.0.1:8799/
import sys, os, random, string
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8799/'
os.makedirs('shots', exist_ok=True)
fails, errs = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)

USER = 'kal' + ''.join(random.choice(string.ascii_lowercase) for _ in range(6))
FINISH = """()=>{ Object.assign(LIB.settings, {players:2, kinds:['human','bot'], placement:'turns', sandbox:false, turnTimer:0, hide:false});
  UI.screen='game'; newGame(); finishGame(); return G.gameId; }"""

with sync_playwright() as pw:
    b = pw.chromium.launch()
    def page(name):
        ctx = b.new_context(viewport={'width':390, 'height':844}, device_scale_factor=2)
        pg = ctx.new_page()
        pg.on('pageerror', lambda e, n=name: errs.append(n+': '+str(e)))
        pg.goto(BASE); pg.wait_for_function("LIB && LIB.cards.length > 40", timeout=10000)
        return ctx, pg
    actx, a = page('A')
    bctx, bb = page('B')

    print('signed out, a record on this browser only')
    a.evaluate("()=>{ UI.screen='profile'; render(); }")
    a.fill('[data-pf="name"]', 'Kal')
    first = a.evaluate(FINISH)
    a.evaluate("()=>{ G=null; UI.screen='profile'; render(); }")
    check(a.evaluate("PROFILE.games.length") == 1 and not a.evaluate("!!ACCT"), 'one game, kept in this browser')
    check('Sign in' in a.inner_text('.acct-card'), 'Profile offers sign in')
    a.screenshot(path='shots/a1-signed-out.png', full_page=True)

    print('making an account')
    a.fill('[data-pf="user"]', USER); a.fill('[data-pf="pass"]', 'pass1234')
    a.click('[data-act="acctnew"]')
    a.wait_for_function("ACCT && PROFILE.user && AC.status==='synced'", timeout=10000)
    check(a.evaluate("ACCT.user") == USER, 'signed in as the new account')
    check(a.evaluate("PROFILE.games.some(g=>g.id===%r)" % first), "this browser's game went into the account")
    check(a.evaluate("PROFILE.name") == 'Kal', 'and so did the name')
    a.screenshot(path='shots/a2-signed-in.png', full_page=True)
    second = a.evaluate(FINISH)
    a.wait_for_function("!(PROFILE.pending||[]).length", timeout=10000)
    check(True, 'a game finished while signed in is saved to the account')
    a.evaluate("()=>{ G=null; UI.screen='profile'; render(); }")

    print('another browser')
    bb.evaluate("()=>{ UI.screen='profile'; render(); }")
    bb.fill('[data-pf="user"]', USER); bb.fill('[data-pf="pass"]', 'wrong-one')
    bb.click('[data-act="acctin"]')
    bb.wait_for_selector('.acct-err', timeout=8000)
    check('Wrong' in bb.inner_text('.acct-err') and not bb.evaluate("!!ACCT"), 'a wrong password says so')
    bb.fill('[data-pf="pass"]', 'pass1234')
    bb.press('[data-pf="pass"]', 'Enter')
    bb.wait_for_function("ACCT && AC.status==='synced'", timeout=10000)
    ids = bb.evaluate("PROFILE.games.map(g=>g.id)")
    check(first in ids and second in ids and len(ids) == 2, 'signed in elsewhere: both games are there')
    check(bb.evaluate("PROFILE.name") == 'Kal' and bb.evaluate("profileName()") == 'Kal', 'and the name')
    check('2' in bb.inner_text('.pf-tiles'), 'the record counts them')
    bb.click('.pf-game'); bb.wait_for_selector('.sheet .log', timeout=8000)
    check(len(bb.inner_text('.sheet .log')) > 20, "a game's log loads from the account")
    bb.screenshot(path='shots/a3-other-browser.png')
    bb.evaluate("()=>{ UI.sheet=null; render(); }")
    bb.fill('[data-pf="name"]', 'Kal the Bold')
    bb.wait_for_timeout(1500)
    a.reload(); a.wait_for_function("LIB && ACCT && AC.status==='synced'", timeout=10000)
    check(a.evaluate("PROFILE.name") == 'Kal the Bold', 'a name changed on one browser shows on the other after a reload')
    a.evaluate("()=>{ LIB.settings.kinds=['human','bot']; LIB.settings.players=2; UI.screen='setup'; render(); }")
    check('Kal the Bold' in a.inner_text('.page'), 'and fills in the local setup')

    print('signing out')
    bb.evaluate("()=>{ UI.screen='profile'; render(); }")
    bb.click('[data-act="acctout"]'); bb.wait_for_timeout(300)
    check(not bb.evaluate("!!ACCT") and bb.evaluate("PROFILE.games.length") == 0, "signed out, this browser shows its own (empty) record")
    bb.reload(); bb.wait_for_function("LIB && LIB.cards.length>40")
    check(not bb.evaluate("!!ACCT"), 'and stays signed out after a reload')
    a.reload(); a.wait_for_function("LIB && ACCT && AC.status==='synced'", timeout=10000)
    check(a.evaluate("ACCT.user") == USER, 'the first browser is still signed in')
    b.close()

print('page errors:', errs[:5])
print(('%d failures' % len(fails)) if fails or errs else 'accounts ui: all checks passed')
sys.exit(1 if fails or errs else 0)
