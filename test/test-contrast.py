# Contrast check: every visible piece of text on every screen, in light and dark,
# at phone width. Each text's colour is measured against what's actually behind
# it (backgrounds composited up the tree, gradients averaged). WCAG AA: 4.5:1 for
# body text, 3:1 for large text (24px, or 18.7px bold). Disabled controls are
# reported separately, not failed.
#   (cd dist && python3 -m http.server 8123 &) ; python3 test/test-contrast.py http://127.0.0.1:8123/
import sys, json
from playwright.sync_api import sync_playwright
args = [a for a in sys.argv[1:] if not a.startswith('-')]
url = args[0] if args else 'http://127.0.0.1:8123/'

# The page lists every visible text with its colour; the background behind it is
# read from a screenshot taken with all text made transparent, so gradients,
# images, scrims and translucent layers all count exactly as drawn.
LIST = r"""() => {
  const parse = s => { const m = s && s.match(/rgba?\(([^)]+)\)/); if(!m) return null;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return {r:p[0], g:p[1], b:p[2], a: p.length>3 ? p[3] : 1}; };
  const out = [], seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while((n = walker.nextNode())){
    const t = n.textContent.replace(/\s+/g,' ').trim();
    if(!t || !/[A-Za-z0-9]/.test(t)) continue;
    const el = n.parentElement;
    if(!el || el.closest('svg,script,style,option,[aria-hidden="true"],.art,.rs-orb,.orb,.die,.fx-ghost,.drag-ghost')) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const r0 = range.getBoundingClientRect();
    /* only the part that's actually shown: clipped by any overflow-hidden box around it */
    const r = {left:r0.left, top:r0.top, right:r0.right, bottom:r0.bottom};
    for(let e = el; e && e!==document.body; e = e.parentElement){
      const o = getComputedStyle(e);
      if(o.overflow!=='visible' || o.overflowX!=='visible' || o.overflowY!=='visible'){
        const c = e.getBoundingClientRect();
        r.left = Math.max(r.left, c.left); r.top = Math.max(r.top, c.top); r.right = Math.min(r.right, c.right); r.bottom = Math.min(r.bottom, c.bottom);
      }
    }
    r.width = r.right - r.left; r.height = r.bottom - r.top;
    if(r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    const cs = getComputedStyle(el);
    if(cs.visibility==='hidden') continue;
    let op = 1; for(let e = el; e; e = e.parentElement){ op *= parseFloat(getComputedStyle(e).opacity); }
    if(op < 0.05) continue;
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const hit = document.elementFromPoint(Math.min(innerWidth-1, Math.max(0,cx)), Math.min(innerHeight-1, Math.max(0,cy)));
    if(hit && hit!==el && !el.contains(hit) && !hit.contains(el)) continue;      // covered by something on top
    const fg = parse(cs.color); if(!fg) continue;
    const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight,10) >= 700;
    /* deliberately set back while something else is the choice (disabled, can't afford, not pickable, the hand while picking on the board) */
    const disabled = !!el.closest('[disabled],.unaffordable,.blocked,.lose,.unpickable,.is-holding,.pending') || !!(el.closest('.tray,.rail') && el.closest('.is-picking'));
    const key = el.tagName+'|'+el.className+'|'+t.slice(0,30);
    if(seen.has(key)) continue; seen.add(key);
    out.push({text:t.slice(0,48), x:r.left, y:r.top, w:r.width, h:r.height, fg:{r:fg.r, g:fg.g, b:fg.b, a:fg.a*op},
      large: px >= 24 || (bold && px >= 18.66), disabled, cls:(el.className||'').toString().slice(0,50), tag:el.tagName.toLowerCase(), color:cs.color});
  }
  /* text inside form fields: the value, the chosen option, or the placeholder */
  document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]),select,textarea').forEach(el=>{
    const r = el.getBoundingClientRect();
    if(r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= innerHeight) return;
    const cs = getComputedStyle(el);
    if(cs.visibility==='hidden' || cs.display==='none') return;
    const hit = document.elementFromPoint(Math.min(innerWidth-1, Math.max(0, r.left + 12)), Math.min(innerHeight-1, Math.max(0, r.top + r.height/2)));
    if(hit && hit!==el && !el.contains(hit)) return;
    let op = 1; for(let e = el; e; e = e.parentElement){ op *= parseFloat(getComputedStyle(e).opacity); }
    const isPh = el.tagName!=='SELECT' && !el.value && el.placeholder;
    const text = el.tagName==='SELECT' ? (el.options[el.selectedIndex]||{}).text : (el.value || el.placeholder || '');
    if(!text || !/[A-Za-z0-9]/.test(text)) return;
    const col = parse(isPh ? getComputedStyle(el, '::placeholder').color : cs.color); if(!col) return;
    const disabled = !!el.closest('[disabled]') || el.disabled;
    /* sample the box itself, inset from its border */
    out.push({text:(isPh?'(placeholder) ':'')+text.slice(0,40), x:r.left+6, y:r.top+4, w:Math.min(r.width-12, 120), h:r.height-8,
      fg:{r:col.r, g:col.g, b:col.b, a:col.a*op}, large:false, disabled, cls:(el.className||el.tagName).toString().slice(0,40), tag:el.tagName.toLowerCase(), color:isPh?'placeholder':cs.color});
  });
  return out;
}"""
HIDE_TEXT = "*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}"

def lum(c):
    f = lambda v: (v/255)/12.92 if v/255 <= 0.03928 else (((v/255)+0.055)/1.055)**2.4
    return 0.2126*f(c[0]) + 0.7152*f(c[1]) + 0.0722*f(c[2])
def ratio(a, b):
    x, y = lum(a), lum(b)
    return (max(x,y)+0.05)/(min(x,y)+0.05)
def measure(pg):
    from PIL import Image
    import io
    items = pg.evaluate(LIST)
    tag = pg.add_style_tag(content=HIDE_TEXT)
    png = pg.screenshot()
    pg.evaluate("el=>el.remove()", tag)
    img = Image.open(io.BytesIO(png)).convert('RGB')
    sx = img.width / pg.viewport_size['width']
    bad = []
    for it in items:
        x0, y0 = max(0, int(it['x']*sx)), max(0, int(it['y']*sx))
        x1, y1 = min(img.width, int((it['x']+it['w'])*sx)), min(img.height, int((it['y']+it['h'])*sx))
        if x1-x0 < 1 or y1-y0 < 1: continue
        px = list(img.crop((x0, y0, x1, y1)).getdata())
        px.sort(key=lambda c: c[0]+c[1]+c[2])
        bg = px[len(px)//2]                              # the median: what most of the area behind the text is
        f = it['fg']; a = f['a']
        shown = (f['r']*a + bg[0]*(1-a), f['g']*a + bg[1]*(1-a), f['b']*a + bg[2]*(1-a))
        k = ratio(shown, bg)
        need = 3 if it['large'] else 4.5
        if k < need and not it['disabled']:
            bad.append(dict(it, ratio=round(k,2), need=need, bg='rgb(%d,%d,%d)'%bg))
    return bad

SCREENS = {
 'title':   "()=>{ G=null; UI.screen='title'; UI.sheet=null; render(); }",
 'setup':   "()=>{ LIB.settings.turnTimer=60; UI.screen='setup'; render(); }",
 'studio-readonly': "()=>{ ADM.ok=false; ADM.checked=true; UI.admGate=false; UI.screen='studio'; studioTab='cards'; render(); }",
 'studio-readonly-planets': "()=>{ studioTab='planets'; render(); }",
 'studio-locked': "()=>{ UI.admGate=true; ADM.err='That isn’t the admin password.'; render(); }",
 'studio':  "()=>{ UI.admGate=false; ADM.ok=true; UI.screen='studio'; studioTab='cards'; render(); }",
 'studio-planets': "()=>{ studioTab='planets'; render(); }",
 'studio-import': "()=>{ studioTab='import'; render(); }",
 'studio-art': "()=>{ studioTab='art'; render(); }",
 'decks':   "()=>{ UI.screen='decks'; render(); }",
 'sprites': "()=>{ UI.screen='sprites'; render(); }",
 'rules':   "()=>{ UI.screen='rules'; render(); }",
 'profile': "()=>{ PROFILE.name='Kal'; PROFILE.games=[{id:'a',at:Date.now(),mode:'online',seat:0,result:'win',won:[3,2],reason:'planets won',rounds:6,players:[{name:'Kal'},{name:'Sam'}],rows:[{name:'Verdance',scores:[7,3],winner:0},{name:'Silt Garden',scores:[2,9],winner:1}],log:[{rd:1,t:'Round 1'},{t:'Kal reveals Atlas',w:0},{t:'Sam reveals Ward',w:1}]},{id:'b',at:Date.now()-9e7,mode:'local',seat:0,result:'loss',won:[1,3],rounds:6,players:[{name:'Kal'},{name:'Bot 2',bot:true}],rows:[],log:null},{id:'c',at:Date.now()-2e8,mode:'local',seat:0,result:'draw',won:[2,2],rounds:6,players:[{name:'Kal'},{name:'Bot 2',bot:true}],rows:[],log:null}]; UI.screen='profile'; UI.sheet=null; render(); }",
 'profile-game': "()=>{ UI.histId='a'; UI.sheet='hist'; render(); }",
 'profile-signin': "()=>{ UI.sheet=null; AC.error='Wrong username or password.'; render(); }",
 'profile-account': "()=>{ AC.error=''; ACCT={user:'kal', token:'kal.x'}; AC.status='synced'; render(); ACCT=null; }",
 'studio-filter': "()=>{ UI.sheet=null; UI.screen='studio'; studioTab='cards'; const st=cfState('cards'); st.open=true; st.passive=true; st.sort='cost'; render(); }",
 'profile-stats': "()=>{ cfState('cards').open=false; cfState('cards').passive=false; PROFILE.games[0].stats={v:1,won:1,draws:[1,2,1,1,2,1],power:[3,7,12,15,20,24],slots:[{p:'Verdance',s:[{c:'⚡≤3',r:'+1 ⚡',o:4,m:3},{c:'💪≥5',r:'+1 🃏',o:2,m:0},{c:'Any',r:'+1 ⚡',o:0,m:0}]}],cards:[{n:'Atlas',pw:1},{n:'Ward',pw:0},{n:'Blade',pw:null}]}; UI.screen='profile'; UI.pfTab='stats'; render(); }",
 'replay-page': "()=>{ UI.pfTab='history'; UI.screen='replay'; UI.rpLoaded={summary:PROFILE.games[0], log:PROFILE.games[0].log, replay:{cmds:[1,2,3]}}; UI.rpError=''; render(); }",
 'social-out': "()=>{ UI.screen='social'; render(); }",
 'social':  "()=>{ ACCT={user:'kal', token:'kal.x'}; SO.at=Date.now(); SO.data={friends:[{user:'sam',name:'Sam',record:{played:4,wins:3,losses:1,draws:0}},{user:'ana',name:'Ana',record:{played:0,wins:0,losses:0,draws:0}}], incoming:[{user:'bo',name:'Bo',at:1}], outgoing:[{user:'cy',name:'Cy',at:1}], invites:[{from:'sam',name:'Sam',code:'ABCDE',at:Date.now()}]}; SO.q='sa'; SO.results=[{user:'sam',name:'Sam'},{user:'sal',name:'Sal'}]; UI.screen='social'; render(); }",
 'player':  "()=>{ SO.prof={username:'sam',name:'Sam',record:{played:2,wins:1,losses:1,draws:0},relation:'friend',games:[Object.assign({},PROFILE.games[0],{comments:2})]}; UI.screen='player'; render(); }",
 'player-game': "()=>{ SO.gameOwner='sam'; SO.game=Object.assign({},PROFILE.games[0],{replay:{}}); SO.comments=[{id:'aa',author:'kal',name:'Kal',text:'Nice one',at:Date.now()},{id:'bb',author:'sam',name:'Sam',text:'Thanks!',at:Date.now()}]; UI.sheet='pgame'; render(); }",
 'invite-pop': "()=>{ UI.sheet=null; SO.popup={from:'sam',name:'Sam',code:'ABCDE',at:1}; UI.screen='title'; render(); }",
 'lobby-invite': "()=>{ SO.popup=null; ON.code='ABCDE'; ON.status='open'; ON.role='host'; ON.seat=0; ON.roomSeats=2; ON.lobby=defaultLobby(2); ON.seats=[{seat:0,name:'Kal',online:true}]; SO.lobbyFor='ABCDE'; SO.invited={sam:'ABCDE'}; UI.screen='online'; render(); }",
 'tutorial1': "()=>{ ON.code=null; ON.status='idle'; ON.role=null; ON.seat=null; ACCT=null; UI.screen='tutorial'; TUT.page=0; render(); }",
 'tutorial2': "()=>{ TUT.page=1; render(); }",
 'tutorial3': "()=>{ TUT.page=2; render(); }",
 'tutorial4': "()=>{ TUT.page=3; render(); }",
 'tutorial5': "()=>{ TUT.page=4; render(); }",
 'tutorial6': "()=>{ TUT.page=5; render(); }",
 'tutorial7': "()=>{ TUT.page=6; render(); }",
 'tutorial8': "()=>{ TUT.page=7; render(); }",
 'tutorial-game': "()=>{ tutBegin(); fxReset(); render(); }",
 'tutorial-next': "()=>{ TUT.step=2; render(); }",
 'tutorial-done': "()=>{ finishGame(); }",
 'tutorial-out': "()=>{ tutLeave('title'); }",
 'replay-bar': "()=>{ startReplay(JSON.parse(gameFile(Object.assign({}, PROFILE.games[0], {replay:{v:1, setup:{seed:5, players:2, kinds:['human','bot'], names:['Kal','Bot'], deckOf:[LIB.decks[0].id, LIB.decks[0].id], planets:5, rounds:6, mulligan:false, simul:false, sandbox:false, lib:replayLibSnapshot([LIB.decks[0]])}, cmds:[]}})))); fxReset(); UI.rp.playing=false; render(); }",
 'replay-exit': "()=>{ stopReplay(true); G=null; UI.screen='title'; render(); }",
 'online':  "()=>{ UI.sheet=null; UI.screen='online'; render(); }",
 'lobby':   "()=>{ ON.code='ABCDE'; ON.status='open'; ON.role='host'; ON.seat=0; ON.roomSeats=2; ON.lobby=defaultLobby(2); ON.seats=[{seat:0,name:'Kal',online:true},{seat:1,name:'Sam',online:true}]; UI.screen='online'; render(); }",
 'lobby-guest': "()=>{ ON.role='guest'; ON.seat=1; ON.decks=LIB.decks.map(d=>({id:d.id,name:d.name,n:d.cards.length})); render(); }",
 'game':    "()=>{ ON.code=null; ON.status='idle'; ON.role=null; ON.seat=null; LIB.settings.players=2; LIB.settings.kinds=['human','bot']; LIB.settings.placement='turns'; LIB.settings.sandbox=false; LIB.settings.turnTimer=60; LIB.settings.hide=false; UI.screen='game'; newGame(); }",
 'round-open': "()=>{ fxReset(); UI.dice={round:G.round, landed:true}; render(); }",
 'board':   "()=>{ UI.dice=null; render(); }",
 'menu':    "()=>{ UI.sheet='menu'; render(); }",
 'log':     "()=>{ UI.sheet='log'; render(); }",
 'grave':   "()=>{ UI.sheet='grave'; render(); }",
 'inspect': "()=>{ UI.sheet=null; inspectCard(G.players[0].hand[0].uid); }",
 'choice':  "()=>{ UI.sheet=null; UI.peek=null; G.choice={kind:'discard', act:'discard', player:0, chooser:0, left:1, gone:[], ctx:{owner:0, uid:G.players[0].hand[0].uid}, f:{v:'discard', n:1}}; render(); }",
 'optional':"()=>{ G.choice={kind:'optional', owner:0, f:{v:'draw', n:1, optional:true}, ctx:{owner:0, uid:G.players[0].hand[0].uid}}; render(); }",
 'peekboard': "()=>{ UI.choicePeek=G.choice; render(); }",
 'summon':  "()=>{ UI.choicePeek=null; G.choice={kind:'pickslot', purpose:'summon', owner:0, side:0, options:[[0,0],[0,1],[1,0]], f:{v:'summon', tok:LIB.tokens[0].id}, ctx:{owner:0, uid:G.players[0].hand[0].uid}}; render(); }",
 'net-banner': "()=>{ G.choice=null; G.online=true; ON.code='ABCDE'; ON.status='open'; ON.role='host'; ON.seat=0; NET.seat=0; ON.seats=[{seat:0,name:'Kal',online:true},{seat:1,name:'Sam',online:false}]; render(); }",
 'gameend': "()=>{ G.online=false; ON.code=null; ON.status='idle'; ON.role=null; NET.seat=null; G.choice=null; UI.choicePeek=null; UI.roundScreen={gameEnd:true, ended:6, next:7, ms:2500, uids:[]}; render(); }",
 'sandbox': "()=>{ UI.roundScreen=null; G.sandbox=true; UI.sheet='sandbox'; render(); }",
 'result':  "()=>{ UI.sheet=null; G.sandbox=false; finishGame(); }",
}

total = 0
with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ('light', 'dark'):
        for forced in (None, 'light', 'dark'):
            if forced and forced != scheme: continue        # system theme, and the in-app switch to the same theme
            ctx = b.new_context(viewport={'width':390, 'height':844}, color_scheme=scheme, device_scale_factor=1)
            pg = ctx.new_page()
            pg.goto(url); pg.wait_for_function("LIB && LIB.cards.length > 10")
            if forced: pg.evaluate(f"document.documentElement.dataset.theme='{forced}'")
            pg.evaluate("LIB.settings.anim=false")
            # measure the finished screen, not a frame of its entrance
            pg.add_style_tag(content="*,*::before,*::after{animation:none!important;transition:none!important}")
            pg.add_style_tag(content="*,*::before,*::after{animation:none!important;transition:none!important}")
            for name, js in SCREENS.items():
                try: pg.evaluate(js)
                except Exception as e: print('  (could not open', name, e, ')'); continue
                pg.wait_for_timeout(120)
                bad = measure(pg)
                label = f"{scheme}{'/forced' if forced else ''} {name}"
                for x in bad:
                    total += 1
                    if '-q' in sys.argv: continue
                    print(f"FAIL {label:24} {x['ratio']:>5} < {x['need']}  {x['tag']}.{x['cls'][:36]:36}  \"{x['text']}\"  {x['color']} on {x['bg']}")
            ctx.close()
    b.close()
print('contrast:', 'all text passes' if not total else f'{total} failures')
sys.exit(1 if total else 0)
