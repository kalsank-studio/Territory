/* Plays a batch of whole games in every seating arrangement and checks each one
   finishes with a result, no script errors, and no card duplicated.
   node test/test-games.js [gamesPerMode] [dir] */
'use strict';
const path = require('path');
const { playGame } = require('./harness');

const N = +process.argv[2] || 4;
const dir = process.argv[3] ? path.resolve(process.argv[3]) : path.join(__dirname, '..', 'game');
const deckOf = ['d3','d3','d3','d3'];   // the showcase deck: every ability family
const MODES = [
  { name:'bots 2p',            players:2, kinds:['bot','bot'] },
  { name:'human vs bot',       players:2, kinds:['human','bot'] },
  { name:'hot-seat 2 humans',  players:2, kinds:['human','human'] },
  { name:'hot-seat 3 mixed',   players:3, kinds:['human','bot','human'] },
  { name:'4p bots',            players:4, kinds:['bot','bot','bot','bot'], planets:6 },
  ...(process.env.SIMUL ? [
  { name:'simultaneous h v b', players:2, kinds:['human','bot'], placement:'simultaneous' },
  { name:'simultaneous 3p',    players:3, kinds:['human','bot','bot'], placement:'simultaneous' },
  { name:'simultaneous bots',  players:2, kinds:['bot','bot'], placement:'simultaneous' } ] : [])
];

(async () => {
  let bad = 0;
  for(const m of MODES){
    for(let g = 0; g < N; g++){
      const r = await playGame(Object.assign({ dir, seed: 1000 + g * 7, deckOf }, m));
      const ok = r.result && !r.errors.length && !r.dupes.length && !r.log.length;
      if(!ok){ bad++; console.log('FAIL', m.name, g, { result: !!r.result, errors: r.errors.map(String).slice(0,3), dupes: r.dupes.slice(0,3), log: r.log }); }
      r.env.win.close();
    }
    console.log('ok  ', m.name, 'x' + N);
  }
  console.log(bad ? `${bad} failures` : 'all games finished cleanly');
  process.exit(bad ? 1 : 0);
})();
