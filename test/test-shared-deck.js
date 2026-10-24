/* One shared deck: whole games with every player drawing from one pile.
   node test/test-shared-deck.js */
'use strict';
const { boot, playGame, settle, sleep } = require('./harness');
let fails = 0;
const check = (c, m) => { if(!c){ fails++; console.log('  FAIL', m); } };
(async () => {
  for(const m of [{ players:2, kinds:['human','bot'] }, { players:3, kinds:['bot','bot','human'] }, { players:4, kinds:['bot','bot','bot','bot'], placement:'simultaneous' }]){
    const seed = 900 + m.players;
    let first = true;
    const r = await playGame(Object.assign({ seed: 11, gameSeed: seed, deckOf:['d1','d2','d3','d1'], planets:5,
      beforeStart(env){ env.ev(`LIB.settings.sharedDeck = true; LIB.settings.sharedDeckId = 'd2';`); },
      onStep(env){
        if(!first) return; first = false;
        const st = env.ev(`(function(){ var d = LIB.decks.find(function(x){ return x.id==='d2'; });
          return { one: G.players.every(function(p){ return p.deck === G.players[0].deck; }), shared: G.sharedDeck,
                   total: G.players[0].deck.length + G.players.reduce(function(t,p){ return t + p.hand.length; }, 0) + G.planets.reduce(function(t,pl){ return t + pl.board.reduce(function(u,row){ return u + row.filter(Boolean).length; }, 0); }, 0) + G.grave.length, want: d.cards.length * G.players.length }; })()`);
        check(st.shared && st.one, 'every player draws from the same pile');
        check(st.total === st.want, `the pile is the deck once per player (${st.total} of ${st.want})`);
      } }, m));
    check(r.result && !r.errors.length, `${m.players} players: the game finishes cleanly ${JSON.stringify(r.errors.map(String).slice(0,2))}`);
    const own = r.env.ev(`G.players.every(function(p){ return p.hand.every(function(c){ return c.owner === p.idx; }); })`);
    check(own, 'a drawn card belongs to whoever drew it');
    const uids = r.env.ev(`(function(){ var out = G.players[0].deck.map(function(c){ return c.uid; });
      G.players.forEach(function(p){ p.hand.forEach(function(c){ out.push(c.uid); }); });
      G.planets.forEach(function(pl){ pl.board.forEach(function(row){ row.forEach(function(c){ if(c) out.push(c.uid); }); }); });
      G.grave.forEach(function(c){ out.push(c.uid); }); return out; })()`);
    check(new Set(uids).size === uids.length, 'no card is in two places');
    /* the replay of a shared-deck game reaches the same end */
    const rp = r.env.ev('JSON.stringify(replayBundle(G))'), digest = r.env.ev('stateDigest()');
    r.env.win.close();
    const env = boot();
    const b = JSON.parse(rp);
    env.ev(`UI.screen='game'; startReplay(${JSON.stringify({ summary:{ seat:0 }, replay:b })}); UI.rp.speed = 4;`);
    for(let i = 0; i < 4000 && !env.ev('G && G.over'); i++){ await settle(env.win, 2); env.ev('UI.rp && (UI.rp.step = true, rpTick())'); await sleep(0); }
    check(env.ev('G.over') && env.ev('stateDigest()') === digest, `${m.players} players: the replay ends in the same state`);
    env.win.close();
    console.log(`ok   shared deck, ${m.players} players`);
  }
  console.log(fails ? fails + ' failures' : 'shared deck: all checks passed');
  process.exit(fails ? 1 : 0);
})();
