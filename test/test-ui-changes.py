# Real-browser checks for: token links in the card reader, rearranging revealed
# cards only at the end of the reveal turn (same planet, swap), ability pop-ups
# (source strip, no graveyard button, look-at-the-board tab, choice timer), and
# the Game End screen. Run against a served dist/ (so library.json loads):
#   npm run build && (cd dist && python3 -m http.server 8123 &) && python3 test/test-ui-changes.py http://127.0.0.1:8123/
# Screenshots go to shots/.
import sys, os
from playwright.sync_api import sync_playwright
url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8123/'
os.makedirs('shots', exist_ok=True)
errs, fails = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: fails.append(msg)

SETUP = """(timer)=>{
  LIB.settings.players=2; LIB.settings.planets=5; LIB.settings.rounds=6;
  LIB.settings.kinds=['human','bot','bot','bot']; LIB.settings.placement='turns'; LIB.settings.hide=false;
  LIB.settings.sandbox=false; LIB.settings.turnTimer=timer; LIB.settings.turnTimerCustom=false; LIB.settings.choiceTimer=15;
  LIB.settings.deckOf=[LIB.decks[0].id, LIB.decks[0].id];
  UI.screen='game'; UI.sheet=null; newGame(); }"""
# Wait until it's the human's placement turn, place nothing, end turn; then wait for the human's reveal turn.
TO_MY_REVEAL = """async ()=>{
  const sleep = ms=>new Promise(r=>setTimeout(r,ms));
  for(let i=0;i<200;i++){
    const p=currentPlayer();
    if(G.phase==='reveal' && p && p.idx===0 && !busy()){
      for(const f of faceDownOf(p)){ G.planets[f.planetIdx].board[0][f.slotIdx] = null; p.hand.push(f.card); }
      render(); return 'reveal';
    }
    if(G.phase==='placement' && p && p.idx===0 && !busy()){
      p.energy = Math.max(p.energy, 9);
      if(p.hand.length && !G.planets[4].board[0][2]) dispatch({t:'place', seat:0, uid:p.hand[0].uid, p:4, s:2});
      dispatch({t:'lock', seat:0});
    }
    if(UI.roundGo) UI.roundGo();
    await sleep(100);
  }
  return 'timeout';
}"""
# Put a library card face up (or down) in one of player 0's slots.
PUT = """([id, planet, slot, faceUp])=>{
  const def = defById(id); const c = instance(def, 0);
  G.planets[planet].board[0][slot] = c;
  if(faceUp){ c.faceUp = true; markInPlay(c); } else { G.players[0].placed.push({uid:c.uid, planetIdx:planet, slotIdx:slot}); }
  render(); return c.uid; }"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width':430, 'height':900}, device_scale_factor=2)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' and 'fonts' not in m.text else None)
    pg.goto(url); pg.wait_for_function("LIB && LIB.cards.some(c=>c.id==='card-3')", timeout=8000)

    print('token links in the reader')
    pg.evaluate(SETUP, 0)
    check(pg.evaluate(TO_MY_REVEAL) == 'reveal', 'reached my reveal turn')
    laevus = pg.evaluate(PUT, ['card-3', 0, 0, True])
    dexter = pg.evaluate("""(laevus)=>{ const c = instance(defById('token-3'), 0); c.creator = laevus; c.creatorName = 'Laevus';
                            G.players[0].hand.push(c); render(); return c.uid; }""", laevus)
    pg.evaluate("uid=>inspectCard(uid)", dexter); pg.wait_for_timeout(250)
    txt = pg.inner_text('.sheet.inspect')
    check('Created by' in txt and 'Laevus' in txt, 'a token names the card that created it')
    pg.screenshot(path='shots/u1-token-created-by.png')
    pg.click('.sheet.inspect .ins-link'); pg.wait_for_timeout(200)
    txt = pg.inner_text('.sheet.inspect')
    check(txt.startswith('←') or 'The token it makes' in txt, 'tapping it opens the creator')
    check('The token it makes' in txt and 'Dexter' in txt, 'a card that creates a token shows that token')
    pg.screenshot(path='shots/u2-card-makes-token.png')
    pg.click('[data-act="peekback"]'); pg.wait_for_timeout(150)
    check(pg.inner_text('.sheet.inspect h3') == 'Dexter', 'the back arrow returns to the token')
    pg.click('.sheet.inspect [data-act="closesheet"]'); pg.wait_for_timeout(150)
    # a library-only look at a token: its maker list
    pg.evaluate("inspectDef('token-1')"); pg.wait_for_timeout(150)
    txt = pg.inner_text('.sheet.inspect')
    check('Made by' in txt and 'Putrescia' in txt, 'a token read from the library lists the cards that make it')
    pg.click('.sheet.inspect [data-act="closesheet"]')

    print('rearranging revealed cards')
    a = pg.evaluate(PUT, ['card-11', 1, 0, True])
    c = pg.evaluate(PUT, ['card-12', 1, 2, True])
    pg.wait_for_timeout(200)
    check(pg.evaluate("rearranging()"), 'everything face up on my reveal turn: rearranging is on')
    pg.click(f'.slot[data-uid="{a}"], .slot:has(.mini[data-uid="{a}"])'); pg.wait_for_timeout(200)
    lit = pg.evaluate("""()=>{ const pl=[...document.querySelectorAll('.planet')][1];
       const mine=[...pl.querySelectorAll('.side.mine .slot')];
       const other=[...document.querySelectorAll('.planet')].filter((_,i)=>i!==1).flatMap(p=>[...p.querySelectorAll('.side.mine .slot')]);
       return {here: mine.map(s=>s.className), elsewhereBlocked: other.every(s=>s.classList.contains('blocked'))}; }""")
    check(len(lit['here']) == 3 and all(('dest' in k) or ('open' in k) for k in lit['here']), 'all three of my slots on that planet light up')
    check(lit['elsewhereBlocked'], 'my slots on other planets step back')
    pg.screenshot(path='shots/u3-rearrange-lit.png')
    pg.click(f'.slot:has(.mini[data-uid="{c}"])'); pg.wait_for_timeout(200)
    row = pg.evaluate("()=>G.planets[1].board[0].map(x=>x&&x.uid)")
    check(row[0] == c and row[2] == a, 'dropping on an occupied slot on the same planet swaps the two')
    other = pg.evaluate("([a])=>dispatch({t:'move', seat:0, uid:a, p:2, s:0}).ok", [a])
    check(other is False, 'a revealed card cannot move to another planet')
    k = pg.evaluate("()=>{ const ph=G.phase; G.phase='placement'; const k=pickupKind(G.players[0],1,0); G.phase=ph; return k; }")
    check(k is None, 'during placement a revealed card cannot be picked up')

    print('ability pop-up')
    pg.evaluate(SETUP, 60)
    check(pg.evaluate(TO_MY_REVEAL) == 'reveal', 'reached my reveal turn (timers on)')
    ward = pg.evaluate(PUT, ['card-13', 0, 0, False])
    pg.evaluate("()=>{ G.players[0].energy = 9; const h=G.players[0].hand; if(h.length<2){ h.push(instance(defById('card-11'),0)); h.push(instance(defById('card-12'),0)); } render(); }")
    pg.wait_for_timeout(150)
    pg.evaluate("uid=>dispatch({t:'flip', seat:0, uid})", ward)
    pg.wait_for_selector('.sheet.choice', timeout=5000); pg.wait_for_timeout(300)
    head = pg.inner_text('.sheet.choice .choice-src')
    check('Ward' in head, 'the pop-up names the card using the effect: ' + head.replace('\n', ' / '))
    check(pg.query_selector('.sheet.choice [data-ctimer]') is not None, 'the pop-up shows its own timer')
    check('Graveyard' not in pg.inner_text('.sheet.choice'), 'no graveyard button in the pop-up')
    check(pg.query_selector('.choice-side') is not None, 'a side tab to look at the board')
    turn_before = pg.evaluate("UI.timer && UI.timer.left")
    pg.screenshot(path='shots/u4-choice-sheet.png')
    pg.click('.choice-side'); pg.wait_for_timeout(250)
    check(pg.query_selector('.sheet.choice') is None and pg.query_selector('.choice-side.away') is not None, 'the tab puts the choice aside')
    pg.screenshot(path='shots/u5-choice-board.png')
    pg.click('.grave-btn'); pg.wait_for_timeout(200)
    check(pg.query_selector('.sheet h3') and 'Graveyard' in pg.inner_text('.sheet h3'), 'the graveyard opens from the board meanwhile')
    pg.click('.sheet [data-act="closesheet"]'); pg.wait_for_timeout(150)
    pg.click(f'.slot:has(.mini[data-uid="{ward}"])'); pg.wait_for_timeout(200)
    check(pg.query_selector('.sheet.inspect') is not None, 'cards on the board can be read meanwhile')
    pg.click('.sheet.inspect [data-act="closesheet"]'); pg.wait_for_timeout(150)
    pg.click('.choice-side'); pg.wait_for_timeout(200)
    check(pg.query_selector('.sheet.choice') is not None, 'the tab brings the choice back')
    pg.wait_for_timeout(1500)
    turn_after = pg.evaluate("UI.timer && UI.timer.left")
    check(turn_before is not None and abs(turn_before - turn_after) < 300, 'the turn clock waits while the choice clock runs')
    pg.wait_for_function("!G.choice", timeout=20000)
    check(any('graveyard' in l['t'] or 'discard' in l['t'].lower() for l in pg.evaluate("G.log.slice(-6)")), 'at zero the choice is made for you')
    pg.screenshot(path='shots/u6-choice-timed-out.png')

    print('setup screen')
    pg.evaluate("()=>{ LIB.settings.turnTimer=60; UI.screen='setup'; render(); }"); pg.wait_for_timeout(200)
    check(pg.query_selector('select[data-k="choiceTimer"]') is not None, 'setup offers an ability choice timer when turn timers are on')
    pg.screenshot(path='shots/u7-setup-timers.png', full_page=True)

    print('game end screen')
    pg.evaluate(SETUP, 0)
    check(pg.evaluate(TO_MY_REVEAL) == 'reveal', 'reached my reveal turn')
    pg.evaluate(PUT, ['lastbloom', 3, 0, True])
    pg.evaluate("()=>{ G.round = G.rounds; render(); }")
    pg.evaluate("()=>dispatch({t:'endReveal', seat:0})")
    pg.wait_for_selector('.round-screen.game-end', timeout=15000)
    txt = pg.inner_text('.round-screen.game-end')
    check('Game End' in txt and 'Last Bloom' in txt, 'a Game End screen lists the cards about to fire')
    pg.wait_for_timeout(500); pg.screenshot(path='shots/u8-game-end.png')
    pg.wait_for_function("G.over", timeout=15000)
    check(any('Last Bloom' in l['t'] for l in pg.evaluate("G.log")), 'then they fire and the game is tallied')
    b.close()

print('page errors:', errs[:5])
print(('%d failures' % len(fails)) if fails or errs else 'ui changes: all checks passed')
sys.exit(1 if fails or errs else 0)
