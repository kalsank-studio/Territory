# Studio → Users: an admin sees every account and its data; nobody else can.
#   npm run build && npx wrangler dev --port 8799 &   then   python3 test/test-admin-users.py http://127.0.0.1:8799/
import sys, os, re, json, random, string, urllib.request
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8799/'
PW = os.environ.get('ADMIN_PW') or re.search(r'ADMIN_PASSWORD\s*=\s*"?([^"\n]*)"?', open('.dev.vars').read()).group(1)
os.makedirs('shots', exist_ok=True)
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
st, a = call('POST', '/api/account/register', {'username':'zed'+tag, 'password':'pass1234'})
call('PUT', '/api/account', {'name':'Zed', 'emoji':'🦉'}, a['token'])
# one game against a person (counted) and one against a bot (kept, not counted)
call('POST', '/api/account/games', {'games':[
    {'id':'z'+tag+'g1','at':2,'mode':'local','seat':0,'result':'win','won':[3,1],'rounds':6,'players':[{'name':'Zed'},{'name':'Amy'}],'rows':[],'log':[{'t':'hello'}]},
    {'id':'z'+tag+'g0','at':1,'mode':'local','seat':0,'result':'win','won':[3,1],'rounds':6,'players':[{'name':'Zed'},{'name':'Bot','bot':True}],'rows':[],'log':[{'t':'beep'}]}]}, a['token'])
st, _ = call('GET', '/api/admin/users')
check(st == 401, 'the user list needs an admin session')
st, _ = call('GET', '/api/admin/users', token=a['token'])
check(st == 401, 'a player token is not enough')
st, ad = call('POST', '/api/admin/login', {'password': PW})
st, lst = call('GET', '/api/admin/users', token=ad['token'])
me = [u for u in lst.get('users', []) if u['user'] == 'zed'+tag]
check(st == 200 and me and me[0]['name'] == 'Zed' and me[0]['record']['played'] == 1 and me[0]['record']['vsBots'] == 1, 'the admin sees the account with its record (games against people; bot games counted apart)')
check(not any(k in json.dumps(lst) for k in ('"hash"', '"salt"', '"secret"')), 'no password hash, salt or session secret is ever sent')
st, d = call('GET', '/api/admin/users/zed'+tag, token=ad['token'])
check(st == 200 and d['games'][0]['id'] == 'z'+tag+'g1' and len(d['games']) == 2 and d['emoji'] == '🦉', "and the player's full data, every game listed")
st, g = call('GET', f'/api/admin/users/zed{tag}/games/z{tag}g1', token=ad['token'])
check(st == 200 and g['game']['log'][0]['t'] == 'hello', 'and any of their games, with its log')
with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_context(viewport={'width':430, 'height':900}).new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE); pg.wait_for_function("LIB && LIB.cards.length > 40 && ADM.checked", timeout=10000)
    pg.evaluate("()=>{ UI.screen='studio'; render(); }")
    check(pg.query_selector('[data-act="tab"][data-v="users"]') is None, 'read only, there is no Users tab')
    pg.click('[data-act="admopen"]'); pg.fill('[data-adm="pw"]', PW); pg.click('[data-act="admunlock"]')
    pg.wait_for_selector('[data-act="tab"][data-v="users"]', timeout=8000)
    pg.click('[data-act="tab"][data-v="users"]')
    pg.wait_for_selector(f'[data-act="auopen"][data-u="zed{tag}"]', timeout=10000)
    pg.fill('[data-au="q"]', 'zed'+tag)
    check(len(pg.query_selector_all('.au-row')) == 1, 'the filter finds one account')
    pg.screenshot(path='shots/au1-list.png')
    pg.click(f'[data-act="auopen"][data-u="zed{tag}"]'); pg.wait_for_selector('.au-detail .pf-game', timeout=8000)
    check('1 game with bots, not counted' in pg.inner_text('.au-detail'), 'the detail says the bot game is not counted')
    pg.screenshot(path='shots/au2-detail.png', full_page=True)
    pg.click('.au-detail .pf-game'); pg.wait_for_selector('.sheet .log', timeout=8000)
    check('hello' in pg.inner_text('.sheet .log'), "the game's log opens")
    b.close()
print('page errors:', errs[:5])
print(('%d failures' % len(fails)) if fails or errs else 'admin users: all checks passed')
sys.exit(1 if fails or errs else 0)
