/* The match log and the bot-free records, against a real local Worker
   (or BASE=… ADMIN_PW=… for a deployed copy).
   Needs ADMIN_PASSWORD in .dev.vars.   node test/test-matches.mjs */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
let BASE = process.env.BASE, dev = null, fails = 0;
let PW = process.env.ADMIN_PW;
if(!PW){ try{ PW = readFileSync('.dev.vars', 'utf8').match(/ADMIN_PASSWORD\s*=\s*"?([^"\n]*)"?/)[1]; }catch(e){} }
const check = (c, m) => { if(!c){ fails++; console.log('  FAIL', m); } else console.log('  ok  ', m); };
async function startDev(){
  const port = 9200 + Math.floor(Math.random() * 100);
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  BASE = `http://127.0.0.1:${port}`;
  for(let i = 0; i < 120; i++){ try{ const r = await fetch(BASE + '/api/rooms/NOPE0'); if(r.status) return; }catch(e){} await wait(500); }
  throw new Error('wrangler dev did not start');
}
const call = async (method, path, body, token, ip) => {
  const h = { 'Content-Type': 'application/json' };
  if(token) h.Authorization = 'Bearer ' + token;
  h['CF-Connecting-IP'] = ip || '198.51.100.' + Math.floor(Math.random() * 250);
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try{ j = await r.json(); }catch(e){}
  return { status: r.status, body: j || {} };
};
const tag = Math.random().toString(36).slice(2, 7);
const now = Date.now();
let tick = 0;
const match = (id, extra) => Object.assign({ id, at: now - 300000 + (tick++) * 1000, started: now - 900000, mode: 'local', rounds: 6,
  players: [{ name: 'Ana' + tag, emoji: '🦊' }, { name: 'Rival', bot: true }], won: [3, 2], winner: 0, reason: 'planets won',
  rows: [{ name: 'Oasis', scores: [7, 3], winner: 0 }], log: [{ rd: 1, t: 'Round 1' }, { t: 'Ana plays Spore Drone.', w: 0 }, { t: 'secret draw', w: 0, p: 1 }],
  replay: { v: 1, setup: { seed: 1, players: 2 }, cmds: [{ t: 'lock', seat: 0 }] }, v: '0.9.5' }, extra || {});
const entry = (id, seat, bot, result) => ({ id, at: now, mode: 'local', seat, result, won: [3, 2], rounds: 6,
  players: [{ name: 'Ana' }, { name: bot ? 'Rival' : 'Ben', bot: !!bot }], rows: [{ name: 'Oasis', scores: [7, 3], winner: 0 }],
  stats: { v: 1, won: result === 'win' ? 1 : 0, draws: [1, 0, 0, 0, 0, 0], power: [2, 4, 6, 8, 9, 10], slots: [], cards: [{ n: 'Spore Drone', pw: 1 }] }, log: [{ t: 'x' }] });

try{
  if(!PW) throw new Error('No admin password: put ADMIN_PASSWORD in .dev.vars');
  if(!BASE) await startDev();
  console.log('matches at', BASE);
  const ad = (await call('POST', '/api/admin/login', { password: PW })).body.token;

  console.log('— anyone can add a finished match —');
  let r = await call('POST', '/api/matches', { match: match('m' + tag + 'a') });
  check(r.status === 200 && r.body.added === true, 'a signed-out game adds its match');
  r = await call('POST', '/api/matches', { match: match('m' + tag + 'a') });
  check(r.status === 200 && r.body.added === false, 'the same match twice is kept once');
  r = await call('POST', '/api/matches', { match: { id: 'x' } });
  check(r.status === 400, 'a malformed match is refused');
  r = await call('POST', '/api/matches', { match: match('m' + tag + 'b', { mode: 'online', players: [{ name: 'Ana' + tag }, { name: 'Ben' }] }) });
  check(r.body.added, 'an online match between two people');
  r = await call('POST', '/api/matches', { match: match('m' + tag + 'c', { sandbox: true }) });
  check(r.body.added, 'a sandbox match');
  r = await call('POST', '/api/matches', { match: match('m' + tag + 'd', { players: [{ name: 'Bot A' + tag, bot: true }, { name: 'Bot B', bot: true }], winner: null }) });
  check(r.body.added, 'a bots-only match');

  console.log('— only the admin can read it —');
  r = await call('GET', '/api/admin/matches');
  check(r.status === 401, 'no session, no match log');
  const pl = await call('POST', '/api/account/register', { username: 'ana' + tag, password: 'pass1234' });
  r = await call('GET', '/api/admin/matches', null, pl.body.token);
  check(r.status === 401, 'a player token is not enough');
  r = await call('GET', '/api/admin/matches?q=' + 'm' + tag + 'a', null, ad);
  check(r.status === 200 && r.body.matches.length === 1 && r.body.total >= 4, 'the admin finds it by id, with the total kept');
  const s = r.body.matches[0];
  check(s && !s.log && !s.replay && s.hasLog && s.hasReplay && s.bots === 1, 'the list carries summaries, not logs');
  r = await call('GET', '/api/admin/matches?q=' + tag, null, ad);
  const ids = r.body.matches.map(m => m.id);
  check(ids.indexOf('m' + tag + 'd') < ids.indexOf('m' + tag + 'a'), 'newest first');
  const ids2 = f => call('GET', '/api/admin/matches?q=' + tag + '&f=' + f, null, ad).then(x => x.body.matches.map(m => m.id));
  check((await ids2('people')).includes('m' + tag + 'b') && !(await ids2('people')).includes('m' + tag + 'a'), 'filter: people only');
  check((await ids2('bots')).includes('m' + tag + 'a') && (await ids2('bots')).includes('m' + tag + 'd'), 'filter: with bots');
  check((await ids2('sandbox')).includes('m' + tag + 'c') && !(await ids2('bots')).includes('m' + tag + 'c'), 'filter: sandbox');
  check((await ids2('online')).includes('m' + tag + 'b') && !(await ids2('online')).includes('m' + tag + 'a'), 'filter: online');
  r = await call('GET', '/api/admin/matches/m' + tag + 'a', null, ad);
  check(r.status === 200 && r.body.match.log.length === 3 && r.body.match.log[2].p === 1 && r.body.match.replay.cmds.length === 1, 'one match comes with its full log (private lines marked) and replay');
  check(r.body.match.started === now - 900000 && r.body.match.players[0].emoji === '🦊', 'when it started, and who played');

  console.log('— accounts are linked by the games they save —');
  const ben = await call('POST', '/api/account/register', { username: 'ben' + tag, password: 'pass1234' });
  await call('POST', '/api/account/games', { games: [entry('m' + tag + 'b', 1, false, 'loss')] }, ben.body.token);
  await call('POST', '/api/account/games', { games: [entry('m' + tag + 'b', 0, false, 'win'), entry('m' + tag + 'a', 0, true, 'win')] }, pl.body.token);
  r = await call('GET', '/api/admin/matches/m' + tag + 'b', null, ad);
  check(r.body.match.accounts[0] === 'ana' + tag && r.body.match.accounts[1] === 'ben' + tag, 'both seats show the account that played them');
  /* a guest's game can reach its account before the host's match arrives */
  await call('POST', '/api/account/games', { games: [entry('m' + tag + 'e', 1, false, 'loss')] }, ben.body.token);
  await call('POST', '/api/matches', { match: match('m' + tag + 'e', { players: [{ name: 'Cy' + tag }, { name: 'Ben' }] }) });
  r = await call('GET', '/api/admin/matches/m' + tag + 'e', null, ad);
  check(r.body.match.accounts[1] === 'ben' + tag, 'a link that arrives first is kept until its match does');
  check((await ids2('accounts')).includes('m' + tag + 'b') && (await ids2('guests')).includes('m' + tag + 'c'), 'filter: with accounts / guests only');

  console.log('— bot games stay out of records and stats —');
  const before = (await call('GET', '/api/stats')).body.total || 0;
  await call('POST', '/api/account/games', { games: [entry('g' + tag + 'h', 0, false, 'win'), entry('g' + tag + 'k', 0, true, 'win'), entry('g' + tag + 'l', 0, true, 'loss')] }, pl.body.token);
  r = await call('GET', '/api/users/ana' + tag, null, ben.body.token);
  check(r.body.record.played === 2 && r.body.record.wins === 2 && r.body.record.vsBots === 3, 'the record counts only games against people (' + JSON.stringify(r.body.record) + ')');
  check(r.body.games.length === 5, 'but every game stays in the history');
  const after = (await call('GET', '/api/stats')).body.total;
  check(after - before === 1, 'everyone’s stats grew by the one new game against people, not the two bot games (' + (after - before) + ')');
  r = await call('GET', '/api/admin/users/ana' + tag, null, ad);
  check(r.body.record.played === 2 && r.body.games.length === 5, 'the admin sees the same record');

  console.log('— rebuilding everyone’s stats —');
  r = await call('POST', '/api/admin/stats/rebuild', {});
  check(r.status === 401, 'only the admin can rebuild');
  let next = '', steps = 0, games = 0;
  do{ r = await call('POST', '/api/admin/stats/rebuild', { after: next }, ad); next = r.body.next; games = r.body.games; steps++; }while(next && steps < 50);
  const rebuilt = (await call('GET', '/api/stats')).body;
  check(r.status === 200 && rebuilt.total === games && rebuilt.total >= 2, 'it adds every account up again, bot games left out (' + rebuilt.total + ' games)');

  console.log('— deleting, and limits —');
  r = await call('DELETE', '/api/admin/matches/m' + tag + 'c', null, ad);
  r = await call('GET', '/api/admin/matches/m' + tag + 'c', null, ad);
  check(r.status === 404, 'the admin can delete a match');
  const ip = '203.0.113.' + Math.floor(Math.random() * 250);
  let last = null;
  for(let i = 0; i < 61; i++) last = await call('POST', '/api/matches', { match: match('f' + tag + i) }, null, ip);
  check(last.status === 429, 'one address can send 60 matches an hour, then waits');
  r = await call('POST', '/api/matches', { match: match('big' + tag, { log: Array.from({ length: 5000 }, (_, i) => ({ t: 'x'.repeat(250) })) }) });
  check(r.status === 413, 'a match that is far too big is refused');
}catch(e){ fails++; console.log('  FAIL', e.message); }
finally{ if(dev) dev.kill(); console.log(fails ? fails + ' failures' : 'matches: all checks passed'); process.exit(fails ? 1 : 0); }
