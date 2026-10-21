# Social in real browsers: two accounts become friends, one hosts and invites
# the other, who gets a pop-up and joins; comments on a past game.
#   npm run build && npx wrangler dev --port 8799 &   then   python3 test/test-social-ui.py http://127.0.0.1:8799/
import sys, os, random, string
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8799/'
os.makedirs('shots', exist_ok=True)
fails, errs = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)
tag = ''.join(random.choice(string.ascii_lowercase) for _ in range(5))
A, B = 'ana' + tag, 'bo' + tag
FINISH = """()=>{ Object.assign(LIB.settings, {players:2, kinds:['human','bot'], placement:'turns', sandbox:false, turnTimer:0, hide:false});
  UI.screen='game'; newGame(); finishGame(); G=null; UI.screen='title'; render(); return PROFILE.games[0].id; }"""
with sync_playwright() as pw:
    b = pw.chromium.launch()
    def page(name, theme='light'):
        ctx = b.new_context(viewport={'width':390, 'height':844}, device_scale_factor=2, color_scheme=theme)
        pg = ctx.new_page()
        pg.on('pageerror', lambda e, n=name: errs.append(n+': '+str(e)))
        pg.goto(BASE); pg.wait_for_function("LIB && LIB.cards.length > 40", timeout=10000)
        return ctx, pg
    actx, a = page('A'); bctx, bb = page('B', 'dark')
    for pg, u in ((a, A), (bb, B)):
        pg.evaluate("()=>{ UI.screen='profile'; render(); }")
        pg.fill('[data-pf="user"]', u); pg.fill('[data-pf="pass"]', 'pass1234'); pg.click('[data-act="acctnew"]')
        pg.wait_for_function("ACCT && AC.status==='synced'", timeout=10000)
    gid = a.evaluate(FINISH)
    a.wait_for_function("!(PROFILE.pending||[]).length", timeout=10000)

    print('finding a friend')
    a.evaluate("()=>{ UI.screen='social'; render(); }")
    a.wait_for_selector('[data-so="q"]')
    a.fill('[data-so="q"]', B[:5])
    a.wait_for_selector(f'[data-act="sorequest"][data-u="{B}"]', timeout=8000)
    check(a.evaluate("document.activeElement.dataset.so==='q'"), 'search keeps the caret in the box')
    a.screenshot(path='shots/s1-search.png')
    a.click(f'[data-act="sorequest"][data-u="{B}"]')
    a.wait_for_function("SO.data && SO.data.outgoing.length===1", timeout=8000)
    check(True, 'request sent')
    bb.evaluate("()=>{ UI.screen='social'; SO.data=null; render(); }")
    bb.wait_for_selector(f'[data-act="soaccept"][data-u="{A}"]', timeout=8000)
    bb.screenshot(path='shots/s2-request-dark.png')
    bb.click(f'[data-act="soaccept"][data-u="{A}"]')
    bb.wait_for_function("SO.data && SO.data.friends.length===1", timeout=8000)
    check(True, 'Bo accepts')

    print("a friend's profile and comments")
    bb.click(f'[data-act="souser"][data-u="{A}"]')
    bb.wait_for_selector('.pf-game', timeout=8000)
    check('1' in bb.inner_text('.pf-tiles'), "Bo sees Ana's record")
    bb.click('.pf-game'); bb.wait_for_selector('[data-so="draft"]', timeout=8000)
    bb.fill('[data-so="draft"]', 'Good game!'); bb.press('[data-so="draft"]', 'Enter')
    bb.wait_for_function("SO.comments && SO.comments.length===1", timeout=8000)
    check('Good game!' in bb.inner_text('.so-comments'), 'Bo comments on her game')
    check(bb.query_selector('[data-act="sowatch"]') is not None, '…and could watch its replay')
    bb.screenshot(path='shots/s3-friend-game-dark.png')
    bb.evaluate("()=>{ UI.sheet=null; render(); }")
    a.evaluate("()=>{ UI.screen='profile'; render(); }"); a.click('.pf-game')
    a.wait_for_selector('.so-comment', timeout=8000)
    check('Good game!' in a.inner_text('.so-comments'), 'Ana sees it on her own game')
    a.click('[data-act="sodelc"]'); a.wait_for_function("SO.comments && SO.comments.length===0", timeout=8000)
    check(True, 'and can delete it')
    a.evaluate("()=>{ UI.sheet=null; render(); }")

    print('hosting and inviting')
    a.evaluate("()=>{ UI.screen='online'; render(); }")
    a.click('[data-on="host"]'); a.wait_for_selector('.room-code', timeout=10000)
    code = a.evaluate('ON.code')
    a.wait_for_selector(f'.lobby-invite [data-act="soinvite"][data-u="{B}"]', timeout=8000)
    a.screenshot(path='shots/s4-lobby-invite.png')
    a.click(f'.lobby-invite [data-act="soinvite"][data-u="{B}"]')
    a.wait_for_function(f"SO.invited['{B}']==='{code}'", timeout=8000)
    bb.evaluate("()=>{ UI.screen='title'; render(); clearTimeout(SO.pollT); SO.pollT=null; socialPollStart(); }")
    bb.wait_for_selector('.invite-pop', timeout=10000)
    check(code in bb.inner_text('.invite-pop'), 'Bo gets a pop-up with the room')
    bb.screenshot(path='shots/s5-invite-pop-dark.png')
    bb.click('.invite-pop [data-act="sojoin"]')
    bb.wait_for_selector('.lobby-seat', timeout=10000)
    a.wait_for_function("ON.seats.some(s=>s.seat===1 && s.online)", timeout=8000)
    check(True, 'Bo joins from the invite')
    b.close()
print('page errors:', errs[:6])
print(('%d failures' % len(fails)) if fails or errs else 'social ui: all checks passed')
sys.exit(1 if fails or errs else 0)
