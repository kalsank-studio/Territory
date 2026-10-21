# Online play end to end: two (or three) real browsers, each with its own storage,
# through a local Worker (wrangler dev) — lobby, a whole game, hidden information,
# a dropped connection, a guest reload, a host reload, and a bot standing in.
#   npm run build && npx wrangler dev --port 8799 &   then   python3 test/test-online.py http://127.0.0.1:8799/
# Screenshots go to shots/.
import sys, os, time, json
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8799/'
os.makedirs('shots', exist_ok=True)
fails, errs = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)

# One step of "playing sensibly" for whoever is at this device. Returns what it did.
STEP = """()=>{
  if(!G || UI.screen!=='game' || G.over) return G && G.over ? 'over' : 'idle';
  const me = G.isView ? G.viewer : NET.seat;
  const p = G.players[me];
  const sheet = document.querySelector('.sheet.choice');
  if(sheet){
    const b = sheet.querySelector('.hand [data-act], .stack [data-act]:not([disabled]), .opt-row [data-act]');
    if(b){ b.click(); return 'chose'; }
  }
  const pick = document.querySelector('.slot.pickable, .slot.summon-target');
  if(pick){ pick.click(); return 'picked'; }
  if(G.choice || busy() || G.hold) return 'wait';
  if(G.phase==='placement' && !p.locked){
    const room = []; G.planets.forEach((pl,pi)=>pl.board[me].forEach((c,si)=>{ if(!c) room.push([pi,si]); }));
    const c = p.hand.find(c=>!c.hidden && p.planned + c.cost <= p.energy);
    if(c && room.length && p.placed.length < 2){ const [pi,si] = room[Math.floor(Math.random()*room.length)]; dispatch({t:'place', seat:me, uid:c.uid, p:pi, s:si}); return 'place'; }
    dispatch({t:'lock', seat:me}); return 'lock';
  }
  if(G.phase==='reveal' && G.order[G.revealer]===me){
    const down = faceDownOf(p);
    if(down.length){ dispatch({t:'flip', seat:me, uid:down[0].card.uid}); return 'flip'; }
    dispatch({t:'endReveal', seat:me}); return 'end';
  }
  return 'idle';
}"""

def play(pages, until, limit=240):
    t0 = time.time()
    while time.time() - t0 < limit:
        for pg in pages:
            try: pg.evaluate(STEP)
            except Exception as e: pass
        if until(): return True
        pages[0].wait_for_timeout(250)
    return False

with sync_playwright() as pw:
    b = pw.chromium.launch()
    def page(name):
        ctx = b.new_context(viewport={'width':430, 'height':900}, device_scale_factor=2)
        pg = ctx.new_page()
        pg.on('pageerror', lambda e, n=name: errs.append(n+': '+str(e)))
        pg.on('console', lambda m, n=name: errs.append(n+': '+m.text) if m.type=='error' and 'fonts' not in m.text and 'ERR_TUNNEL' not in m.text and 'Failed to load resource' not in m.text else None)
        pg.goto(BASE); pg.wait_for_function("LIB && LIB.cards.length > 40", timeout=10000)
        return ctx, pg
    hctx, host = page('host')
    gctx, guest = page('guest')

    print('lobby')
    host.click('[data-on="open"]'); host.fill('[data-on-input="name"]', 'Kal')
    host.click('[data-on="host"]')
    host.wait_for_selector('.room-code', timeout=10000)
    code = host.evaluate('ON.code')
    check(len(code) == 5, 'the host gets a room code: ' + code)
    host.screenshot(path='shots/o1-host-lobby.png')
    guest.goto(BASE + '?room=' + code); guest.wait_for_selector('[data-on-input="code"]')
    check(guest.input_value('[data-on-input="code"]') == code, 'an invite link fills in the code')
    guest.fill('[data-on-input="name"]', 'Sam'); guest.click('[data-on="join"]')
    guest.wait_for_selector('.lobby-seat', timeout=10000)
    host.wait_for_function("ON.seats.some(s=>s.seat===1 && s.online)", timeout=5000)
    check('Sam' in host.inner_text('.lobby-seats'), 'the host sees Sam join')
    check('Kal' in guest.inner_text('.lobby-seats'), 'Sam sees the host in the lobby')
    # the guest picks a deck from the host's list
    decks = guest.evaluate('ON.decks.map(d=>d.id)')
    guest.select_option('select[data-on-input="deck"]', decks[-1])
    host.wait_for_function(f"ON.lobby.seats[1].deck==='{decks[-1]}'", timeout=5000)
    check(True, 'the guest’s deck choice reaches the host')
    guest.screenshot(path='shots/o2-guest-lobby.png')
    host.select_option('[data-on-input="turnTimer"]', '60')
    guest.wait_for_function("ON.lobby && ON.lobby.turnTimer===60", timeout=5000)
    check(True, 'lobby settings reach the guest')
    host.click('[data-on="start"]')
    guest.wait_for_function("G && G.isView && UI.screen==='game'", timeout=10000)
    check(guest.evaluate("G.players.map(p=>p.name).join(',')") == 'Kal,Sam', 'both devices are in the game, with names')
    check(guest.evaluate("G.simul && G.online"), 'online: everyone places at once')

    print('hidden information')
    host.wait_for_function("G.phase==='placement' && !busy()", timeout=15000)
    guest.wait_for_function("G.phase==='placement' && !busy()", timeout=15000)
    leak = guest.evaluate("""()=>({
      oppHandHidden: G.players[0].hand.every(c=>c.hidden && !c.name),
      decksHidden: G.players.every(p=>p.deck.every(c=>c.hidden && !c.uid)),
      noSeed: G.seed===undefined && G.rng===undefined && G.cmdLog===undefined,
      myHand: G.players[1].hand.every(c=>c.name) })""")
    check(all(leak.values()), 'the guest’s view hides the host’s hand, every deck and the seed: ' + json.dumps(leak))
    # the guest places a card: the host sees it face down nowhere (placing at once hides it)
    guest.evaluate("()=>{ const p=G.players[1]; p.hand.find(c=>c.cost<=p.energy) }")
    r = guest.evaluate("""()=>{ const p=G.players[1]; const c=p.hand.find(c=>c.cost<=p.energy); if(!c) return 'none';
                          const ok = dispatch({t:'place', seat:1, uid:c.uid, p:0, s:0}).ok; return ok ? c.uid : 'refused'; }""")
    if r not in ('none', 'refused'):
        host.wait_for_function(f"G.planets[0].board[1][0] && G.planets[0].board[1][0].uid==='{r}'", timeout=5000)
        check(True, 'a guest’s placement reaches the host’s game')
        check(host.query_selector(f'.mini[data-uid="{r}"]') is None, '…and the host’s screen doesn’t show it while placing at once')
    bad = guest.evaluate("dispatch({t:'place', seat:1, uid:'nope', p:0, s:0})")
    check(bad['ok'] is False, 'an impossible move is refused on the guest before it is sent')
    host.screenshot(path='shots/o3-host-placing.png'); guest.screenshot(path='shots/o4-guest-placing.png')

    print('a round, with clocks')
    check(guest.query_selector('[data-timer]') is not None, 'the guest shows the host’s turn clock')
    ok = play([host, guest], lambda: host.evaluate("G.round>=2 && G.phase==='placement'"), 120)
    check(ok, 'round 1 plays through on both devices')
    guest.wait_for_function("G && G.round>=2", timeout=5000)
    check(guest.evaluate("G.round") == host.evaluate("G.round"), 'the guest follows the round')

    print('a dropped connection')
    guest.evaluate("dropAndRetry()")          # what the liveness check does when a phone's socket goes quiet
    host.wait_for_function("ON.seats.some(s=>s.seat===1 && !s.online)", timeout=8000)
    check(True, 'the host hears the guest drop')
    guest.wait_for_function("ON.retries>0 || ON.status!=='open'", timeout=20000)
    guest.wait_for_function("ON.status==='open'", timeout=20000)
    host.wait_for_function("ON.seats.some(s=>s.seat===1 && s.online)", timeout=8000)
    check(guest.evaluate("ON.seat") == 1, 'the guest reconnects to the same seat by itself')

    print('a guest reload')
    guest.reload(); guest.wait_for_function("G && G.isView && UI.screen==='game'", timeout=15000)
    check(guest.evaluate("G.viewer") == 1 and guest.evaluate("G.round") == host.evaluate("G.round"), 'after a reload the guest is straight back in the game')

    ok = play([host, guest], lambda: host.evaluate("G.round>=3 && G.phase==='placement'"), 120)
    check(ok, 'round 2 plays through')

    print('a host reload')
    host.wait_for_function("!busy() && !G.hold", timeout=10000); host.wait_for_timeout(700)
    rd = host.evaluate("G.round")
    saved_rd = host.evaluate("(JSON.parse(localStorage.getItem(HOSTGAME_KEY)||'{}').g||{}).round")
    print('    round', rd, 'saved', saved_rd)
    host.wait_for_timeout(800)
    host.reload()
    host.wait_for_function("G && G.online && !G.isView && UI.screen==='game' && ON.status==='open'", timeout=15000)
    check(host.evaluate("G.round") == rd, 'the host resumes the same game after a reload')
    guest.wait_for_function("ON.seats.some(s=>s.seat===0 && s.online)", timeout=8000)
    ok = play([host, guest], lambda: host.evaluate("G.round>=4"), 120)
    check(ok, 'the game carries on after the host comes back')

    print('a bot stands in')
    gctx.close()
    host.wait_for_selector('[data-on="standin"]', timeout=10000)
    host.screenshot(path='shots/o5-host-dropped.png')
    host.click('[data-on="standin"]')
    check(host.evaluate("G.players[1].kind==='bot' && G.players[1].standIn"), 'the host can let a bot play for a player who left')
    ok = play([host], lambda: host.evaluate("G.over"), 240)
    check(ok, 'the game finishes with the bot in the seat')
    host.screenshot(path='shots/o6-host-result.png')

    print('the guest comes back to a finished game, then everyone goes again')
    gctx, guest = page('guest2')
    # a fresh device can't take seat 1 back without its token: the room is full
    guest.goto(BASE + '?room=' + code); guest.fill('[data-on-input="name"]', 'Sam'); guest.click('[data-on="join"]')
    guest.wait_for_timeout(1500)
    check('full' in guest.inner_text('#app').lower(), 'without its token a new device can’t take a held seat')
    host.click('[data-on="lobby"]')
    host.wait_for_selector('.room-code', timeout=5000)
    check(host.evaluate("G===null && UI.screen==='online'"), 'the host takes the room back to the lobby')

    print('three players')
    hctx.close(); gctx.close()
    hctx, host = page('host3'); ctx2, g2 = page('g2'); ctx3, g3 = page('g3')
    host.click('[data-on="open"]'); host.fill('[data-on-input="name"]', 'Ana')
    host.select_option('[data-on-input="seats"]', '3'); host.click('[data-on="host"]')
    host.wait_for_selector('.room-code'); code3 = host.evaluate('ON.code')
    for g, n in ((g2, 'Bo'), (g3, 'Cy')):
        g.goto(BASE + '?room=' + code3); g.fill('[data-on-input="name"]', n); g.click('[data-on="join"]'); g.wait_for_selector('.lobby-seat')
    host.wait_for_function("ON.seats.filter(s=>s.online).length===3", timeout=8000)
    host.click('[data-on="start"]')
    for g in (g2, g3): g.wait_for_function("G && G.isView", timeout=10000)
    ok = play([host, g2, g3], lambda: host.evaluate("G.over"), 900)
    check(ok, 'a three-player online game plays to the end')
    res = host.evaluate("JSON.stringify(G.result.won)")
    g2.wait_for_function("G && G.over", timeout=8000)
    check(g2.evaluate("JSON.stringify(G.result.won)") == res, 'every device agrees on the result: ' + res)
    g3.screenshot(path='shots/o7-guest-result.png')
    b.close()

print('page errors:', errs[:8])
print(('%d failures' % len(fails)) if fails or errs else 'online: all checks passed')
sys.exit(1 if fails or errs else 0)
