# The tutorial in a real browser: every rules page, then the guided game played
# by tapping exactly what the coach highlights, through to the win.
#   npm run build && (cd dist && python3 -m http.server 8123) &   then   python3 test/test-tutorial.py http://127.0.0.1:8123/
import sys, os
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8123/'
os.makedirs('shots', exist_ok=True)
fails, errs = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)
with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(viewport={'width':390, 'height':844}, device_scale_factor=2)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE); pg.wait_for_function("LIB && LIB.cards.length > 40", timeout=10000)
    before = pg.evaluate("JSON.stringify(LIB).length")
    print('rules pages')
    pg.click('[data-screen="tutorial"]')
    n = pg.evaluate("TUTOR_PAGES.length")
    for i in range(n):
        pg.wait_for_selector(f'[data-ak="tut:{i}"]')
        if i in (1, 2, 4): pg.screenshot(path=f'shots/t-page{i+1}.png', full_page=True)
        if i < n-1: pg.click('.tut-nav > .btn.primary')
    check(True, f'{n} pages of rules')
    pg.evaluate("()=>{ document.documentElement.dataset.theme='dark'; render(); }")
    pg.screenshot(path='shots/t-page-last-dark.png')
    pg.evaluate("()=>{ document.documentElement.dataset.theme='light'; render(); }")
    pg.click('.tut-page [data-act="tutplay"]')
    pg.wait_for_function("G && G.tutorial && UI.screen==='game'")
    check(pg.evaluate("G.planets.map(p=>p.name).join()") == 'Verdant Shelf,Silt Hollow,Ember Ridge,Ashen Gate', 'the lesson board is laid out')

    print('the guided game')
    DRIVE = """()=>{
      if(!G || G.over) return 'over';
      if(busy() && !G.choice) return 'busy';
      const st = tutStep(); if(!st) return 'nostep';
      if(st.info){ const b = document.querySelector('[data-act="tutnext"]'); if(b){ b.click(); return 'next'; } return 'wait'; }
      const mine = G.phase==='placement' ? placingSeats().includes(0) : revealerSeat()===0;
      if(!mine && !G.choice) return 'wait';
      const t = tutTarget(), d = st.do;
      if(d.t==='place'){
        const card = document.querySelector('.hand [data-uid="'+t.uid+'"]');
        if(!card) return 'nocard';
        if(UI.sel!==t.uid){ card.click(); return 'sel'; }
        const slot = document.querySelector('[data-sp="'+t.sp+'"]'); if(!slot) return 'noslot'; slot.click(); return 'placed';
      }
      if(d.t==='lock'||d.t==='end'){ const b = document.querySelector(t.sel); if(!b) return 'nobtn'; b.click(); return d.t; }
      if(d.t==='flip'){ const el = document.querySelector('[data-act="flip"][data-uid="'+t.uid+'"]'); if(!el) return 'noflip'; el.click(); return 'flip'; }
      if(d.t==='activate'){
        const sh = document.querySelector('.sheet [data-act="activate"][data-uid="'+t.uid+'"]'); if(sh){ sh.click(); return 'activated'; }
        const el = document.querySelector('[data-act="activate"][data-uid="'+t.uid+'"]'); if(!el) return 'noact'; el.click(); return 'tapact';
      }
      if(d.t==='discard'){ const el = document.querySelector('.sheet [data-uid="'+t.uid+'"][data-act]') ; if(!el) return 'nodisc'; el.click(); return 'disc'; }
      if(d.t==='pick'){ const el = document.querySelector('.slot.pickable [data-uid="'+t.uid+'"]') || document.querySelector('[data-uid="'+t.uid+'"].pickable') || [...document.querySelectorAll('.slot.pickable')].find(s=>s.querySelector('[data-uid="'+t.uid+'"]')); if(!el) return 'nopick'; (el.closest('.slot')||el).click(); return 'pick'; }
      if(d.t==='slot'){ const el = document.querySelector('.slot.summon-target[data-sp="'+t.sp+'"]'); if(!el) return 'nosum'; el.click(); return 'summon'; }
      return 'unknown';
    }"""
    shots = {3:'t-g1-place', 7:'t-g2-harvest', 11:'t-g3-discard', 28:'t-g4-sahel', 38:'t-g5-summon'}
    stuck, last, t0 = 0, None, 0
    # a wrong move is refused
    pg.wait_for_function("tutStep() && !busy()", timeout=15000)
    for i in range(1500):
        stp = pg.evaluate("TUT.step")
        if stp in shots and pg.evaluate("!busy() || !!G.choice"):
            pg.wait_for_timeout(300); pg.screenshot(path='shots/'+shots.pop(stp)+'.png')
        if stp == 2 and not t0:
            bad = pg.evaluate("()=>{ const u = G.players[0].hand.find(c=>c.name==='Blade').uid; return dispatch({t:'place', seat:0, uid:u, p:1, s:0}).why; }")
            check(bad == 'tutorial', 'a move the coach didn’t ask for is refused')
            t0 = 1
        r = pg.evaluate(DRIVE)
        if r == 'over': break
        if r in ('wait','busy','sel'): stuck = stuck + 1 if r == last else 0
        last = r
        if r.startswith('no'): print('    step', stp, r, pg.evaluate("JSON.stringify({ph:G.phase,r:G.round,ch:G.choice&&G.choice.kind})"))
        pg.wait_for_timeout(250)
    pg.wait_for_function("G && G.over", timeout=30000)
    res = pg.evaluate("JSON.stringify(G.result.won)")
    check(res == '[3,1]', 'the lesson ends in a 3–1 win: ' + res)
    check(pg.evaluate("TUT.step") == pg.evaluate("TUTOR_STEPS.length"), 'every coach step was used')
    pg.wait_for_selector('.tut-done'); pg.screenshot(path='shots/t-g6-done.png', full_page=True)
    check(pg.evaluate("PROFILE.games.length") == 0, 'the lesson isn’t added to the match history')
    pg.click('.tut-done [data-act="tutexit"][data-v="title"]')
    check(pg.evaluate("UI.screen==='title' && !G && LIB.cards.length > 40 && JSON.stringify(LIB).length") == before, 'your own library is back, unchanged')
    b.close()
print('page errors:', errs[:6])
print(('%d failures' % len(fails)) if fails or errs else 'tutorial: all checks passed')
sys.exit(1 if fails or errs else 0)
