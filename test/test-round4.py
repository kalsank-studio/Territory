# Real-browser checks for: the mulligan, unlocking while others place, the
# centred round banner, the passive-ability mark and its glow, "whenever you
# draw a card on your turn", and the Profile (name, record, match history).
#   (cd dist && python3 -m http.server 8123 &) ; python3 test/test-round4.py http://127.0.0.1:8123/
import sys, os
from playwright.sync_api import sync_playwright
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8123/'
os.makedirs('shots', exist_ok=True)
errs, fails = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)

SETUP = """(o)=>{
  Object.assign(LIB.settings, {players:2, planets:5, rounds:6, kinds:['human','bot','bot','bot'], placement:'turns', hide:false,
    sandbox:false, mulligan:true, turnTimer:0, turnTimerCustom:false, deckOf:[LIB.decks[0].id, LIB.decks[0].id]}, o||{});
  UI.screen='game'; UI.sheet=null; newGame(); }"""
WAIT_MY_PLACEMENT = """async ()=>{
  const sleep = ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<200;i++){ if(UI.diceGo) UI.diceGo(); const p=currentPlayer();
    if(G.phase==='placement' && p && p.idx===0 && !busy()) return true; await sleep(60); }
  return false; }"""
TO_MY_REVEAL = """async ()=>{
  const sleep = ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<240;i++){
    const p=currentPlayer();
    if(UI.diceGo) UI.diceGo();
    if(G.phase==='reveal' && p && p.idx===0 && !busy()){
      for(const f of faceDownOf(p)){ G.planets[f.planetIdx].board[0][f.slotIdx] = null; p.hand.push(f.card); }
      render(); return 'reveal';
    }
    if(G.phase==='placement' && p && p.idx===0 && !busy()){
      p.energy = Math.max(p.energy, 9);
      if(p.hand.length && !G.planets[4].board[0][2]) dispatch({t:'place', seat:0, uid:p.hand[0].uid, p:4, s:2});
      dispatch({t:'lock', seat:0});
    }
    await sleep(100);
  }
  return 'timeout';
}"""
PUT = """([id, planet, slot, faceUp])=>{
  const c = instance(defById(id), 0);
  G.planets[planet].board[0][slot] = c;
  if(faceUp){ c.faceUp = true; markInPlay(c); } else G.players[0].placed.push({uid:c.uid, planetIdx:planet, slotIdx:slot});
  render(); return c.uid; }"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':390, 'height':844}, device_scale_factor=2)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(url); pg.wait_for_function("LIB && LIB.cards.some(c=>c.id==='card-31')", timeout=8000)
    pg.evaluate("()=>{ PROFILE = {v:1, name:'', games:[]}; saveProfile(); }")

    print('profile name')
    pg.evaluate("()=>{ UI.screen='profile'; render(); }")
    pg.fill('[data-pf="name"]', 'Kal')
    check(pg.evaluate("profileName()") == 'Kal', 'the name is set in Profile')
    pg.evaluate("()=>{ UI.screen='online'; render(); }")
    check(pg.input_value('[data-on-input="name"]') == 'Kal', 'and fills in the online name')
    pg.evaluate("()=>{ LIB.settings.kinds=['human','bot','bot','bot']; LIB.settings.players=2; UI.screen='setup'; render(); }")
    check('Kal' in pg.inner_text('.page'), 'and the first seat in the local setup')

    print('mulligan')
    pg.evaluate(SETUP)
    check(pg.evaluate(WAIT_MY_PLACEMENT), 'my first placement turn')
    check(pg.evaluate("G.players[0].name") == 'Kal', 'my seat carries my profile name')
    before = pg.evaluate("G.players[0].hand.map(c=>c.uid)")
    check(pg.query_selector('[data-act="mulligan"]') is not None, 'round 1, nothing placed: "New hand" is offered')
    pg.click('[data-act="mulligan"]'); pg.wait_for_timeout(100)
    check('Redraw' in pg.inner_text('[data-act="mulligan"]'), 'the first tap asks to confirm')
    pg.screenshot(path='shots/m1-mulligan-ask.png')
    pg.click('[data-act="mulligan"]'); pg.wait_for_timeout(300)
    after = pg.evaluate("G.players[0].hand.map(c=>c.uid)")
    check(len(after) == len(before) and set(after) != set(before), f'a new hand of the same size ({len(after)} cards)')
    check(pg.query_selector('[data-act="mulligan"]') is None and pg.evaluate("dispatch({t:'mulligan', seat:0}).ok") is False, 'only once a game')
    check(pg.evaluate("G.players[0].deck.length + G.players[0].hand.length") == pg.evaluate("deckById(LIB.decks[0].id).cards.length"), 'no card is lost or doubled')

    print('banner')
    m = pg.evaluate("""()=>{ const r=document.querySelector('.hud .round'), mid=document.querySelector('.hud-mid').getBoundingClientRect();
        return {fs: parseFloat(getComputedStyle(r).fontSize), center: mid.left + mid.width/2, vw: innerWidth}; }""")
    check(m['fs'] >= 20, f"the round reads larger ({m['fs']}px)")
    check(abs(m['center'] - m['vw']/2) < 3, f"and sits in the middle of the banner ({m['center']:.0f} of {m['vw']})")
    pg.screenshot(path='shots/m2-banner.png')

    print('unlock while someone is still placing')
    pg.evaluate("()=>{ window.__botAct = botAct; botAct = ()=>{}; }")   # hold the bot, so it is still placing
    pg.evaluate(SETUP, {'placement':'simultaneous'})
    check(pg.evaluate(WAIT_MY_PLACEMENT), 'placing at once')
    pg.evaluate("()=>{ dispatch({t:'lock', seat:0}); render(); }")
    pg.wait_for_selector('[data-act="unlock"]', timeout=3000)
    check(True, 'locked in, with the bot still placing: "Unlock" is offered')
    pg.screenshot(path='shots/m3-unlock.png')
    pg.click('[data-act="unlock"]'); pg.wait_for_timeout(200)
    check(pg.evaluate("!G.players[0].locked && currentPlayer() && currentPlayer().idx===0"), 'unlocking gives the turn back')
    pg.evaluate("()=>{ dispatch({t:'lock', seat:0}); botAct = window.__botAct; botAct(1); }")
    pg.wait_for_timeout(300)
    check(pg.evaluate("G.players.every(p=>p.locked) || G.phase==='reveal'") and pg.evaluate("dispatch({t:'unlock', seat:0}).ok") is False, 'once everyone is in, it cannot be undone')

    print('passive mark and glow')
    pg.evaluate(SETUP)
    check(pg.evaluate(TO_MY_REVEAL) == 'reveal', 'reached my reveal turn')
    rev = pg.evaluate(PUT, ['card-31', 0, 0, True])           # Revenant: whenever a card goes to the graveyard
    pg.evaluate("()=>{ G.players[0].hand.push(instance(defById('card-22'),0)); render(); }")   # Ceramanic in hand: when destroyed
    check(pg.query_selector(f'.slot .mini[data-uid="{rev}"] .pass-chip') is not None, 'a passive card on the board has the mark')
    check(pg.evaluate("document.querySelectorAll('.tray .card .pass-chip').length") >= 1, 'and so does one in hand')
    pos = pg.evaluate(f"""()=>{{ const m=document.querySelector('.mini[data-uid="{rev}"]').getBoundingClientRect(), c=document.querySelector('.mini[data-uid="{rev}"] .pass-chip').getBoundingClientRect();
        return {{mid: (c.left + c.width/2) - (m.left + m.width/2), bottom: m.bottom - c.bottom, w: m.width}}; }}""")
    check(abs(pos['mid']) < pos['w']/4 and pos['bottom'] < 30, 'centred near the bottom, between art and name (0.8): ' + str(pos))
    pg.evaluate("()=>{ LIB.settings.anim = true; }")
    pg.evaluate("()=>{ const q=G.players[0]; discardCard(0, q.hand.find(c=>c.def!=='card-22')); processQueue(); }")
    pg.wait_for_timeout(120)
    glow = pg.evaluate(f"()=>!!UI.fx.glow['{rev}'] && !!document.querySelector('.slot.fx-target .mini[data-uid=\"{rev}\"], .fx-target [data-uid=\"{rev}\"]')")
    check(glow, 'when its ability fires, the card glows')
    pg.wait_for_timeout(900)
    check(pg.evaluate(f"powerOf(findCardByUid('{rev}'))") == pg.evaluate("defById('card-31').power") + 1, 'and the ability did its work')
    pg.screenshot(path='shots/m4-passive.png')

    print('whenever you draw on your turn')
    pg.evaluate("""()=>{ LIB.cards.push({id:'t-dw', name:'Drawwatch', cost:1, power:1, rarity:'basic', art:{t:'emoji', v:'eye'},
        fx:[{v:'givePower', t:'self', n:1, when:'youDraw'}]}); }""")
    t = pg.evaluate("fxText(defById('t-dw').fx)")
    check(t == 'Whenever you draw a card on your turn: Give this card +1 Power.', 'it reads: ' + t)
    back = pg.evaluate("JSON.stringify(parseAbility('Whenever you draw a card on your turn: give this card +1 Power.').fx)")
    check('"when":"youDraw"' in back, 'and reads back')
    pg.evaluate(SETUP)
    check(pg.evaluate(TO_MY_REVEAL) == 'reveal', 'reached my reveal turn')
    dw = pg.evaluate(PUT, ['t-dw', 0, 0, True])
    atlas = pg.evaluate(PUT, ['card-10', 1, 0, False])        # Atlas: draw a card
    pg.evaluate("()=>{ G.players[0].energy = 9; render(); }")
    pg.evaluate("uid=>dispatch({t:'flip', seat:0, uid})", atlas)
    pg.wait_for_timeout(1500)
    check(pg.evaluate(f"powerOf(findCardByUid('{dw}'))") == 2, 'an ability draw on your turn sets it off')
    before = pg.evaluate(f"powerOf(findCardByUid('{dw}'))")
    pg.evaluate("()=>{ drawCard(G.players[0]); processQueue(); }")  # a plain draw (as the round's own draw is)
    pg.wait_for_timeout(300)
    check(pg.evaluate(f"powerOf(findCardByUid('{dw}'))") == before, "the round's own draw doesn't")

    print('the record')
    pg.evaluate(SETUP)
    check(pg.evaluate(WAIT_MY_PLACEMENT), 'a game to finish')
    pg.evaluate("()=>{ finishGame(); }")
    pg.wait_for_timeout(200)
    g = pg.evaluate("PROFILE.games[0]")
    check(g and g['seat'] == 0 and g['result'] in ('win','loss','draw') and len(g['won']) == 2 and g['log'], 'the finished game is recorded with its planets and log')
    pg.evaluate(SETUP, {'sandbox':True})
    pg.evaluate("()=>{ finishGame(); }")
    check(pg.evaluate("PROFILE.games.length") == 1, 'a sandbox game is not')
    pg.evaluate("()=>{ G=null; UI.screen='title'; render(); }")
    check('Profile' in pg.inner_text('.title-actions'), 'the title has a Profile button')
    pg.click('[data-act="go"][data-screen="profile"]'); pg.wait_for_timeout(150)
    txt = pg.inner_text('.page')
    check('played' in txt and 'Match history' in txt and pg.query_selector('.pf-game') is not None, 'Profile shows the record and the history')
    pg.screenshot(path='shots/m5-profile.png', full_page=True)
    pg.click('.pf-game'); pg.wait_for_timeout(150)
    check(pg.query_selector('.sheet .log') is not None and pg.query_selector('.sheet .score-line') is not None, 'a game opens with its planet scores and log')
    pg.screenshot(path='shots/m6-history.png')
    pg.reload(); pg.wait_for_function("LIB && LIB.cards.length>10")
    check(pg.evaluate("PROFILE.games.length") == 1 and pg.evaluate("profileName()") == 'Kal', 'it is all still there after a reload')
    b.close()

print('page errors:', errs[:5])
print(('%d failures' % len(fails)) if fails or errs else 'round 4: all checks passed')
sys.exit(1 if fails or errs else 0)
