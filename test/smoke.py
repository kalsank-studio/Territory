# Real-browser smoke test: setup screen, a simultaneous game vs a bot (lock bar,
# hidden placements), and a hot-seat game (hand-over screen). Screenshots in shots/.
import sys, time
from playwright.sync_api import sync_playwright
url = 'file://' + sys.argv[1]
errs = []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':430, 'height':900}, device_scale_factor=2)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' and 'fonts' not in m.text else None)
    pg.goto(url); pg.wait_for_timeout(300)
    pg.evaluate("""LIB.settings.players=2; LIB.settings.kinds=['human','bot','bot','bot']; LIB.settings.placement='simultaneous';
                   LIB.settings.deckOf=['d3','d3','d3','d3']; LIB.settings.sandbox=false; LIB.settings.turnTimer=0; UI.screen='setup'; render();""")
    pg.wait_for_timeout(200); pg.screenshot(path='shots/1-setup-simul.png', full_page=True)
    pg.click('[data-act="begin"]')
    pg.wait_for_function("G && !busy() && G.players[1].locked", timeout=20000)   # the opening, dice, then the bot places and locks in
    pg.wait_for_timeout(300)
    pg.screenshot(path='shots/2-simul-placing.png')
    st = pg.evaluate("({simul:G.simul, phase:G.phase, botLocked:G.players[1].locked, backs:document.querySelectorAll('.planet .side:not(.mine) .mini.back').length, chips:document.querySelectorAll('.lockchip').length})")
    print('simul game', st)
    # place two cards by tapping, then lock in
    for _ in range(2):
        cards = pg.query_selector_all('.tray .card[data-act="hand"]:not(.unaffordable)')
        if not cards: break
        cards[0].click(); pg.wait_for_timeout(150)
        slots = pg.query_selector_all('.slot[data-act="drop"]')
        if not slots: break
        slots[0].click(); pg.wait_for_timeout(150)
    pg.screenshot(path='shots/3-simul-placed.png')
    pg.click('[data-act="endturn"]'); pg.wait_for_timeout(500)
    pg.screenshot(path='shots/4-simul-locked.png')
    pg.wait_for_timeout(2500)
    st = pg.evaluate("({phase:G.phase, backs:document.querySelectorAll('.planet .side:not(.mine) .mini.back').length, log:G.cmdLog.length})")
    print('after lock', st)
    pg.screenshot(path='shots/5-reveal.png')
    # hot-seat: two humans take turns behind the hand-over screen
    pg.evaluate("""LIB.settings.kinds=['human','human','bot','bot']; LIB.settings.hide=true; UI.screen='setup'; render();""")
    pg.wait_for_timeout(200); pg.screenshot(path='shots/6-setup-hotseat.png', full_page=True)
    pg.click('[data-act="begin"]'); pg.wait_for_function("G && !UI.intro && !UI.dice", timeout=20000); pg.wait_for_timeout(300)
    st = pg.evaluate("({simul:G.simul, gate:UI.gate, veil:!!document.querySelector('.veil')})")
    print('hot-seat', st)
    pg.screenshot(path='shots/7-hotseat-veil.png')
    b.close()
print('errors:', errs[:5])
