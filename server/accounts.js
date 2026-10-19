/* ===================================================================
   TERRITORY — player accounts (one Durable Object per username)

   A username and password keep a player's name, record and match history
   on the server, so they follow them to any browser or device.

     POST   /api/account/register   {username, password}  -> 201 {token, username}
     POST   /api/account/login      {username, password}  -> 200 {token, username}
     POST   /api/account/logout                            (signs this token out)
     GET    /api/account                                   -> {username, name, games:[summary…]}
     PUT    /api/account            {name}                 -> {ok}
     POST   /api/account/games      {games:[entry…]}       -> {added, total}
     GET    /api/account/games/:id                         -> {game}   (with its log)
     DELETE /api/account/games                             -> {ok}     (clears the history)

   Everything but register and login takes "Authorization: Bearer <token>".
   A token is "<username>.<random>": the username says which account to
   wake, the random part must be one of that account's open sessions.

   Passwords are stored as PBKDF2-SHA-256 with a random salt — not plain
   text, but kept light (Workers' free plan gives each request 10 ms of
   CPU), and there is no rate limiting or recovery. Good enough for friends;
   not for anything that matters.
   =================================================================== */

import { DurableObject } from 'cloudflare:workers';

const USER_RE = /^[a-z0-9_-]{3,20}$/;
const PASS_MIN = 4, PASS_MAX = 200;
const ITERATIONS = 10000;
const SESSIONS_MAX = 20;          // signed in on this many browsers at once
const GAMES_MAX = 300;            // the oldest drop off after this
const GAME_BYTES_MAX = 150000;    // one game entry, log included
const NAME_MAX = 24;

const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

async function hashPassword(password, saltHex){
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return hex(bits);
}
/** Compare without stopping at the first difference. */
function sameText(a, b){
  if(typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for(let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export const cleanUser = u => String(u || '').trim().toLowerCase();
/** What the history list needs: everything but the log. */
const summary = g => { const { log, ...rest } = g; return Object.assign(rest, { hasLog: !!(log && log.length) }); };

export class Account extends DurableObject {
  async register(username, password){
    if(!USER_RE.test(username)) return { error: 'A username is 3–20 letters, numbers, - or _.', status: 400 };
    if(typeof password !== 'string' || password.length < PASS_MIN || password.length > PASS_MAX)
      return { error: `A password needs at least ${PASS_MIN} characters.`, status: 400 };
    if(await this.ctx.storage.get('user')) return { error: 'That username is taken.', status: 409 };
    const salt = randHex(16);
    await this.ctx.storage.put('user', { username, salt, hash: await hashPassword(password, salt), created: Date.now() });
    await this.ctx.storage.put('profile', { name: username });
    return { token: await this.openSession(username), username };
  }

  async login(username, password){
    const user = await this.ctx.storage.get('user');
    if(!user || typeof password !== 'string' || !sameText(await hashPassword(password, user.salt), user.hash))
      return { error: 'Wrong username or password.', status: 401 };
    return { token: await this.openSession(username), username };
  }

  async openSession(username){
    const sessions = (await this.ctx.storage.get('sessions')) || [];
    const secret = randHex(24);
    sessions.push({ secret, at: Date.now() });
    while(sessions.length > SESSIONS_MAX) sessions.shift();
    await this.ctx.storage.put('sessions', sessions);
    return username + '.' + secret;
  }
  async signedIn(secret){
    const sessions = (await this.ctx.storage.get('sessions')) || [];
    return !!secret && sessions.some(s => sameText(s.secret, secret));
  }
  async logout(secret){
    const sessions = ((await this.ctx.storage.get('sessions')) || []).filter(s => !sameText(s.secret, secret));
    await this.ctx.storage.put('sessions', sessions);
    return { ok: true };
  }

  async games(){
    const all = await this.ctx.storage.list({ prefix: 'g:' });
    return [...all.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  async profile(secret){
    if(!await this.signedIn(secret)) return { error: 'Signed out.', status: 401 };
    const user = await this.ctx.storage.get('user');
    const prof = (await this.ctx.storage.get('profile')) || {};
    return { username: user.username, name: prof.name || user.username, games: (await this.games()).map(summary) };
  }
  async setName(secret, name){
    if(!await this.signedIn(secret)) return { error: 'Signed out.', status: 401 };
    const clean = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_MAX);
    const prof = (await this.ctx.storage.get('profile')) || {};
    prof.name = clean;
    await this.ctx.storage.put('profile', prof);
    return { ok: true, name: clean };
  }
  /** Add finished games. One already there (same id) is left as it is. */
  async addGames(secret, list){
    if(!await this.signedIn(secret)) return { error: 'Signed out.', status: 401 };
    if(!Array.isArray(list)) return { error: 'Send {games:[…]}.', status: 400 };
    let added = 0;
    for(const g of list.slice(0, 250)){
      if(!g || typeof g.id !== 'string' || !/^[a-z0-9]{4,40}$/i.test(g.id)) continue;
      if(JSON.stringify(g).length > GAME_BYTES_MAX) continue;
      const key = 'g:' + g.id;
      if(await this.ctx.storage.get(key)) continue;
      await this.ctx.storage.put(key, g);
      added++;
    }
    const all = await this.games();
    if(all.length > GAMES_MAX) await this.ctx.storage.delete(all.slice(GAMES_MAX).map(g => 'g:' + g.id));
    return { added, total: Math.min(all.length, GAMES_MAX) };
  }
  async game(secret, id){
    if(!await this.signedIn(secret)) return { error: 'Signed out.', status: 401 };
    const g = await this.ctx.storage.get('g:' + id);
    return g ? { game: g } : { error: 'No such game.', status: 404 };
  }
  async clearGames(secret){
    if(!await this.signedIn(secret)) return { error: 'Signed out.', status: 401 };
    const all = await this.ctx.storage.list({ prefix: 'g:' });
    const keys = [...all.keys()];
    for(let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
    return { ok: true };
  }
}

/** The /api/account routes. Returns a Response, or null if the path isn't one of them. */
export async function accountRoute(request, env, url, json){
  if(!url.pathname.startsWith('/api/account')) return null;
  const stubFor = u => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(u));
  const reply = r => r.error ? json({ error: r.error }, r.status || 400) : json(r, r.token && url.pathname.endsWith('/register') ? 201 : 200);
  const body = async () => { try{ return await request.json(); }catch(e){ return {}; } };
  const p = url.pathname.replace(/\/+$/, '');

  if((p === '/api/account/register' || p === '/api/account/login') && request.method === 'POST'){
    const b = await body();
    const u = cleanUser(b.username);
    if(!USER_RE.test(u)) return json({ error: 'A username is 3–20 letters, numbers, - or _.' }, 400);
    const stub = stubFor(u);
    return reply(p.endsWith('register') ? await stub.register(u, b.password) : await stub.login(u, b.password));
  }

  /* everything else needs a session */
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const dot = auth.indexOf('.');
  const u = cleanUser(auth.slice(0, dot)), secret = auth.slice(dot + 1);
  if(dot < 1 || !USER_RE.test(u) || !secret) return json({ error: 'Sign in first.' }, 401);
  const stub = stubFor(u);

  if(p === '/api/account' && request.method === 'GET') return reply(await stub.profile(secret));
  if(p === '/api/account' && request.method === 'PUT') return reply(await stub.setName(secret, (await body()).name));
  if(p === '/api/account/logout' && request.method === 'POST') return reply(await stub.logout(secret));
  if(p === '/api/account/games' && request.method === 'POST') return reply(await stub.addGames(secret, (await body()).games));
  if(p === '/api/account/games' && request.method === 'DELETE') return reply(await stub.clearGames(secret));
  const gm = p.match(/^\/api\/account\/games\/([A-Za-z0-9]{4,40})$/);
  if(gm && request.method === 'GET') return reply(await stub.game(secret, gm[1]));
  return json({ error: 'Not found.' }, 404);
}
