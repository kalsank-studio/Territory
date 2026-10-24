# The match log end to end in Chromium, against a local Worker:
#   games finished in the browser reach the log (signed out, signed in, bots only),
#   the admin reads them in Studio → Matches (filters, search, log, replay, export, delete),
#   and bot games stay out of the record.
#   npm run build && npx wrangler dev --port 8799 &   then   python3 test/test-matches-ui.py http://127.0.0.1:8799/
import sys, os, re, json, random, string, time, urllib.request
from playwright.sync_api import sync_playwright
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8799/').rstrip('/') + '/'
PW = os.environ.get('ADMIN_PW') or re.search(r'ADMIN_PASSWORD\s*=\s*"?([^"\n]*)"?', open('.dev.vars').read()).group(1)
os.makedirs('shots', exist_ok=True)
fails, errs = [], []
def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg, flush=True)
    if not cond: fails.append(msg)
def call(method, path, body=None, token=None):
    req = urllib.request.Request(BASE.rstrip('/') + path, method=method, data=json.dumps(body).encode() if body else None,
        headers=dict({'Content-Type':'application/json', 'CF-Connecting-IP':'192.0.2.%d' % random.randint(1, 250)}, **({'Authorization':'Bearer '+token} if token else {})))
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'{}')

tag = ''.join(random.choice(string.ascii_lowercase) for _ in range(5))
st, ad = call('POST', '/api/admin/login', {'password': PW}); ADM = ad['token']
st, acct = call('POST', '/api/account/register', {'username':'kay'+tag, 'password':'pass1234'})

# the page, with its beats shortened so whole games finish in seconds (the rules are untouched)
page_html = urllib.request.urlopen(BASE).read().decode()
fast = (page_html.replace('const PAUSE = 1000;', 'const PAUSE = 30;').replace('const FLIP_MS = 460;', 'const FLIP_MS = 30;')
        .replace('setTimeout(()=>botAct(q.idx), 520)', 'setTimeout(()=>botAct(q.idx), 15)').replace('setTimeout(()=>botAct(p.idx), 520)', 'setTimeout(()=>botAct(p.idx), 15)'))
assert fast != page_html

PLAY = """async (o)=>{
  LIB.settings.anim = false; LIB.settings.players = o.kinds.length; LIB.settings.kinds = o.kinds; LIB.settings.hide = false;
  LIB.settings.turnTimer = 0; LIB.settings.sandbox = !!o.sandbox;
  if(o.name){ setProfileName(o.name); }
  UI.screen = 'game'; newGame();
  const t0 = Date.now();
  while(!G.over && Date.now() - t0 < 90000){
    await new Promise(r=>setTimeout(r, 40));
    if(UI.dice && UI.diceGo) UI.diceGo();
    if(UI.roundScreen && UI.roundGo) UI.roundGo();
    if(UI.intro && UI.introGo) UI.introGo();
    /* a human seat plays nothing and ends its turns; any choice it owes is made for it */
    G.players.forEach(p=>{ if(p.kind!=='human') return;
      if(G.choice && G.choice.owner===p.idx && typeof autoResolveChoice==='function'){ try{ autoResolveChoice(); }catch(e){} }
      if(G.phase==='placement' && !p.locked) dispatch({t:'lock', seat:p.idx});
      else if(G.phase==='reveal' && currentPlayer() && currentPlayer().idx===p.idx) dispatch({t:'endReveal', seat:p.idx, early:true}); });
  }
  return {over: G.over, id: G.gameId, winner: G.result && G.result.winner};
}"""
def wait_match(mid, sec=15):
    for _ in range(sec * 4):
        st, r = call('GET', '/api/admin/matches/' + mid, token=ADM)
        if st == 200: return r['match']
        time.sleep(0.25)
    return None

with sync_playwright() as pw:
    b = pw.chromium.launch()
    def ctx_page(account=None):
        c = b.new_context(viewport={'width':430, 'height':900}, accept_downloads=True)
        if account:
            c.add_init_script("localStorage.setItem('territory.v1.account', JSON.stringify(%s))" % json.dumps({'user': account['username'], 'token': account['token']}))
        pg = c.new_page()
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.route(BASE, lambda route: route.fulfill(status=200, content_type='text/html', body=fast))
        pg.goto(BASE); pg.wait_for_function("typeof LIB!=='undefined' && LIB && LIB.cards.length > 10", timeout=15000)
        return pg

    print('— a signed-out browser: bots only, then a person against a bot —')
    pg = ctx_page()
    r1 = pg.evaluate(PLAY, {'kinds':['bot','bot']})
    check(r1['over'], 'a bots-only game plays to the end')
    m1 = wait_match(r1['id'])
    check(m1 is not None and all(p['bot'] for p in m1['players']) and m1['mode'] == 'local', 'and lands in the match log, though nobody could record it')
    check(m1 and len(m1['log']) > 20 and m1['replay'] and len(m1['replay']['cmds']) > 5 and m1['started'] and m1['started'] <= m1['at'], 'with its whole log, its replay and when it started')
    check(pg.evaluate("readMatchQ().length") == 0, 'nothing is left waiting in the browser')
    r2 = pg.evaluate(PLAY, {'kinds':['human','bot'], 'name':'Guest'+tag})
    m2 = wait_match(r2['id'])
    check(m2 and m2['players'][0]['name'] == 'Guest'+tag and not m2['players'][0]['bot'] and m2['players'][1]['bot'] and not m2['accounts'], 'a person against a bot, no account: in the log, no username')
    prof = pg.evaluate("profileStats()")
    check(prof['played'] == 0 and prof['vsBots'] == 1, 'the game against a bot is in the history but not the record (%s)' % json.dumps(prof))
    pg.evaluate("()=>{ UI.screen='profile'; render(); }")
    check('not counted' in pg.inner_text('.pf-list') and 'games against people only' in pg.inner_text('.pf-botnote'), 'the Profile says so')
    pg.screenshot(path='shots/mt1-profile.png', full_page=True)
    # sandbox games go to the log too, marked
    r3 = pg.evaluate(PLAY, {'kinds':['bot','bot'], 'sandbox':True})
    m3 = wait_match(r3['id'])
    check(m3 and m3['sandbox'], 'a sandbox game is logged, marked as sandbox')
    # a guest's device never sends the match (the host does)
    queued = pg.evaluate("()=>{ const was = G.isView; G.isView = true; UI.matchSent = null; localStorage.removeItem(MATCHQ_KEY); submitMatch(); const n = readMatchQ().length; G.isView = was; return n; }")
    check(queued == 0, 'a guest’s view of an online game sends nothing')
    # offline: it waits, then goes
    pg.context.set_offline(True)
    r4 = pg.evaluate(PLAY, {'kinds':['bot','bot']})
    time.sleep(0.5)
    check(pg.evaluate("readMatchQ().length") == 1, 'offline, the finished match waits in the browser')
    pg.context.set_offline(False)
    pg.evaluate("flushMatches()")
    check(wait_match(r4['id']) is not None and pg.evaluate("readMatchQ().length") == 0, 'and goes once the browser is back online')

    print('— signed in —')
    pk = ctx_page(acct)
    pk.wait_for_function("ACCT && ACCT.user", timeout=8000)
    r5 = pk.evaluate(PLAY, {'kinds':['human','bot'], 'name':'Kay'+tag})
    m5 = None
    for _ in range(40):
        m5 = wait_match(r5['id'])
        if m5 and m5['accounts'].get('0') == 'kay'+tag: break
        time.sleep(0.25)
    check(m5 and m5['accounts'].get('0') == 'kay'+tag, 'a signed-in player’s seat shows their username in the log')
    st, pub = call('GET', '/api/users/kay'+tag, token=acct['token'])
    check(pub['record']['played'] == 0 and pub['record']['vsBots'] >= 1 and len(pub['games']) >= 1, 'and the account’s record leaves the bot game out')

    print('— the admin’s Studio → Matches —')
    pa = ctx_page()
    pa.evaluate("()=>{ UI.screen='studio'; render(); }")
    check(pa.query_selector('[data-act="tab"][data-v="matches"]') is None, 'read only, there is no Matches tab')
    pa.click('[data-act="admopen"]'); pa.fill('[data-adm="pw"]', PW); pa.click('[data-act="admunlock"]')
    pa.wait_for_selector('[data-act="tab"][data-v="matches"]', timeout=8000)
    pa.click('[data-act="tab"][data-v="matches"]')
    pa.wait_for_selector('.am-row', timeout=10000)
    for _ in range(6):                       # other tests' matches may fill the first page
        ids = pa.evaluate("AM.list.map(m=>m.id)")
        if all(x in ids for x in (r1['id'], r2['id'], r3['id'], r5['id'])) or not pa.query_selector('[data-act="ammore"]'): break
        pa.click('[data-act="ammore"]'); pa.wait_for_function("!AM.loading")
    ids = pa.evaluate("AM.list.map(m=>m.id)")
    check(all(x in ids for x in (r1['id'], r2['id'], r3['id'], r5['id'])), 'every game just played is listed')
    check(ids.index(r5['id']) < ids.index(r1['id']), 'newest first')
    pa.screenshot(path='shots/mt2-list.png', full_page=True)
    pa.click('[data-act="amfilter"][data-v="people"]'); pa.wait_for_function("!AM.loading && AM.f==='people'")
    ids_people = pa.evaluate("AM.list.map(m=>m.id)")
    check(r1['id'] not in ids_people and r2['id'] not in ids_people, 'People only hides games with bots')
    pa.click('[data-act="amfilter"][data-v="sandbox"]'); pa.wait_for_function("!AM.loading && AM.f==='sandbox'")
    check(pa.evaluate("AM.list.map(m=>m.id)")[:1] == [r3['id']] or r3['id'] in pa.evaluate("AM.list.map(m=>m.id)"), 'Sandbox shows the sandbox game')
    pa.click('[data-act="amfilter"][data-v="all"]'); pa.wait_for_function("!AM.loading && AM.f==='all'")
    pa.fill('[data-am="q"]', 'kay'+tag); pa.wait_for_timeout(700); pa.wait_for_function("!AM.loading")
    check(pa.evaluate("AM.list.map(m=>m.id)") == [r5['id']], 'search by @username finds that player’s match')
    pa.click('[data-act="amopen"][data-id="%s"]' % r5['id']); pa.wait_for_selector('.am-detail .am-log', timeout=8000)
    txt = pa.inner_text('.am-detail')
    check('@kay'+tag in txt and 'bot' in txt and 'Planets' in txt and 'Game log' in txt, 'a match opens with its seats (username, bot), planets and log')
    pa.evaluate("()=>{ AM.m.log.push({t:'Kay steals Spore Drone from Rival\u2019s hand.', w:0, p:[0,1]}); render(); }")
    only = pa.query_selector('.am-detail .am-only')
    seats = pa.evaluate("AM.m.players.map(p=>p.name)")
    check(only is not None and all(n in only.inner_text() for n in seats[:2]), 'a line only some players saw is marked \U0001F512 with who saw it')
    pa.screenshot(path='shots/mt3-detail.png', full_page=True)
    with pa.expect_download(timeout=8000) as dl:
        pa.click('[data-act="amexport"]')
    f = json.loads(open(dl.value.path()).read())
    check(f['format'] == 'territory-game' and f['replay'] and f['summary']['id'] == r5['id'], 'Export saves the game file the Replay page reads')
    pa.click('[data-act="amwatch"]')
    pa.wait_for_function("UI.replaying && UI.screen==='game' && G && G.gameId==='replay'", timeout=8000)
    check(True, 'Watch replay plays it on the board')
    pa.wait_for_timeout(600)
    pa.screenshot(path='shots/mt4-replay.png')
    pa.evaluate("stopReplay()")
    check(pa.evaluate("UI.screen") == 'studio' and pa.query_selector('.am-detail') is not None, 'leaving the replay goes back to the match')
    pa.click('[data-act="amdelete"]'); pa.click('[data-act="amdelete"]')
    pa.wait_for_function("!AM.open", timeout=5000)
    st, _ = call('GET', '/api/admin/matches/' + r5['id'], token=ADM)
    check(st == 404, 'Delete (tapped twice) removes the match')
    pa.click('[data-act="amrebuild"]')
    pa.wait_for_function("AM.rb && (AM.rb.done || AM.rb.err)", timeout=20000)
    check(pa.evaluate("AM.rb.done === true"), 'Recount everyone’s stats runs through every account')
    pa.screenshot(path='shots/mt5-after.png', full_page=True)
    b.close()
print('page errors:', errs[:5])
print(('%d failures' % len(fails)) if fails or errs else 'matches ui: all checks passed')
sys.exit(1 if fails or errs else 0)
