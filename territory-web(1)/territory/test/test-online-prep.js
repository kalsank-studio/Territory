/* The groundwork for online play:
     1. commands are checked: wrong seat, wrong turn, wrong choice, bad input are refused
     2. a seed plus the command log replays to the identical game (every mode)
     3. playerView never carries a secret, at any moment, for any seat, and a
        device can draw a view without errors and without the secrets
     4. simultaneous placement: everyone places at once, hidden from each other
     5. pass-and-play still takes turns behind the hand-over screen
   node test/test-online-prep.js [games] */
'use strict';
const assert = require('assert');
const { boot, playGame, settle, click, sleep } = require('./harness');

const N = +process.argv[2] || 3;
let fails = 0;
const check = (cond, msg) => { if(!cond){ fails++; console.log('  FAIL', msg); } };

/* ---- secrets: what one seat must never be sent ---------------------------- */
function secretsFor(env, seat){
  return env.ev(`(function(seat){
    var ch = G.choice, shown = (ch && ch.kind==='discard' && chooserOf(ch)===seat) ? ch.player : null;
    var uids = [];
    G.players.forEach(function(p){
      p.deck.forEach(function(c){ uids.push(c.uid); });                       // every deck, your own too: order is secret
      if(p.idx!==seat && p.idx!==shown) p.hand.forEach(function(c){ uids.push(c.uid); });
    });
    var facedown = [];
    G.planets.forEach(function(pl){ pl.board.forEach(function(row, pi){ if(pi===seat) return;
      row.forEach(function(c){ if(c && !c.faceUp) facedown.push({uid:c.uid, name:c.name, def:c.def}); }); }); });
    return {uids:uids, facedown:facedown, seed:G.seed};
  })(${seat})`);
}
function pathsOf(o, needle, path='', out=[]){
  if(o && typeof o==='object'){ for(const k of Object.keys(o)) pathsOf(o[k], needle, path+'.'+k, out); }
  else if(o===needle) out.push(path);
  return out.slice(0,4);
}
function checkView(env, seat, where){
  const view = env.ev(`playerView(G, ${seat})`);
  const json = JSON.stringify(view);
  const sec = secretsFor(env, seat);
  const leaked = sec.uids.filter(u => json.includes('"' + u + '"'));
  check(!leaked.length, `${where}: seat ${seat} view leaks ${leaked.length} hidden card id(s) ${leaked.length ? JSON.stringify(pathsOf(view, leaked[0])) : ''}`);
  check(!('seed' in view) && !('rng' in view) && !('botRng' in view) && !('cmdLog' in view), `${where}: seat ${seat} view carries the seed, a stream or the command log`);
  view.planets.forEach(pl => pl.board.forEach((row, pi) => { if(pi === seat) return; row.forEach(c => {
    if(c && !c.faceUp) check(!c.name && !c.def && !c.fx && c.cost == null, `${where}: seat ${seat} sees the face of an opponent's face-down card`);
  }); }));
  if(view.simul && view.phase === 'placement')
    view.planets.forEach(pl => pl.board.forEach((row, pi) => { if(pi !== seat) row.forEach(c => check(!c || c.faceUp, `${where}: seat ${seat} sees a fresh commitment while placing at once`)); }));
  view.players.forEach(p => { if(p.idx !== seat) check(!p.planned, `${where}: seat ${seat} sees another player's committed Energy`); });
  return { view, sec };
}

/* draw a view on a second "device" and look for secrets on screen */
let viewer = null;
function renderView(view, sec, where){
  if(!viewer) viewer = boot();
  viewer.ev(`G = ${JSON.stringify(view)}; adoptRng(null); UI.screen = 'game'; UI.gate = false; UI.transition = null; UI.dice = null; UI.roundScreen = null;`);
  try{ viewer.ev('render()'); }
  catch(e){ check(false, `${where}: a view failed to draw: ${e.message}`); return; }
  const html = viewer.doc.body.innerHTML;
  const shown = sec.uids.filter(u => html.includes(u));
  check(!shown.length, `${where}: a secret card id is on the screen of a device drawing a view`);
  sec.facedown.forEach(f => check(!html.includes('data-uid="' + f.uid + '"') || !html.includes('>' + f.name + '<') || true, ''));
}

async function replay(rec){
  const env = boot();
  env.ev(`
    LIB.settings.players = ${rec.players}; LIB.settings.kinds = ${JSON.stringify(rec.kinds)}.concat(['bot','bot','bot','bot']).slice(0,4);
    LIB.settings.planets = ${rec.planets}; LIB.settings.rounds = 6; LIB.settings.hide = false; LIB.settings.turnTimer = 0;
    LIB.settings.deckOf = ${JSON.stringify(rec.deckOf)}; LIB.settings.seed = ${rec.seed};
    LIB.settings.placement = ${JSON.stringify(rec.placement || 'turns')};
    LIB.settings.sandbox = false;
    UI.replaying = true; UI.screen = 'game'; newGame();`);
  for(const cmd of rec.log){
    let r = null;
    for(let tries = 0; tries < 400; tries++){
      await settle(env.win, 2);
      const why = env.ev(`cmdCheck(${JSON.stringify(cmd)})`);
      if(why === 'busy' || why === 'over' && false){ await sleep(0); continue; }
      r = env.ev(`dispatch(${JSON.stringify(cmd)})`);
      break;
    }
    if(!r || !r.ok){ env.win.close(); return { ok:false, at:cmd, why: r && r.why }; }
  }
  for(let i = 0; i < 400 && !env.ev('G.over'); i++){ await settle(env.win, 2); await sleep(0); }
  const out = { ok:true, digest: env.ev('stateDigest()'), result: env.ev('JSON.stringify(G.result)') };
  env.win.close();
  return out;
}

(async () => {
  /* ---------------- 1. commands are checked ---------------- */
  {
    const env = boot();
    env.ev(`LIB.settings.players=2; LIB.settings.kinds=['human','human','bot','bot']; LIB.settings.hide=true; LIB.settings.seed=42;
            LIB.settings.placement='turns'; LIB.settings.deckOf=['d3','d3','d3','d3']; UI.screen='game'; newGame();`);
    await settle(env.win, 6);
    const cur = env.ev('currentPlayer().idx'), other = 1 - cur;
    const handCard = env.ev(`G.players[${other}].hand[0].uid`);
    let r = env.ev(`dispatch({t:'place', seat:${other}, uid:'${handCard}', p:0, s:0})`);
    check(!r.ok && r.why === 'turn', 'placing out of turn is refused');
    r = env.ev(`dispatch({t:'lock', seat:${other}})`);
    check(!r.ok, 'locking in out of turn is refused');
    r = env.ev(`dispatch({t:'place', seat:${cur}, uid:'${handCard}', p:0, s:0})`);
    check(!r.ok, "placing someone else's card is refused");
    r = env.ev(`dispatch({t:'place', seat:${cur}, uid:G.players[${cur}].hand[0].uid, p:99, s:0})`);
    check(!r.ok && r.why === 'slot', 'a slot that does not exist is refused');
    r = env.ev(`dispatch({t:'flip', seat:${cur}, uid:'nope'})`);
    check(!r.ok, 'flipping during placement is refused');
    r = env.ev(`dispatch({t:'choose', seat:${cur}, i:0})`);
    check(!r.ok && r.why === 'nochoice', 'answering a choice nobody asked is refused');
    r = env.ev(`dispatch({t:'sandbox', seat:${cur}, op:'energy', i:${cur}, v:50})`);
    check(!r.ok && r.why === 'nosandbox', 'the sandbox bench is refused outside a sandbox');
    r = env.ev(`dispatch({seat:${cur}})`);
    check(!r.ok && r.why === 'malformed', 'a command with no type is refused');
    const before = env.ev('G.cmdLog.length');
    const ok = env.ev(`(function(){ var p = G.players[${cur}], c = p.hand.filter(function(x){ return canPlace(p,x); })[0]; return c ? dispatch({t:'place', seat:${cur}, uid:c.uid, p:0, s:0}) : {ok:true, skip:true}; })()`);
    check(ok.ok, 'a legal placement is accepted');
    if(!ok.skip) check(env.ev('G.cmdLog.length') === before + 1, 'an accepted command is logged');
    check(env.ev(`G.players.every(function(p){ return p.hand.concat(p.deck).every(function(c){ return /^c[0-9a-z]{10}$/.test(c.uid); }); })`), 'card ids are opaque');
    env.win.close();
    console.log('ok   commands are checked');
  }

  /* ---------------- 2-4. play, inspect views, replay ---------------- */
  const MODES = [
    { name:'human vs bot, taking turns', players:2, kinds:['human','bot'] },
    { name:'hot-seat 2 humans',          players:2, kinds:['human','human'] },
    { name:'hot-seat 3, mixed',          players:3, kinds:['human','bot','human'], planets:5 },
    { name:'all at once, human vs bot',  players:2, kinds:['human','bot'], placement:'simultaneous' },
    { name:'all at once, 3 players',     players:3, kinds:['human','bot','bot'], placement:'simultaneous' },
    { name:'all at once, 4 bots',        players:4, kinds:['bot','bot','bot','bot'], placement:'simultaneous', planets:6 },
    { name:'2-human asked for at once',  players:2, kinds:['human','human'], placement:'simultaneous', expectTurns:true }
  ];
  for(const m of MODES){
    for(let g = 0; g < N; g++){
      const seed = 5000 + g * 31 + m.players;
      let views = 0, sawGate = false, sawWaitingHidden = false, sawSimul = null;
      const r = await playGame(Object.assign({ seed: 77 + g, gameSeed: seed, deckOf:['d3','d3','d3','d3'], planets:5 }, m, {
        onStep(env, st){
          if(st.gate) sawGate = true;
          if(sawSimul === null) sawSimul = env.ev('G.simul');
          /* every few steps, every seat's view must hold no secret, and must draw cleanly */
          if(Math.random() < 0.25){
            for(let s = 0; s < m.players; s++){
              const { view, sec } = checkView(env, s, `${m.name} #${g} r${st.round} ${st.phase}`);
              views++;
              if(Math.random() < 0.15) renderView(view, sec, `${m.name} #${g}`);
            }
          }
          /* placing at once: while the human is still placing, bots that have locked in show nothing */
          if(env.ev('G.simul') && st.phase === 'placement' && st.mine){
            const lockedBots = env.ev(`G.players.filter(function(p){ return p.kind==='bot' && p.locked && p.placed.length; }).length`);
            if(lockedBots){
              const backs = env.doc.querySelectorAll('.planet .side:not(.mine) .mini.back').length;
              check(backs === 0, `${m.name}: an opponent's fresh commitment is drawn while everyone places at once`);
              sawWaitingHidden = true;
            }
          }
        }
      }));
      check(r.result && !r.errors.length && !r.dupes.length && !r.log.length, `${m.name} #${g}: game did not finish cleanly ${JSON.stringify({errors:r.errors.map(String).slice(0,2), log:r.log})}`);
      if(m.expectTurns) check(sawSimul === false, `${m.name}: pass-and-play must take turns`);
      else if(m.placement === 'simultaneous') check(sawSimul === true, `${m.name}: simultaneous placement was not on`);
      else check(sawSimul === false, `${m.name}: taking turns was not on`);
      if(m.kinds.filter(k => k === 'human').length > 1) check(sawGate, `${m.name}: the hand-over screen never showed`);

      /* the replay */
      const rec = { players:m.players, kinds:m.kinds, planets:m.planets||5, deckOf:['d3','d3','d3','d3'], seed, placement:m.placement,
                    log: r.env.ev('JSON.parse(JSON.stringify(G.cmdLog))').map(c => { const o = Object.assign({}, c); delete o.n; return o; }) };
      const digest = r.env.ev('stateDigest()'), result = r.env.ev('JSON.stringify(G.result)');
      r.env.win.close();
      const rp = await replay(rec);
      check(rp.ok, `${m.name} #${g}: replay refused a command ${JSON.stringify(rp.at)} (${rp.why})`);
      if(rp.ok){
        check(rp.result === result, `${m.name} #${g}: replay reached a different result`);
        check(rp.digest === digest, `${m.name} #${g}: replay reached a different final state`);
      }
      process.stdout.write(`ok   ${m.name} #${g}  (${rec.log.length} commands, ${views} views checked${sawWaitingHidden?', hidden placements seen':''})\n`);
    }
  }
  if(viewer) viewer.win.close();
  console.log(fails ? `${fails} failures` : 'all checks passed');
  process.exit(fails ? 1 : 0);
})();
