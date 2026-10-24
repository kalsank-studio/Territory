/* Headless harness: loads the game into jsdom, compresses every timer to 0 ms
   so a whole game runs in a second or two, and drives human seats through the
   real UI (data-act clicks), exactly as a person tapping would. */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function boot(opts = {}){
  const dir = opts.dir || path.join(__dirname, '..', 'game');
  const js = fs.readFileSync(path.join(dir, 'game.js'), 'utf8');
  const pre = `
    (function(){
      var st = window.setTimeout.bind(window);
      window.setTimeout = function(fn, ms){ var a = [].slice.call(arguments, 2); return st(function(){ fn.apply(null, a); }, 0); };
      window.setInterval = function(){ return 0; };          /* the turn timer is driven by hand in the tests */
      window.requestAnimationFrame = function(fn){ return st(fn, 0); };
      window.cancelAnimationFrame = function(){};
    })();`;
  const html = `<!DOCTYPE html><html><head></head><body><div id="app"></div><div id="overlay"></div>
    <script>${pre}</script><script>${js}</script></body></html>`;
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/', pretendToBeVisual: false });
  const win = dom.window;
  const errors = [];
  win.addEventListener('error', e => errors.push(e.error || e.message));
  const ev = s => win.eval(s);
  return { dom, win, ev, errors, doc: win.document };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Let every 0 ms timer chain run out. */
async function settle(win, rounds = 6){ for(let i = 0; i < rounds; i++) await new Promise(r => win.setTimeout(r, 0)); }

/** A tiny seeded PRNG for the harness's own decisions (not the game's). */
function prng(seed){ let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

function click(env, el){
  const ev = new env.win.MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
}
const all = (env, sel) => [...env.doc.querySelectorAll(sel)];

/** Every card in the game, wherever it is: no uid may appear twice. */
function census(env){
  return env.ev(`(function(){
    var out = [];
    G.players.forEach(function(p){ p.deck.concat(p.hand).forEach(function(c){ out.push(c.uid); }); });
    G.planets.forEach(function(pl){ pl.board.forEach(function(row){ row.forEach(function(c){ if(c) out.push(c.uid); }); }); });
    G.grave.forEach(function(c){ out.push(c.uid); });
    return out;
  })()`);
}

/**
 * Play one whole game. Human seats are driven through the DOM.
 * opts: {players, kinds, planets, rounds, seed (harness), sandbox, hide, placement}
 * Returns {result, steps, actions, errors, env}.
 */
async function playGame(opts = {}){
  const env = opts.env || boot(opts);
  const R = prng(opts.seed || 1);
  const n = opts.players || 2;
  const kinds = opts.kinds || Array.from({ length: n }, () => 'bot');
  env.ev(`
    LIB.settings.players = ${n};
    LIB.settings.kinds = ${JSON.stringify(kinds)}.concat(['bot','bot','bot','bot']).slice(0,4);
    LIB.settings.planets = ${opts.planets || 5};
    LIB.settings.rounds = ${opts.rounds || 6};
    LIB.settings.hide = ${opts.hide !== false};
    LIB.settings.sandbox = ${!!opts.sandbox};
    LIB.settings.turnTimer = 0;
    ${opts.placement ? `LIB.settings.placement = ${JSON.stringify(opts.placement)};` : ''}
    ${opts.deckOf ? `LIB.settings.deckOf = ${JSON.stringify(opts.deckOf)};` : ''}
    ${opts.gameSeed != null ? `LIB.settings.seed = ${opts.gameSeed};` : 'delete LIB.settings.seed;'}
  `);
  if(opts.beforeStart) opts.beforeStart(env);
  click(env, env.doc.querySelector('[data-act="newgame"]') || env.doc.body);
  env.ev(`UI.screen = 'setup'; render();`);
  click(env, env.doc.querySelector('[data-act="begin"]'));

  const startCount = census(env).length;
  let steps = 0, idle = 0, actions = 0;
  const log = [];
  while(steps++ < (opts.maxSteps || 40000)){
    await settle(env.win, 2);
    const st = env.ev(`(function(){
      var p = currentPlayer();
      return { over: !!G.over, gate: !!UI.gate, choice: G.choice ? {kind:G.choice.kind, owner:G.choice.owner, chooser:G.choice.chooser} : null,
        phase: G.phase, round: G.round, cur: p ? p.idx : null, curKind: p ? p.kind : null, busy: busy(), mine: myTurn(),
        view: viewerIdx() };
    })()`);
    if(opts.onStep) opts.onStep(env, st);
    if(st.over) break;
    if(st.gate){ const b = env.doc.querySelector('[data-act="ungate"]'); if(b){ click(env, b); actions++; idle = 0; continue; } }
    if(st.choice){
      const sels = ['[data-act="pickdiscard"]','[data-act="pickplayer"]','[data-act="movedest"]','[data-act="pickmode"]:not([disabled])','[data-act="targetcard"]','[data-act="pickslot"]','[data-act="pickoptional"]'];
      const opt = sels.flatMap(s => all(env, s));
      if(opt.length){ click(env, opt[Math.floor(R()*opt.length)]); actions++; idle = 0; continue; }
    }
    if(!st.busy && st.mine && st.curKind === 'human' && !st.choice){
      if(st.phase === 'placement'){
        /* place a few affordable cards, sometimes move or take one back, then lock in */
        let placed = 0;
        for(let k = 0; k < 6; k++){
          const hand = all(env, '.tray .card[data-act="hand"]:not(.unaffordable)');
          if(!hand.length || R() < 0.25) break;
          click(env, hand[Math.floor(R()*hand.length)]);
          const open = all(env, '.slot[data-act="drop"]');
          if(!open.length){ env.ev('UI.sel = null; render();'); break; }
          click(env, open[Math.floor(R()*open.length)]); placed++; actions++;
        }
        if(placed && R() < 0.3){
          const lift = all(env, '.slot[data-act="lift"]');
          if(lift.length){ click(env, lift[Math.floor(R()*lift.length)]);
            const back = env.doc.querySelector('[data-act="tohand"]');
            if(back && R() < 0.5){ click(env, back); }
            else { const open = all(env, '.slot[data-act="drop"]'); if(open.length) click(env, open[Math.floor(R()*open.length)]); else env.ev('UI.sel=null;render()'); }
            actions++;
          }
        }
        const end = env.doc.querySelector('[data-act="endturn"]');
        if(end){ click(env, end); actions++; idle = 0; continue; }
      }
      if(st.phase === 'reveal'){
        const flip = all(env, '[data-act="flip"]');
        if(flip.length){ click(env, flip[Math.floor(R()*flip.length)]); actions++; idle = 0; continue; }
        const act = all(env, '.slot[data-act="activate"]');
        if(act.length && R() < 0.5){ click(env, act[0]); actions++; idle = 0; continue; }
        const end = env.doc.querySelector('[data-act="endreveal"]');
        if(end){ click(env, end); actions++; idle = 0; continue; }
      }
    }
    if(++idle > 400){ log.push('stuck: ' + JSON.stringify(st)); break; }
    await sleep(0);
  }
  const ids = census(env);
  const dupes = ids.filter((u, i) => ids.indexOf(u) !== i);
  const result = env.ev('G.result ? JSON.parse(JSON.stringify(G.result)) : null');
  return { result, steps, actions, errors: env.errors.slice(), log, env, dupes, startCount, endCount: ids.length };
}

module.exports = { boot, playGame, settle, click, all, prng, census, sleep };
