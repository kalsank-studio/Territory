# An online game reaches the match log once, from the host, with the guest's account on their seat.
#   npm run build && npx wrangler dev --port 8799 &   then   python3 test/test-matches-online.py http://127.0.0.1:8799/
import sys, os, re, json, random, string, time, urllib.request
from playwright.sync_api import sync_playwright
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8799/').rstrip('/') + '/'
PW = os.environ.get('ADMIN_PW') or re.search(r'ADMIN_PASSWORD\s*=\s*"?([^"\n]*)"?', open('.dev.vars').read()).group(1)
fails, errs = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)
def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE.rstrip('/') + path, method=method, data=json.dumps(body).encode() if body else None,
        headers=dict({'Content-Type':'application/json'}, **({'Authorization':'Bearer '+token} if token else {})))
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')
tag = ''.join(random.choice(string.ascii_lowercase) for _ in range(5))
st, ad = call('POST', '/api/admin/login', {'password': PW}); ADM = ad['token']
st, acct = call('POST', '/api/account/register', {'username':'sam'+tag, 'password':'pass1234'})
html = urllib.request.urlopen(BASE).read().decode()
fast = html.replace('const PAUSE = 1000;', 'const PAUSE = 30;').replace('const FLIP_MS = 460;', 'const FLIP_MS = 30;')

STEP = """()=>{
  if(!G || UI.screen!=='game' || G.over) return G && G.over ? 'over' : 'idle';
  if(UI.dice && UI.diceGo && !G.isView) UI.diceGo();
  if(UI.roundScreen && UI.roundGo && !G.isView) UI.roundGo();
  if(UI.intro && UI.introGo && !G.isView) UI.introGo();
  const me = G.isView ? G.viewer : NET.seat;
  const p = G.players[me];
  const sheet = document.querySelector('.sheet.choice');
  if(sheet){ const b = sheet.querySelector('.mode-opt:not(.on):not([disabled])') || sheet.querySelector('.hand [data-act], .stack [data-act]:not([disabled]):not(.mode-opt), .opt-row [data-act]'); if(b){ b.click(); return 'chose'; } }
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

with sync_playwright() as pw:
    b = pw.chromium.launch()
    def page(name, account=None):
        ctx = b.new_context(viewport={'width':430, 'height':900})
        if account: ctx.add_init_script("localStorage.setItem('territory.v1.account', JSON.stringify(%s))" % json.dumps({'user': account['username'], 'token': account['token']}))
        ctx.add_init_script("try{ const k='territory.v1'; const l=JSON.parse(localStorage.getItem(k)||'null'); }catch(e){}")
        pg = ctx.new_page()
        pg.on('pageerror', lambda e, n=name: errs.append(n+': '+str(e)))
        pg.route(lambda u: u.split('?')[0].rstrip('/') + '/' == BASE, lambda route: route.fulfill(status=200, content_type='text/html', body=fast))
        pg.goto(BASE); pg.wait_for_function("LIB && LIB.cards.length > 40", timeout=10000)
        pg.evaluate("()=>{ LIB.settings.anim = false; }")
        return ctx, pg
    hctx, host = page('host')
    gctx, guest = page('guest', acct)
    host.click('[data-on="open"]'); host.fill('[data-on-input="name"]', 'Hal'+tag)
    host.click('[data-on="host"]'); host.wait_for_selector('.room-code', timeout=10000)
    code = host.evaluate('ON.code')
    guest.goto(BASE + '?room=' + code); guest.wait_for_selector('[data-on-input="code"]')
    guest.evaluate("()=>{ LIB.settings.anim = false; }")
    guest.fill('[data-on-input="name"]', 'Sam'+tag); guest.click('[data-on="join"]')
    guest.wait_for_selector('.lobby-seat', timeout=10000)
    host.wait_for_function("ON.seats.some(s=>s.seat===1 && s.online)", timeout=8000)
    host.click('[data-on="start"]')
    guest.wait_for_function("G && G.isView && UI.screen==='game'", timeout=10000)
    t0 = time.time(); over = False
    while time.time() - t0 < 300 and not over:
        for pg in (host, guest):
            try: pg.evaluate(STEP)
            except Exception: pass
        over = host.evaluate("!!(G && G.over)")
        host.wait_for_timeout(150)
    check(over, 'an online game between two people plays to the end')
    gid = host.evaluate("G.gameId")
    guest.wait_for_function("G && G.over", timeout=10000)
    m = None
    for _ in range(60):
        st, r = call('GET', '/api/admin/matches/' + gid, token=ADM)
        if st == 200 and r['match']['accounts'].get('1'): m = r['match']; break
        time.sleep(0.25)
    check(m is not None and m['mode'] == 'online' and [p['name'] for p in m['players']] == ['Hal'+tag, 'Sam'+tag], 'the host sends the match: online, both players')
    check(m and m['accounts'].get('1') == 'sam'+tag and '0' not in m['accounts'], 'the signed-in guest’s seat shows their username; the host has none')
    check(m and m['replay'] and len(m['log']) > 30 and not any(p['bot'] for p in m['players']), 'with its full log and replay, no bots')
    st, lst = call('GET', '/api/admin/matches?q=' + tag, token=ADM)
    check(sum(1 for x in lst['matches'] if x['id'] == gid) == 1, 'it is in the log exactly once')
    check(guest.evaluate("readMatchQ().length") == 0 and guest.evaluate("UI.matchSent") in (None, False), 'the guest never queued or sent it')
    st, pub = call('GET', '/api/users/sam'+tag, token=acct['token'])
    for _ in range(20):
        if pub.get('record', {}).get('played'): break
        time.sleep(0.25); st, pub = call('GET', '/api/users/sam'+tag, token=acct['token'])
    check(pub['record']['played'] == 1 and pub['record']['vsBots'] == 0, 'and a game against a person counts in the guest’s record')
    b.close()
print('page errors:', errs[:5])
print(('%d failures' % len(fails)) if fails or errs else 'matches online: all checks passed')
sys.exit(1 if fails or errs else 0)
