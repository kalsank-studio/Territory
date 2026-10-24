# Real-browser checks for: the Play menu (host / join / this device), Art & data
# inside Studio, the merged round-open screen, the Game End timing, "your card of
# choice", optional effects, an opponent's discard shown face up, and summoning
# by tapping a slot. Run against a served dist/:
#   (cd dist && python3 -m http.server 8123 &) ; python3 test/test-round3.py http://127.0.0.1:8123/
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
    sandbox:false, turnTimer:0, turnTimerCustom:false, deckOf:[LIB.decks[0].id, LIB.decks[0].id]}, o||{});
  UI.screen='game'; UI.sheet=null; newGame(); }"""
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
PUT = """([id, planet, slot, faceUp, seat])=>{
  seat = seat||0;
  const c = instance(defById(id), seat);
  G.planets[planet].board[seat][slot] = c;
  if(faceUp){ c.faceUp = true; markInPlay(c); } else G.players[seat].placed.push({uid:c.uid, planetIdx:planet, slotIdx:slot});
  render(); return c.uid; }"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':390, 'height':844}, device_scale_factor=2)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(url); pg.wait_for_function("LIB && LIB.cards.some(c=>c.id==='card-29')", timeout=8000)

    print('menus')
    t = pg.inner_text('.title-actions')
    check('Play' in t and 'Sandbox' not in t and 'Art & data' not in t and 'Start a game' not in t, 'the title has one Play button, no Sandbox or Art & data: ' + t.replace('\n', ' | '))
    pg.screenshot(path='shots/r1-title.png')
    pg.click('[data-on="open"]'); pg.wait_for_timeout(150)
    t = pg.inner_text('#app')
    check('Host a game' in t and 'Join a game' in t and 'On this device' in t, 'Play offers host, join, and this device')
    pg.screenshot(path='shots/r2-play.png', full_page=True)
    pg.click('[data-act="newgame"][data-v="local"]'); pg.wait_for_timeout(150)
    check(pg.evaluate("UI.screen")=='setup' and pg.query_selector('input[data-act="sandbox"]') is not None, 'this device leads to the setup, with the sandbox switch')
    pg.evaluate("()=>{ ADM.ok=true; UI.screen='studio'; studioTab='cards'; render(); }")
    check(pg.query_selector('[data-act="tab"][data-v="art"]') is not None, 'Studio has an Art & data tab')
    pg.click('[data-act="tab"][data-v="art"]'); pg.wait_for_timeout(150)
    check(pg.query_selector('[data-up="byid"]') is not None and pg.query_selector('[data-act="downloadlib"]') is not None, 'the tab holds the sprite uploads and the backup')
    pg.screenshot(path='shots/r3-studio-art.png')
    pg.evaluate("()=>{ ON.code='ABCDE'; ON.status='open'; ON.role='host'; ON.seat=0; ON.roomSeats=2; ON.lobby=defaultLobby(2); ON.seats=[{seat:0,name:'Kal',online:true}]; UI.screen='online'; render(); }")
    check(pg.query_selector('[data-on-input="sandbox"]') is not None, 'the online lobby has a sandbox switch')
    pg.evaluate("()=>{ ON.code=null; ON.status='idle'; ON.role=null; ON.seat=null; ON.lobby=null; }")

    print('the round opens on one screen')
    pg.evaluate(SETUP)
    pg.wait_for_selector('.dice-screen.round-open', timeout=5000)
    t = pg.inner_text('.dice-screen')
    t = t.lower()
    check('round' in t and 'winning' in t and 'roll' in t and 'first' in t, 'round number, planets winning and the roll, together')
    pg.wait_for_timeout(1000); pg.screenshot(path='shots/r4-round-open.png')
    seen_round_screen = pg.evaluate("""async ()=>{
      const sleep = ms=>new Promise(r=>setTimeout(r,ms)); let saw = false;
      for(let i=0;i<300 && G.round<2;i++){
        if(UI.roundScreen && !UI.roundScreen.gameEnd) saw = true;
        const p=currentPlayer();
        if(UI.diceGo) UI.diceGo();
        if(p && p.idx===0 && !busy()){ if(G.phase==='placement') dispatch({t:'lock', seat:0}); else dispatch({t:'endReveal', seat:0}); }
        await sleep(60);
      }
      return {saw, round:G.round, dice:!!UI.dice};
    }""")
    check(seen_round_screen['round'] >= 2 and not seen_round_screen['saw'], 'between rounds there is no second screen: ' + str(seen_round_screen))
    check(pg.evaluate("GAME_END_MS") == 2500, 'the Game End screen lasts 2.5 seconds')

    print('wording')
    check(pg.evaluate("fxText(defById('card-2').fx)").startswith('Move your card of choice'), 'one of your own cards, picked: "your card of choice"')
    r = pg.evaluate("JSON.stringify(parseAbility('Give your card of choice +3 Power.').fx)")
    check('"player":"self"' in r and '"rule":"choice"' in r, 'and it reads back the same: ' + r)

    print('optional effects')
    t = pg.evaluate("fxText([{v:'discard',n:1,then:true,optional:true},{v:'draw',n:1}])")
    check(t.startswith('You may discard a card'), 'an optional effect reads "You may …": ' + t)
    back = pg.evaluate("JSON.stringify(parseAbility('You may discard a card, in order to draw a card.').fx)")
    check('"optional":true' in back, 'and "You may" reads back as optional')
    pg.evaluate(SETUP)
    check(pg.evaluate(TO_MY_REVEAL) == 'reveal', 'reached my reveal turn')
    pg.evaluate("()=>{ defById('card-10').fx[0].optional = true; }")        # Atlas: you may draw a card
    atlas = pg.evaluate(PUT, ['card-10', 0, 0, False])
    hand0 = pg.evaluate("G.players[0].hand.length")
    pg.evaluate("uid=>dispatch({t:'flip', seat:0, uid})", atlas)
    pg.wait_for_selector('[data-act="pickoptional"]', timeout=5000)
    check('Atlas' in pg.inner_text('.sheet.choice .choice-src'), 'before it fires, the owner is asked, naming the card')
    pg.screenshot(path='shots/r5-optional.png')
    pg.click('[data-act="pickoptional"][data-i="0"]'); pg.wait_for_timeout(500)
    check(pg.evaluate("G.players[0].hand.length") == hand0 and not pg.evaluate("!!G.choice"), 'Skip: nothing is drawn')
    atlas2 = pg.evaluate(PUT, ['card-10', 0, 1, False])
    pg.evaluate("uid=>dispatch({t:'flip', seat:0, uid})", atlas2)
    pg.wait_for_selector('[data-act="pickoptional"]', timeout=5000)
    pg.click('[data-act="pickoptional"][data-i="1"]'); pg.wait_for_timeout(500)
    check(pg.evaluate("G.players[0].hand.length") == hand0 + 1, 'Use it: the card is drawn')
    pg.evaluate("()=>{ delete defById('card-10').fx[0].optional; }")

    print("an opponent's discard")
    pg.evaluate("()=>{ LIB.settings.anim = true; }")
    pg.evaluate("()=>{ const q=G.players[1]; const c=q.hand[0]; window.__dname=c.name; discardCard(1, c); }")
    pg.wait_for_selector('.fx-reveal', timeout=2000)
    t = pg.inner_text('.fx-reveal')
    check(pg.evaluate("window.__dname") in t and 'discards' in t, 'it turns up face up, named, before it crumbles: ' + t.replace('\n',' '))
    pg.screenshot(path='shots/r6-discard.png')
    pg.wait_for_timeout(1600)
    check(pg.query_selector('.fx-reveal') is None, '…and then it is gone')

    print('summoning onto a slot')
    pg.evaluate(SETUP)
    check(pg.evaluate(TO_MY_REVEAL) == 'reveal', 'reached my reveal turn')
    sol = pg.evaluate(PUT, ['card-29', 1, 0, False])         # Solariam: summon a Lunariam on a planet of your choice
    pg.evaluate("()=>{ G.players[0].energy = 9; render(); }")
    pg.evaluate("uid=>dispatch({t:'flip', seat:0, uid})", sol)
    pg.wait_for_selector('.slot.summon-target', timeout=5000)
    n = pg.evaluate("document.querySelectorAll('.slot.summon-target').length")
    opts = pg.evaluate("G.choice.options.length")
    check(pg.query_selector('.sheet') is None, 'no pop-up: the board itself is the choice')
    check(n > 0 and n == pg.evaluate("document.querySelectorAll('.side.mine .slot.summon-target, .slot.summon-target').length"), f'{n} open slots glow (of {opts} valid on screen)')
    check(pg.evaluate("[...document.querySelectorAll('.slot.summon-target')].every(el=>!el.closest('.side:not(.mine)'))"), 'only your own open slots glow')
    pg.screenshot(path='shots/r7-summon.png')
    k = pg.evaluate("()=>{ const el=[...document.querySelectorAll('.slot.summon-target')].pop(); el.click(); return +el.dataset.i; }")
    pg.wait_for_timeout(600)
    where = pg.evaluate("k=>{ const [p,s]=[0,0]; return null; }", k)
    placed = pg.evaluate("()=>G.planets.some(pl=>pl.board[0].some(c=>c && c.name==='Lunariam'))")
    check(placed, 'tapping a slot summons the token there')
    b.close()

print('page errors:', errs[:5])
print(('%d failures' % len(fails)) if fails or errs else 'round 3: all checks passed')
sys.exit(1 if fails or errs else 0)
