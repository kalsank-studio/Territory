/* Player accounts, end to end, against a real local Worker (wrangler dev).
   node test/test-accounts.mjs                    starts its own local Worker
   BASE=https://your.workers.dev node test/…      tests a deployed one instead
   (each run makes a fresh username, so it can run against the live site) */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

let BASE = process.env.BASE;
let dev = null;
let fails = 0;
const check = (cond, msg) => { if(!cond){ fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };

async function startDev(){
  const port = 8890 + Math.floor(Math.random() * 100);
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  BASE = `http://127.0.0.1:${port}`;
  for(let i = 0; i < 120; i++){
    try{ const r = await fetch(BASE + '/api/rooms/NOPE0'); if(r.status) return; }catch(e){}
    await wait(500);
  }
  throw new Error('wrangler dev did not start');
}
const call = async (method, path, body, token) => {
  const r = await fetch(BASE + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try{ j = await r.json(); }catch(e){}
  return { status: r.status, body: j || {} };
};

try{
  if(!BASE) await startDev();
  console.log('accounts at', BASE);
  const user = 'test' + Math.random().toString(36).slice(2, 10);

  let r = await call('POST', '/api/account/register', { username: user.toUpperCase(), password: 'hunter22' });
  check(r.status === 201 && r.body.token && r.body.username === user, 'register (usernames are not case-sensitive)');
  const t1 = r.body.token;
  r = await call('POST', '/api/account/register', { username: user, password: 'other' });
  check(r.status === 409, 'the same username is taken');
  r = await call('POST', '/api/account/register', { username: 'x', password: 'hunter22' });
  check(r.status === 400, 'a too-short username is refused');
  r = await call('POST', '/api/account/login', { username: user, password: 'wrong!' });
  check(r.status === 401, 'a wrong password is refused');
  r = await call('POST', '/api/account/login', { username: 'nobody' + user, password: 'hunter22' });
  check(r.status === 401, 'an unknown username gets the same answer');
  r = await call('POST', '/api/account/login', { username: user, password: 'hunter22' });
  check(r.status === 200 && r.body.token && r.body.token !== t1, 'sign in again, from "another browser"');
  const t2 = r.body.token;

  r = await call('GET', '/api/account', null, t1);
  check(r.status === 200 && r.body.name === user && Array.isArray(r.body.games) && r.body.games.length === 0, 'a new account: name is the username, no games');
  r = await call('PUT', '/api/account', { name: 'Kal' }, t2);
  check(r.status === 200, 'set the display name');
  r = await call('GET', '/api/account', null, t1);
  check(r.body.name === 'Kal', 'the other session sees it');

  const game = (id, at, result) => ({ id, at, mode: 'local', seat: 0, result, won: [3, 2], rounds: 6,
    players: [{ name: 'Kal' }, { name: 'Bot 2', bot: true }], rows: [{ name: 'Verdance', scores: [5, 2], winner: 0 }],
    log: [{ rd: 1, t: 'Round 1' }, { t: 'Kal reveals Atlas', w: 0 }] });
  r = await call('POST', '/api/account/games', { games: [game('aaaa1', 1000, 'win'), game('bbbb2', 2000, 'loss')] }, t1);
  check(r.status === 200 && r.body.added === 2, 'record two games');
  r = await call('POST', '/api/account/games', { games: [game('aaaa1', 1000, 'win')] }, t2);
  check(r.body.added === 0, 'the same game twice is kept once');
  r = await call('GET', '/api/account', null, t2);
  check(r.body.games.length === 2 && r.body.games[0].id === 'bbbb2' && !r.body.games[0].log && r.body.games[0].hasLog, 'the history comes back newest first, without logs');
  r = await call('GET', '/api/account/games/aaaa1', null, t2);
  check(r.status === 200 && r.body.game.log.length === 2, 'a game’s log on request');

  r = await call('GET', '/api/account', null, user + '.nottherealsecret');
  check(r.status === 401, 'a made-up token is refused');
  r = await call('GET', '/api/account', null, null);
  check(r.status === 401, 'no token is refused');
  r = await call('POST', '/api/account/logout', null, t1);
  r = await call('GET', '/api/account', null, t1);
  check(r.status === 401, 'signing out ends that session');
  r = await call('GET', '/api/account', null, t2);
  check(r.status === 200, '…and only that one');
  r = await call('DELETE', '/api/account/games', null, t2);
  r = await call('GET', '/api/account', null, t2);
  check(r.body.games.length === 0, 'clear the history');
}catch(e){
  fails++; console.log('  FAIL', e.message);
}finally{
  if(dev) dev.kill();
  console.log(fails ? fails + ' failures' : 'accounts: all checks passed');
  process.exit(fails ? 1 : 0);
}
