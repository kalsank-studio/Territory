/* The turn timer and the sandbox bench both act through commands now. */
'use strict';
const { boot, settle, sleep } = require('./harness');
let fails = 0; const check = (c, m) => { if(!c){ fails++; console.log('  FAIL', m); } };
(async () => {
  for(const placement of ['turns', 'simultaneous']){
    const env = boot();
    env.ev(`LIB.settings.players=2; LIB.settings.kinds=['human','bot','bot','bot']; LIB.settings.turnTimer=30; LIB.settings.seed=9;
            LIB.settings.placement='${placement}'; LIB.settings.deckOf=['d3','d3','d3','d3']; LIB.settings.sandbox=false; UI.screen='game'; newGame();`);
    /* run the clock out on every human turn, for the whole game */
    let guard = 0;
    while(!env.ev('G.over') && guard++ < 6000){
      await settle(env.win, 2);
      env.ev(`(function(){ var k = timerKey(); if(!k) return;
        /* place one card first, so there is something for the clock to turn over in the reveal */
        var me = G.players[0];
        if(G.phase==='placement' && !me.placed.length){ var c = me.hand.filter(function(x){ return canPlace(me,x); })[0];
          if(c){ for(var pi=0; pi<G.planets.length; pi++){ var si = G.planets[pi].board[0].indexOf(null); if(si>=0 && dispatch({t:'place', seat:0, uid:c.uid, p:pi, s:si}).ok) break; } } }
        tickTimer(); if(UI.timer){ UI.timer.left = 0; UI.timer.last = Date.now(); } tickTimer(); })()`);
      await sleep(0);
    }
    check(env.ev('G.over'), `${placement}: a game played entirely by the turn timer reaches the end`);
    const kinds = env.ev(`G.cmdLog.filter(function(c){ return c.seat===0; }).map(function(c){ return c.t + (c.early ? '!' : ''); })`);
    check(kinds.includes('lock') && kinds.includes('endReveal!') && kinds.includes('flip'), `${placement}: the timer's moves are logged as commands ${JSON.stringify([...new Set(kinds)])}`);
    env.win.close();
    console.log('ok   timer', placement);
  }
  {
    const env = boot();
    env.ev(`LIB.settings.players=2; LIB.settings.kinds=['human','human','bot','bot']; LIB.settings.turnTimer=0; LIB.settings.sandbox=true; UI.screen='game'; newGame();`);
    await settle(env.win, 6);
    const e0 = env.ev('G.players[1].energy');
    const r = env.ev(`dispatch({t:'sandbox', seat:0, op:'energy', i:1, v:5})`);
    check(r.ok && env.ev('G.players[1].energy') === e0 + 5, 'the sandbox bench works through a command');
    const h = env.ev('G.players[0].hand.length');
    env.ev(`dispatch({t:'sandbox', seat:0, op:'add', i:0, id:'heart'})`);
    check(env.ev('G.players[0].hand.length') === h + 1, 'sandbox: add a card');
    env.ev(`dispatch({t:'sandbox', seat:0, op:'reset'})`); await settle(env.win, 6);
    check(env.ev('G.phase') === 'placement' && !env.ev('G.hold'), 'sandbox: reset leaves the board ready');
    env.win.close();
    console.log('ok   sandbox');
  }
  console.log(fails ? fails + ' failures' : 'all checks passed'); process.exit(fails ? 1 : 0);
})();
