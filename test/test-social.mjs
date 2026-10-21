/* Friends, invites, public profiles and comments, against a real local Worker.
   node test/test-social.mjs          (starts its own wrangler dev)
   BASE=https://… node test/test-social.mjs */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
let BASE = process.env.BASE, dev = null, fails = 0;
const check = (c, m) => { if(!c){ fails++; console.log('  FAIL', m); } else console.log('  ok  ', m); };
async function startDev(){
  const port = 8990 + Math.floor(Math.random() * 100);
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  BASE = `http://127.0.0.1:${port}`;
  for(let i = 0; i < 120; i++){ try{ const r = await fetch(BASE + '/api/rooms/NOPE0'); if(r.status) return; }catch(e){} await wait(500); }
  throw new Error('wrangler dev did not start');
}
const call = async (method, path, body, token) => {
  const r = await fetch(BASE + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  let j = null; try{ j = await r.json(); }catch(e){}
  return { status: r.status, body: j || {} };
};
try{
  if(!BASE) await startDev();
  console.log('social at', BASE);
  const tag = Math.random().toString(36).slice(2, 7);
  const mk = async n => { const r = await call('POST', '/api/account/register', { username: n + tag, password: 'pass1234' }); return { user: n + tag, t: r.body.token }; };
  const a = await mk('ana'), b = await mk('bo'), c = await mk('cy');
  let r = await call('GET', '/api/users?q=bo' + tag, null, a.t);
  check(r.status === 200 && r.body.users.some(u => u.user === b.user), 'search finds a username');
  r = await call('GET', '/api/users?q=' + a.user, null, a.t);
  check(!r.body.users.some(u => u.user === a.user), '…but not yourself');
  r = await call('GET', '/api/social', null, null);
  check(r.status === 401, 'social needs a session');

  r = await call('POST', '/api/social/request', { user: b.user }, a.t);
  check(r.status === 200 && !r.body.friends, 'Ana asks Bo');
  r = await call('GET', '/api/social', null, b.t);
  check(r.body.incoming.some(x => x.user === a.user), 'Bo sees the request');
  r = await call('GET', '/api/social', null, a.t);
  check(r.body.outgoing.some(x => x.user === b.user), 'Ana sees it waiting');
  r = await call('GET', '/api/social/poll', null, b.t);
  check(r.body.incoming === 1, 'the poll counts it');
  r = await call('POST', '/api/social/accept', { user: a.user }, b.t);
  check(r.body.friends, 'Bo accepts');
  r = await call('GET', '/api/social', null, a.t);
  check(r.body.friends.some(f => f.user === b.user && f.record) && !r.body.outgoing.length, 'both are friends, with a record');

  r = await call('POST', '/api/social/request', { user: a.user }, c.t);
  r = await call('POST', '/api/social/request', { user: c.user }, a.t);
  check(r.body.friends, 'asking someone who asked you first makes you friends');
  r = await call('POST', '/api/social/remove', { user: c.user }, a.t);
  r = await call('GET', '/api/social', null, c.t);
  check(!r.body.friends.length, 'removing a friend works both ways');

  r = await call('POST', '/api/social/invite', { user: c.user, code: 'ABCDE' }, a.t);
  check(r.status === 403, 'only friends can be invited');
  r = await call('POST', '/api/social/invite', { user: b.user, code: 'abcde' }, a.t);
  check(r.status === 200, 'Ana invites Bo to a room');
  r = await call('GET', '/api/social/poll', null, b.t);
  check(r.body.invites.length === 1 && r.body.invites[0].code === 'ABCDE' && r.body.invites[0].from === a.user, 'Bo’s poll has the invite');
  r = await call('POST', '/api/social/dismiss', { code: 'ABCDE' }, b.t);
  r = await call('GET', '/api/social/poll', null, b.t);
  check(!r.body.invites.length, 'dismissing it clears it');

  // a game on Ana's profile, and comments
  const game = { id: 'g' + tag + 'x1', at: Date.now(), mode: 'local', seat: 0, result: 'win', won: [3, 2], rounds: 6,
    players: [{ name: 'Ana' }, { name: 'Bot', bot: true }], rows: [], log: [{ t: 'x' }], stats: { v: 1 }, replay: { v: 1, setup: {}, cmds: [] } };
  await call('POST', '/api/account/games', { games: [game] }, a.t);
  r = await call('GET', '/api/users/' + a.user, null, b.t);
  check(r.status === 200 && r.body.record.wins === 1 && r.body.games[0].id === game.id && r.body.relation === 'friend' && !r.body.games[0].log && !r.body.games[0].replay, 'Bo views Ana’s profile');
  r = await call('GET', '/api/account', null, a.t);
  check(r.body.games[0].hasReplay && !r.body.games[0].replay, 'the history list says there’s a replay without carrying it');
  r = await call('GET', `/api/users/${a.user}/games/${game.id}`, null, b.t);
  check(r.body.game && r.body.game.replay && r.body.comments.length === 0, '…and one of her games, replay included');
  r = await call('POST', `/api/users/${a.user}/games/${game.id}/comments`, { text: 'Nice comeback!' }, b.t);
  check(r.status === 200 && r.body.comments.length === 1, 'Bo comments');
  const bc = r.body.comments[0].id;
  r = await call('POST', `/api/users/${a.user}/games/${game.id}/comments`, { text: 'Thanks' }, a.t);
  check(r.body.comments.length === 2, 'Ana comments on her own game');
  const ac = r.body.comments[1].id;
  r = await call('DELETE', `/api/users/${a.user}/games/${game.id}/comments/${ac}`, null, c.t);
  check(r.status === 403, 'a stranger can’t delete a comment');
  r = await call('DELETE', `/api/users/${a.user}/games/${game.id}/comments/${bc}`, null, a.t);
  check(r.status === 200 && r.body.comments.length === 1, 'the owner can delete any comment on her game');
  for(let i = 0; i < 9; i++) r = await call('POST', `/api/users/${a.user}/games/${game.id}/comments`, { text: 'c' + i }, c.t);
  r = await call('POST', `/api/users/${a.user}/games/${game.id}/comments`, { text: 'one too many' }, c.t);
  check(r.status === 409, 'ten comments per game at most');
  r = await call('GET', '/api/users/' + a.user, null, c.t);
  check(r.body.games[0].comments === 10, 'the profile counts comments');
}catch(e){ fails++; console.log('  FAIL', e.message); }
finally{ if(dev) dev.kill(); console.log(fails ? fails + ' failures' : 'social: all checks passed'); process.exit(fails ? 1 : 0); }
