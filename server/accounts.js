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

   Records and stats count only games played against people: a game with a
   bot in any seat stays in the match history but adds nothing to wins,
   losses or the Stats numbers (`counted`).

   Every finished game, from any browser, signed in or not, bots or not, is
   also sent to the match log the admin reads (POST /api/matches, kept in one
   more object, "~matches"): who sat where, how it ended, the full game log
   and the replay. See matchRoute below.

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
const GAME_BYTES_MAX = 400000;    // one game entry, log and replay included
const NAME_MAX = 24;
const FRIENDS_MAX = 25;
const INVITE_MS = 2 * 60 * 60 * 1000;   // an invite to a room lasts two hours
const PUBLIC_GAMES = 30;                // the games another player can see
const COMMENTS_PER_GAME = 10, COMMENT_MAX = 280;
const ADMIN_TRIES = 5;                       // wrong admin passwords from one address before it waits
const ADMIN_LOCK_MS = 15 * 60 * 1000;        // …15 minutes, doubling each time it happens again
const ADMIN_GLOBAL_FAILS = 50;               // wrong passwords from everywhere in an hour before the door shuts for the hour
const ADMIN_SESSION_MS = 30 * 24 * 3600e3;   // an admin unlock lasts 30 days on that browser
const MATCHES_MAX = 2000;                    // the match log keeps this many; the oldest go first
const MATCH_BYTES_MAX = 600000;              // one match, full log and replay included
const MATCHES_PER_HOUR = 60;                 // from one address — a game takes minutes, so this is generous
const MATCH_PAGE = 40;

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
/** A profile emoji: a few characters at most, no letters or digits (so it can't be a name in disguise). */
const cleanEmoji = e => { const v = String(e || '').replace(/[\u0000-\u001f\s]/g, '').slice(0, 16); return /[A-Za-z0-9<>]/.test(v) ? '' : v; };
/** A game with a bot in any seat (a bot standing in for a dropped player doesn't count as one). */
export const hasBot = g => !!(g && Array.isArray(g.players) && g.players.some(p => p && p.bot));
/** Does this game count toward a record and the stats? Only games against people. */
const counted = g => !hasBot(g);
const recordOf = games => {
  const real = games.filter(counted), n = k => real.filter(x => x.result === k).length;
  return { played: real.length, wins: n('win'), losses: n('loss'), draws: n('draw'), vsBots: games.length - real.length };
};

/* --- adding games up (the same arithmetic as the game's own Stats page) --- */
const freshStats = () => ({ v: 1, games: 0, withStats: 0, cards: {}, planets: {},
  power: { rounds: 0, roundSum: 0, gameSum: 0, bestRound: null, bestGame: null },
  draws: { gameSum: 0, bestRound: null, bestGame: null } });
function mergeGame(S, g, user){
  const st = g.stats; if(!st || !st.v) return;
  S.games++; S.withStats++;
  const who = { user, at: g.at || Date.now() };
  (g.rows || []).forEach(r => { const p = S.planets[r.name] || (S.planets[r.name] = { name: r.name, seen: 0, won: 0, rounds: 0, slots: {} }); p.seen++; if(r.winner === g.seat) p.won++; });
  const seen = new Set();
  (st.cards || []).forEach(c => {
    const k = S.cards[c.n] || (S.cards[c.n] = { name: c.n, plays: 0, games: 0, gameWins: 0, onBoard: 0, planetWins: 0 });
    k.plays++;
    if(!seen.has(c.n)){ seen.add(c.n); k.games++; if(st.won) k.gameWins++; }
    if(c.pw != null){ k.onBoard++; if(c.pw) k.planetWins++; }
  });
  (st.slots || []).forEach(pl => {
    const p = S.planets[pl.p] || (S.planets[pl.p] = { name: pl.p, seen: 0, won: 0, rounds: 0, slots: {} });
    p.rounds += g.rounds || 6;
    pl.s.forEach((sl, i) => { const key = i + '|' + sl.c + '|' + sl.r; const row = p.slots[key] || (p.slots[key] = { i, c: sl.c, r: sl.r, m: 0, rounds: 0 }); row.m += sl.m; row.rounds += g.rounds || 6; });
  });
  const pw = st.power || [];
  pw.forEach((v, i) => { const gain = v - (i ? pw[i - 1] : 0); S.power.rounds++; S.power.roundSum += gain;
    if(!S.power.bestRound || gain > S.power.bestRound.v) S.power.bestRound = Object.assign({ v: gain, rd: i + 1 }, who); });
  const fin = pw.length ? pw[pw.length - 1] : 0;
  S.power.gameSum += fin;
  if(!S.power.bestGame || fin > S.power.bestGame.v) S.power.bestGame = Object.assign({ v: fin }, who);
  const dr = st.draws || [], total = dr.reduce((a, b) => a + b, 0);
  S.draws.gameSum += total;
  if(!S.draws.bestGame || total > S.draws.bestGame.v) S.draws.bestGame = Object.assign({ v: total }, who);
  dr.forEach((v, i) => { if(!S.draws.bestRound || v > S.draws.bestRound.v) S.draws.bestRound = Object.assign({ v, rd: i + 1 }, who); });
}
/** The shape the game's Stats page draws. */
function publicStats(S){
  const n = S.withStats;
  return { n, total: S.games, cards: Object.values(S.cards),
    planets: Object.values(S.planets).map(p => ({ name: p.name, seen: p.seen, won: p.won, rounds: p.rounds, slots: Object.values(p.slots) })),
    power: { perRound: S.power.rounds ? S.power.roundSum / S.power.rounds : null, perGame: n ? S.power.gameSum / n : null, bestRound: S.power.bestRound, bestGame: S.power.bestGame },
    draws: { perGame: n ? S.draws.gameSum / n : null, bestRound: S.draws.bestRound, bestGame: S.draws.bestGame } };
}
/** What the history list needs: everything but the log. */
const summary = g => { const { log, replay, ...rest } = g; return Object.assign(rest, { hasLog: !!(log && log.length), hasReplay: !!(replay || rest.hasReplay) }); };

/* --- the match log: what's kept of one match ---------------------------- */
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const MATCH_ID = /^[A-Za-z0-9]{4,40}$/;
/** Check and tidy a match sent by a game. Returns {match} or {error}. */
function cleanMatch(m){
  if(!m || typeof m !== 'object') return { error: 'Send {match:{…}}.' };
  if(typeof m.id !== 'string' || !MATCH_ID.test(m.id)) return { error: 'A match needs an id.' };
  if(!Array.isArray(m.players) || m.players.length < 1 || m.players.length > 4) return { error: 'A match has one to four players.' };
  const n = m.players.length;
  const nums = (a, len) => Array.isArray(a) ? a.slice(0, len).map(x => (typeof x === 'number' && isFinite(x)) ? x : 0) : [];
  const now = Date.now();
  const at = (typeof m.at === 'number' && m.at > 1.5e12 && m.at < now + 864e5) ? m.at : now;
  const started = (typeof m.started === 'number' && m.started > 1.5e12 && m.started <= at) ? m.started : null;
  const players = m.players.map(p => ({ name: clip(p && p.name, NAME_MAX) || 'Player', emoji: cleanEmoji(p && p.emoji), bot: !!(p && p.bot),
    standIn: !!(p && p.standIn) }));
  const rows = (Array.isArray(m.rows) ? m.rows : []).slice(0, 12).map(r => ({ name: clip(r && r.name, 40), scores: nums(r && r.scores, n),
    winner: (r && Number.isInteger(r.winner) && r.winner >= 0 && r.winner < n) ? r.winner : null }));
  const winner = Number.isInteger(m.winner) && m.winner >= 0 && m.winner < n ? m.winner : null;
  const log = Array.isArray(m.log) ? m.log.slice(0, 5000).map(l => l && l.rd ? { rd: 1, t: clip(l.t, 300) }
    : { t: clip(l && l.t, 300), w: Number.isInteger(l && l.w) ? l.w : undefined,
        /* a line only some seats saw: which seats (or just 1, "private") */
        p: Array.isArray(l && l.p) ? l.p.filter(i => Number.isInteger(i) && i >= 0 && i < n).slice(0, 4) : (l && l.p ? 1 : undefined) }) : [];
  const replay = (m.replay && typeof m.replay === 'object' && m.replay.setup && Array.isArray(m.replay.cmds)) ? m.replay : null;
  const match = {
    id: m.id, at, started, mode: m.mode === 'online' ? 'online' : 'local', sandbox: !!m.sandbox,
    rounds: Math.max(1, Math.min(12, m.rounds | 0 || 6)), planets: rows.length || (m.planets | 0), sharedDeck: !!m.sharedDeck,
    players, won: nums(m.won, n), winner, reason: clip(m.reason, 40), rows, cmds: replay ? replay.cmds.length : (m.cmds | 0),
    bots: players.filter(p => p.bot).length, v: clip(m.v, 16), log, replay, accounts: {}
  };
  if(JSON.stringify(match).length > MATCH_BYTES_MAX) return { error: 'That match is too big to keep.', status: 413 };
  return { match };
}
/** Newest first: the index key counts down from the far future. */
const matchKey = (at, id) => 'i:' + String(9999999999999 - Math.floor(at)).padStart(13, '0') + ':' + id;
const matchSummary = m => { const { log, replay, ...rest } = m; return Object.assign(rest, { hasLog: !!(log && log.length), hasReplay: !!replay }); };
const MATCH_FILTERS = {
  all: () => true,
  people: m => !m.bots && !m.sandbox,
  bots: m => m.bots > 0 && !m.sandbox,
  online: m => m.mode === 'online',
  local: m => m.mode !== 'online',
  accounts: m => Object.keys(m.accounts || {}).length > 0,
  guests: m => !Object.keys(m.accounts || {}).length,
  sandbox: m => !!m.sandbox
};

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
    await this.ctx.storage.put('seen', Date.now());          // for the admin's user list
    return { username: user.username, name: prof.name || user.username, emoji: prof.emoji || '', games: (await this.games()).map(summary) };
  }
  /** Change the display name and/or the profile emoji (either may be left out). */
  async setName(secret, name, emoji){
    if(!await this.signedIn(secret)) return { error: 'Signed out.', status: 401 };
    const prof = (await this.ctx.storage.get('profile')) || {};
    if(name != null) prof.name = String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_MAX);
    if(emoji != null) prof.emoji = cleanEmoji(emoji);
    await this.ctx.storage.put('profile', prof);
    const user = await this.ctx.storage.get('user');
    return { ok: true, name: prof.name || user.username, emoji: prof.emoji || '' };
  }
  /** Add finished games. One already there (same id) is left as it is. */
  async addGames(secret, list){
    if(!await this.signedIn(secret)) return { error: 'Signed out.', status: 401 };
    if(!Array.isArray(list)) return { error: 'Send {games:[…]}.', status: 400 };
    let added = 0;
    const fresh = [], seats = [];
    for(const g of list.slice(0, 250)){
      if(!g || typeof g.id !== 'string' || !/^[a-z0-9]{4,40}$/i.test(g.id)) continue;
      if(JSON.stringify(g).length > GAME_BYTES_MAX) continue;
      if(Number.isInteger(g.seat)) seats.push({ id: g.id, seat: g.seat });     // which seat this account had, for the match log
      const key = 'g:' + g.id;
      if(await this.ctx.storage.get(key)) continue;
      /* a replay is kept under its own key, so the history list never reads it */
      const { replay, ...rest } = g;
      if(replay){ rest.hasReplay = true; await this.ctx.storage.put('r:' + g.id, replay); }
      await this.ctx.storage.put(key, rest);
      added++;
      if(rest.stats && rest.stats.v && rest.mode !== 'sandbox' && counted(rest)) fresh.push(rest);
    }
    const all = await this.games();
    if(all.length > GAMES_MAX){
      const old = all.slice(GAMES_MAX);
      await this.ctx.storage.delete(old.map(g => 'g:' + g.id));
      await this.ctx.storage.delete(old.map(g => 'r:' + g.id));
    }
    return { added, total: Math.min(all.length, GAMES_MAX), fresh, seats };
  }
  async game(secret, id){
    if(!await this.signedIn(secret)) return { error: 'Signed out.', status: 401 };
    const g = await this.ctx.storage.get('g:' + id);
    if(!g) return { error: 'No such game.', status: 404 };
    const replay = g.hasReplay ? await this.ctx.storage.get('r:' + id) : null;
    return { game: replay ? Object.assign({}, g, { replay }) : g };
  }
  /* --- social: this account's friends, requests and invites -------------
     The Worker route checks who is asking (their own session) and then
     calls the other account's object directly for its half of a change. */
  async rel(){
    const r = (await this.ctx.storage.get('social')) || {};
    const now = Date.now();
    return { friends: r.friends || [], incoming: r.incoming || [], outgoing: r.outgoing || [],
             invites: (r.invites || []).filter(i => now - i.at < INVITE_MS) };
  }
  async putRel(r){ await this.ctx.storage.put('social', r); }
  async exists(){ const u = await this.ctx.storage.get('user'); return u ? u.username : null; }
  async displayEmoji(){ const prof = (await this.ctx.storage.get('profile')) || {}; return prof.emoji || ''; }
  async card(){ const u = await this.ctx.storage.get('user'); if(!u) return null; const prof = (await this.ctx.storage.get('profile')) || {}; return { user: u.username, name: prof.name || u.username, emoji: prof.emoji || '' }; }
  async displayName(){ const prof = (await this.ctx.storage.get('profile')) || {}; const u = await this.ctx.storage.get('user'); return prof.name || (u && u.username) || ''; }
  async friendCount(){ return (await this.rel()).friends.length; }
  /** Someone asks to be friends. If this account had already asked them, they become friends. */
  async relIncoming(from){
    const r = await this.rel();
    if(r.friends.includes(from)) return { ok: true, friends: true };
    if(r.outgoing.some(o => o.user === from)){
      if(r.friends.length >= FRIENDS_MAX) return { error: 'They already have ' + FRIENDS_MAX + ' friends.', status: 409 };
      r.outgoing = r.outgoing.filter(o => o.user !== from); r.friends.push(from); await this.putRel(r);
      return { ok: true, friends: true };
    }
    if(r.friends.length >= FRIENDS_MAX) return { error: 'They already have ' + FRIENDS_MAX + ' friends.', status: 409 };
    if(!r.incoming.some(o => o.user === from)){ r.incoming.unshift({ user: from, at: Date.now() }); r.incoming = r.incoming.slice(0, 50); }
    await this.putRel(r);
    return { ok: true };
  }
  async relOutgoing(to, friends){
    const r = await this.rel();
    r.incoming = r.incoming.filter(o => o.user !== to);
    if(friends){ r.outgoing = r.outgoing.filter(o => o.user !== to); if(!r.friends.includes(to)) r.friends.push(to); }
    else if(!r.outgoing.some(o => o.user === to)) r.outgoing.unshift({ user: to, at: Date.now() });
    await this.putRel(r);
    return { ok: true };
  }
  async relBefriend(u){
    const r = await this.rel();
    r.incoming = r.incoming.filter(o => o.user !== u); r.outgoing = r.outgoing.filter(o => o.user !== u);
    if(!r.friends.includes(u)) r.friends.push(u);
    await this.putRel(r);
    return { ok: true };
  }
  /** Forget anything between this account and `u`: a request either way, or the friendship. */
  async relDrop(u){
    const r = await this.rel();
    r.incoming = r.incoming.filter(o => o.user !== u); r.outgoing = r.outgoing.filter(o => o.user !== u);
    r.friends = r.friends.filter(f => f !== u); r.invites = r.invites.filter(i => i.from !== u);
    await this.putRel(r);
    return { ok: true };
  }
  async relInvite(inv){
    const r = await this.rel();
    if(!r.friends.includes(inv.from)) return { error: 'Only friends can invite each other.', status: 403 };
    r.invites = r.invites.filter(i => i.from !== inv.from);
    r.invites.unshift(Object.assign({ at: Date.now() }, inv));
    r.invites = r.invites.slice(0, 10);
    await this.putRel(r);
    return { ok: true };
  }
  async relDismiss(code){
    const r = await this.rel();
    r.invites = r.invites.filter(i => code ? i.code !== code : false);
    await this.putRel(r);
    return { ok: true };
  }
  async record(){ return recordOf(await this.games()); }
  /** What anyone signed in may see: the name, the record and recent games, with comment counts. */
  async publicProfile(){
    const username = await this.exists();
    if(!username) return { error: 'No such player.', status: 404 };
    const all = await this.games();
    const recent = all.slice(0, PUBLIC_GAMES).map(summary);
    const keys = recent.map(g => 'c:' + g.id);
    const cm = keys.length ? await this.ctx.storage.get(keys) : new Map();
    recent.forEach(g => { const c = cm.get('c:' + g.id); g.comments = c ? c.length : 0; });
    return { username, name: await this.displayName(), emoji: await this.displayEmoji(), record: recordOf(all), games: recent };
  }
  async publicGame(id){
    const g = await this.ctx.storage.get('g:' + id);
    if(!g) return { error: 'No such game.', status: 404 };
    const replay = g.hasReplay ? await this.ctx.storage.get('r:' + id) : null;
    return { game: replay ? Object.assign({}, g, { replay }) : g, comments: (await this.ctx.storage.get('c:' + id)) || [] };
  }
  async addComment(id, author, authorName, text){
    if(!await this.ctx.storage.get('g:' + id)) return { error: 'No such game.', status: 404 };
    const clean = String(text || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, COMMENT_MAX);
    if(!clean) return { error: 'Write something first.', status: 400 };
    const list = (await this.ctx.storage.get('c:' + id)) || [];
    if(list.length >= COMMENTS_PER_GAME) return { error: 'This game already has ' + COMMENTS_PER_GAME + ' comments.', status: 409 };
    list.push({ id: randHex(6), author, name: String(authorName || author).slice(0, NAME_MAX), text: clean, at: Date.now() });
    await this.ctx.storage.put('c:' + id, list);
    return { ok: true, comments: list };
  }
  /** The player whose game it is can delete any comment on it; anyone can delete their own. */
  async deleteComment(id, cid, by){
    const owner = await this.exists();
    const list = (await this.ctx.storage.get('c:' + id)) || [];
    const c = list.find(x => x.id === cid);
    if(!c) return { error: 'No such comment.', status: 404 };
    if(by !== owner && by !== c.author) return { error: 'Only the player whose game it is, or whoever wrote it, can delete a comment.', status: 403 };
    const next = list.filter(x => x.id !== cid);
    await this.ctx.storage.put('c:' + id, next);
    return { ok: true, comments: next };
  }
  /* --- the directory: one extra object (named "~directory", which no username
     can be) that lists every username, for search */
  async dirPut(user, name, emoji){ await this.ctx.storage.put('u:' + user, { name: String(name || user).slice(0, NAME_MAX), emoji: emoji || '' }); return { ok: true }; }
  async dirSearch(q){
    const out = await this.ctx.storage.list({ prefix: 'u:' + q, limit: 20 });
    return [...out.entries()].map(([k, v]) => ({ user: k.slice(2), name: v.name, emoji: v.emoji || '' }));
  }
  /* --- everyone's stats: one more object ("~stats") adds up every game any
     account records against people, the same way each player's own Stats page does. */
  async statsMerge(games, user){
    const S = (await this.ctx.storage.get('stats')) || freshStats();
    games.forEach(g => mergeGame(S, g, user));
    await this.ctx.storage.put('stats', S);
    return { ok: true };
  }
  /** Adding everything up again from every account (the admin's rebuild): a
      scratch copy fills a page of accounts at a time, then replaces the live one. */
  async statsRebuildStep(reset, pages, done){
    const S = reset ? freshStats() : ((await this.ctx.storage.get('statsNext')) || freshStats());
    pages.forEach(({ user, games }) => games.forEach(g => mergeGame(S, g, user)));
    if(done){ await this.ctx.storage.put('stats', S); await this.ctx.storage.delete('statsNext'); }
    else await this.ctx.storage.put('statsNext', S);
    return { games: S.games };
  }
  /** This account's games that the stats add up: against people, not sandbox, with numbers. */
  async statsGames(){
    return (await this.games()).filter(g => g.stats && g.stats.v && g.mode !== 'sandbox' && counted(g))
      .map(g => ({ stats: g.stats, rows: g.rows, seat: g.seat, rounds: g.rounds, at: g.at }));       // just the numbers, not the logs
  }
  /* --- the admin lock: one more object ("~admin") keeps admin sessions and
     counts failed password attempts per address. The password itself is a
     Worker secret (ADMIN_PASSWORD) and never stored here. */
  async adminGate(ip){
    const f = (await this.ctx.storage.get('fail:' + ip)) || { n: 0, until: 0 };
    const all = (await this.ctx.storage.get('failAll')) || { n: 0, since: Date.now() };
    const now = Date.now();
    if(f.until > now) return { wait: Math.ceil((f.until - now) / 1000) };
    if(now - all.since < 3600e3 && all.n >= ADMIN_GLOBAL_FAILS) return { wait: Math.ceil((all.since + 3600e3 - now) / 1000) };
    return { wait: 0 };
  }
  async adminFail(ip){
    const now = Date.now();
    const f = (await this.ctx.storage.get('fail:' + ip)) || { n: 0, until: 0 };
    f.n++;
    if(f.n >= ADMIN_TRIES){ f.until = now + ADMIN_LOCK_MS * Math.pow(2, Math.min(6, Math.floor(f.n / ADMIN_TRIES) - 1)); }
    await this.ctx.storage.put('fail:' + ip, f);
    let all = (await this.ctx.storage.get('failAll')) || { n: 0, since: now };
    if(now - all.since >= 3600e3) all = { n: 0, since: now };
    all.n++;
    await this.ctx.storage.put('failAll', all);
    return { ok: true };
  }
  async adminOpen(ip, fp){
    await this.ctx.storage.delete('fail:' + ip);
    const now = Date.now();
    const list = ((await this.ctx.storage.get('sessions')) || []).filter(x => x.fp === fp && now - x.at < ADMIN_SESSION_MS);
    const secret = randHex(32);
    list.push({ secret, at: now, fp });
    while(list.length > 10) list.shift();
    await this.ctx.storage.put('sessions', list);
    return { token: 'admin.' + secret };
  }
  async adminCheck(secret, fp){
    const now = Date.now();
    const list = (await this.ctx.storage.get('sessions')) || [];
    return list.some(x => x.fp === fp && now - x.at < ADMIN_SESSION_MS && sameText(x.secret, secret));
  }
  async adminClose(secret){
    const list = ((await this.ctx.storage.get('sessions')) || []).filter(x => !sameText(x.secret, secret));
    await this.ctx.storage.put('sessions', list);
    return { ok: true };
  }
  /* --- what the admin's Users tab sees (never the password hash or session secrets) --- */
  async adminSummary(){
    const u = await this.ctx.storage.get('user');
    if(!u) return null;
    const prof = (await this.ctx.storage.get('profile')) || {};
    const games = await this.games();
    const rel = await this.rel();
    const sessions = (await this.ctx.storage.get('sessions')) || [];
    return { user: u.username, name: prof.name || u.username, emoji: prof.emoji || '', created: u.created || null,
             seen: (await this.ctx.storage.get('seen')) || (sessions.length ? Math.max(...sessions.map(x => x.at || 0)) : null),
             record: recordOf(games), lastGame: games.length ? games[0].at : null, friends: rel.friends.length, sessions: sessions.length };
  }
  async adminDetail(){
    const base = await this.adminSummary();
    if(!base) return { error: 'No such player.', status: 404 };
    const rel = await this.rel();
    const games = (await this.games()).map(summary);
    const keys = games.slice(0, 128).map(g => 'c:' + g.id);
    const cm = keys.length ? await this.ctx.storage.get(keys) : new Map();
    games.forEach(g => { const c = cm.get('c:' + g.id); g.comments = c ? c.length : 0; });
    const sessions = ((await this.ctx.storage.get('sessions')) || []).map(x => ({ at: x.at }));
    return Object.assign(base, { friendList: rel.friends, incoming: rel.incoming, outgoing: rel.outgoing, invites: rel.invites, sessionList: sessions, games });
  }
  async dirAll(after, limit){
    const opts = { prefix: 'u:', limit: Math.min(200, limit || 100) };
    if(after) opts.startAfter = 'u:' + after;
    const out = await this.ctx.storage.list(opts);
    return [...out.keys()].map(k => k.slice(2));
  }
  /* --- the open-lobby list (the "~lobbies" object); each room keeps its own entry current */
  async lobbyPut(code, entry){
    if(entry) await this.ctx.storage.put('l:' + code, entry); else await this.ctx.storage.delete('l:' + code);
    return { ok: true };
  }
  async lobbyList(){
    const all = await this.ctx.storage.list({ prefix: 'l:' });
    const now = Date.now(), out = [], stale = [];
    for(const [k, v] of all){
      if(now - (v.updated || 0) > 6 * 3600e3){ stale.push(k); continue; }       // a room nobody has touched in six hours
      if(v.public && !v.playing && v.hostHere && v.taken < v.seats) out.push(v);
    }
    if(stale.length) await this.ctx.storage.delete(stale.slice(0, 128));
    return out.sort((a, b) => b.updated - a.updated).slice(0, 50);
  }
  async statsGet(){ return publicStats((await this.ctx.storage.get('stats')) || freshStats()); }

  /* --- the match log (the "~matches" object) ------------------------------
       i:<countdown>:<id>  the summary, newest first in key order
       x:<id>              -> its i: key (so a match is only kept once)
       l:<id>, r:<id>      its full log and its replay, read only when it's opened
       p:<id>              accounts that said they played it before it arrived
       rl:<address>        how many matches that address sent this hour
       n                   how many are kept */
  async matchAdd(m, ip){
    const now = Date.now();
    const rl = (await this.ctx.storage.get('rl:' + ip)) || { n: 0, since: now };
    if(now - rl.since > 3600e3){ rl.n = 0; rl.since = now; }
    if(rl.n >= MATCHES_PER_HOUR) return { error: 'Too many matches from here this hour.', status: 429 };
    if(await this.ctx.storage.get('x:' + m.id)) return { ok: true, added: false };
    rl.n++; await this.ctx.storage.put('rl:' + ip, rl);
    const { log, replay, ...rest } = m;
    const early = await this.ctx.storage.get('p:' + m.id);
    if(early){ Object.assign(rest.accounts, early.accounts); await this.ctx.storage.delete('p:' + m.id); }
    rest.hasLog = !!(log && log.length); rest.hasReplay = !!replay;
    const key = matchKey(rest.at, m.id);
    await this.ctx.storage.put({ [key]: rest, ['x:' + m.id]: key, ['l:' + m.id]: log || [] });
    if(replay) await this.ctx.storage.put('r:' + m.id, replay);
    const n = ((await this.ctx.storage.get('n')) || 0) + 1;
    await this.ctx.storage.put('n', n);
    if(n > MATCHES_MAX) await this.matchTrim(n - MATCHES_MAX);
    return { ok: true, added: true };
  }
  async matchTrim(k){
    const old = await this.ctx.storage.list({ prefix: 'i:', reverse: true, limit: Math.min(k, 100) });
    const keys = [];
    for(const [key, v] of old) keys.push(key, 'x:' + v.id, 'l:' + v.id, 'r:' + v.id);
    for(let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
    await this.ctx.storage.put('n', Math.max(0, ((await this.ctx.storage.get('n')) || 0) - old.size));
  }
  /** Signed-in players say which seat they had (their game reached their account). */
  async matchLink(user, list){
    for(const { id, seat } of list.slice(0, 50)){
      if(!MATCH_ID.test(String(id)) || !Number.isInteger(seat) || seat < 0 || seat > 3) continue;
      const key = await this.ctx.storage.get('x:' + id);
      if(key){
        const m = await this.ctx.storage.get(key);
        if(m && seat < m.players.length && m.accounts[seat] !== user){ m.accounts[seat] = user; await this.ctx.storage.put(key, m); }
      }else{
        const p = (await this.ctx.storage.get('p:' + id)) || { at: Date.now(), accounts: {} };
        p.accounts[seat] = user;
        await this.ctx.storage.put('p:' + id, p);
      }
    }
    /* a link whose match never arrived (an offline copy, a sandbox it didn't send) is let go after a week */
    const stale = await this.ctx.storage.list({ prefix: 'p:', limit: 50 });
    const gone = [...stale].filter(([, v]) => Date.now() - (v.at || 0) > 7 * 864e5).map(([k]) => k);
    if(gone.length) await this.ctx.storage.delete(gone);
    return { ok: true };
  }
  /** A page of the log, newest first, through one filter. Scans at most 1000 matches per call. */
  async matchList(after, filter, q){
    const keep = MATCH_FILTERS[filter] || MATCH_FILTERS.all;
    const needle = String(q || '').trim().toLowerCase();
    const hit = m => !needle || m.players.some(p => p.name.toLowerCase().includes(needle))
      || Object.values(m.accounts || {}).some(u => u.includes(needle)) || m.id.toLowerCase() === needle;
    const out = [];
    let cursor = after || null, scanned = 0, more = true;
    while(out.length < MATCH_PAGE && scanned < 1000 && more){
      const opts = { prefix: 'i:', limit: 100 };
      if(cursor) opts.startAfter = cursor;
      const page = await this.ctx.storage.list(opts);
      if(page.size < 100) more = false;
      for(const [k, m] of page){
        cursor = k; scanned++;
        if(keep(m) && hit(m)) out.push(m);
        if(out.length >= MATCH_PAGE){ more = true; break; }
      }
      if(!page.size) more = false;
    }
    return { matches: out, next: more ? cursor : null, total: (await this.ctx.storage.get('n')) || 0 };
  }
  async matchGet(id){
    const key = await this.ctx.storage.get('x:' + id);
    const m = key && await this.ctx.storage.get(key);
    if(!m) return { error: 'No such match.', status: 404 };
    const got = await this.ctx.storage.get(['l:' + id, 'r:' + id]);
    return { match: Object.assign({}, m, { log: got.get('l:' + id) || [], replay: got.get('r:' + id) || null }) };
  }
  async matchDelete(id){
    const key = await this.ctx.storage.get('x:' + id);
    if(!key) return { error: 'No such match.', status: 404 };
    await this.ctx.storage.delete([key, 'x:' + id, 'l:' + id, 'r:' + id]);
    await this.ctx.storage.put('n', Math.max(0, ((await this.ctx.storage.get('n')) || 1) - 1));
    return { ok: true };
  }

  async clearGames(secret){
    if(!await this.signedIn(secret)) return { error: 'Signed out.', status: 401 };
    const all = await this.ctx.storage.list({ prefix: 'g:' });
    const reps = await this.ctx.storage.list({ prefix: 'r:' });
    const keys = [...all.keys(), ...reps.keys()];
    for(let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
    return { ok: true };
  }
}

/** The /api/account routes. Returns a Response, or null if the path isn't one of them. */
export async function accountRoute(request, env, url, json){
  if(!/^\/api\/(account|social|users|stats|admin|matches)(\/|$)/.test(url.pathname)) return null;
  const stubFor = u => env.ACCOUNTS.get(env.ACCOUNTS.idFromName(u));
  const reply = r => r.error ? json({ error: r.error }, r.status || 400) : json(r, r.token && url.pathname.endsWith('/register') ? 201 : 200);
  const body = async () => { try{ return await request.json(); }catch(e){ return {}; } };
  const p = url.pathname.replace(/\/+$/, '');

  if((p === '/api/account/register' || p === '/api/account/login') && request.method === 'POST'){
    const b = await body();
    const u = cleanUser(b.username);
    if(!USER_RE.test(u)) return json({ error: 'A username is 3–20 letters, numbers, - or _.' }, 400);
    const stub = stubFor(u);
    const r = p.endsWith('register') ? await stub.register(u, b.password) : await stub.login(u, b.password);
    if(r.token) await stubFor(DIRECTORY).dirPut(u, await stub.displayName(), await stub.displayEmoji());    // listed for search
    return reply(r);
  }

  if(p === '/api/stats' && request.method === 'GET') return json(await stubFor(STATS).statsGet());
  /* the match log: any game page may add the match it just finished, signed in or not */
  if(p === '/api/matches' && request.method === 'POST'){
    const len = +(request.headers.get('Content-Length') || 0);
    if(len > MATCH_BYTES_MAX * 1.5) return json({ error: 'That match is too big to keep.' }, 413);
    const c = cleanMatch((await body()).match);
    if(c.error) return json({ error: c.error }, c.status || 400);
    return reply(await stubFor(MATCHES).matchAdd(c.match, request.headers.get('CF-Connecting-IP') || 'local'));
  }
  if(p.startsWith('/api/admin')) return adminRoute(request, env, p, stubFor, json, body);

  /* everything else needs a session */
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const dot = auth.indexOf('.');
  const u = cleanUser(auth.slice(0, dot)), secret = auth.slice(dot + 1);
  if(dot < 1 || !USER_RE.test(u) || !secret) return json({ error: 'Sign in first.' }, 401);
  const stub = stubFor(u);

  if(p === '/api/account' && request.method === 'GET'){
    const r = await stub.profile(secret);
    if(!r.error) await stubFor(DIRECTORY).dirPut(u, r.name, r.emoji);   // every account that opens the game is findable
    return reply(r);
  }
  if(p === '/api/account' && request.method === 'PUT'){
    const b = await body();
    const r = await stub.setName(secret, b.name, b.emoji);
    if(r.ok) await stubFor(DIRECTORY).dirPut(u, r.name || u, r.emoji);
    return reply(r);
  }
  if(p === '/api/account/logout' && request.method === 'POST') return reply(await stub.logout(secret));
  if(p === '/api/account/games' && request.method === 'POST'){
    const r = await stub.addGames(secret, (await body()).games);
    if(r.fresh && r.fresh.length){ try{ await stubFor(STATS).statsMerge(r.fresh, u); }catch(e){} }
    /* this account played these: the match log shows the username on that seat */
    if(r.seats && r.seats.length){ try{ await stubFor(MATCHES).matchLink(u, r.seats); }catch(e){} }
    delete r.fresh; delete r.seats;
    return reply(r);
  }
  if(p === '/api/account/games' && request.method === 'DELETE') return reply(await stub.clearGames(secret));
  const gm = p.match(/^\/api\/account\/games\/([A-Za-z0-9]{4,40})$/);
  if(gm && request.method === 'GET') return reply(await stub.game(secret, gm[1]));
  if(p.startsWith('/api/social') || p.startsWith('/api/users')) return socialRoute(request, env, p, u, secret, stub, stubFor, reply, json, body, url);
  return json({ error: 'Not found.' }, 404);
}

const DIRECTORY = '~directory', STATS = '~stats', ADMIN = '~admin', MATCHES = '~matches';
const sha256 = async t => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
/** The admin lock on the Studio.
     POST /api/admin/login  {password} -> {token}    (the password is the ADMIN_PASSWORD secret)
     GET  /api/admin                   -> {admin:true}   with Authorization: Bearer <token>
     POST /api/admin/logout
     GET  /api/admin/users[?after=]  ·  /users/<u>  ·  /users/<u>/games/<id>
     GET  /api/admin/matches[?after=&f=&q=]   every match, newest first, 40 a page
     GET  /api/admin/matches/<id>             one match with its full log and replay
     DELETE /api/admin/matches/<id>
     POST /api/admin/stats/rebuild {after?}   add everyone's stats up again, 25 accounts a call
   Changing the secret signs every admin browser out. */
async function adminRoute(request, env, p, stubFor, json, body){
  const secretPw = env.ADMIN_PASSWORD;
  if(!secretPw) return json({ error: 'No admin password has been set on the server yet.', unset: true }, 503);
  const fp = (await sha256('territory-admin:' + secretPw)).slice(0, 24);
  const reply = r => r && r.error ? json({ error: r.error }, r.status || 400) : json(r);
  const gate = stubFor(ADMIN);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  if(p === '/api/admin/login' && request.method === 'POST'){
    const g = await gate.adminGate(ip);
    if(g.wait) return json({ error: `Too many wrong passwords. Try again in ${Math.ceil(g.wait / 60)} minute${g.wait > 60 ? 's' : ''}.`, wait: g.wait }, 429);
    const b = await body();
    const ok = typeof b.password === 'string' && sameText(await sha256(b.password), await sha256(secretPw));
    if(!ok){ await gate.adminFail(ip); return json({ error: 'That isn’t the admin password.' }, 401); }
    return json(await gate.adminOpen(ip, fp));
  }
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const secret = auth.startsWith('admin.') ? auth.slice(6) : '';
  const isAdmin = async () => !!(secret && await gate.adminCheck(secret, fp));
  if(p === '/api/admin' && request.method === 'GET')
    return (await isAdmin()) ? json({ admin: true }) : json({ error: 'Not an admin session.' }, 401);
  if(p === '/api/admin/logout' && request.method === 'POST'){ if(secret) await gate.adminClose(secret); return json({ ok: true }); }
  /* everything below needs an admin session */
  if(!(await isAdmin())) return json({ error: 'Not an admin session.' }, 401);
  const url = new URL(request.url);
  const am = p.match(/^\/api\/admin\/users(?:\/([a-z0-9_-]{3,20})(?:\/games\/([A-Za-z0-9]{4,40}))?)?$/);
  if(am && request.method === 'GET'){
    if(!am[1]){
      /* every listed account, a page at a time (100), each with its summary */
      const names = await stubFor(DIRECTORY).dirAll(url.searchParams.get('after') || '', 100);
      const users = (await Promise.all(names.map(n => stubFor(n).adminSummary().catch(() => null)))).filter(Boolean);
      return json({ users, next: names.length === 100 ? names[names.length - 1] : null });
    }
    const st = stubFor(am[1]);
    if(!am[2]) return reply(await st.adminDetail());
    return reply(await st.publicGame(am[2]));
  }
  const mm = p.match(/^\/api\/admin\/matches(?:\/([A-Za-z0-9]{4,40}))?$/);
  if(mm){
    const log = stubFor(MATCHES);
    if(!mm[1] && request.method === 'GET')
      return reply(await log.matchList(String(url.searchParams.get('after') || '').slice(0, 80), url.searchParams.get('f') || 'all', String(url.searchParams.get('q') || '').slice(0, 40)));
    if(mm[1] && request.method === 'GET') return reply(await log.matchGet(mm[1]));
    if(mm[1] && request.method === 'DELETE') return reply(await log.matchDelete(mm[1]));
  }
  if(p === '/api/admin/stats/rebuild' && request.method === 'POST'){
    const b = await body();
    const after = cleanUser(b.after || '');
    const names = await stubFor(DIRECTORY).dirAll(after, 25);
    const pages = (await Promise.all(names.map(async n => ({ user: n, games: await stubFor(n).statsGames().catch(() => []) }))));
    const done = names.length < 25;
    const r = await stubFor(STATS).statsRebuildStep(!after, pages, done);
    return json({ next: done ? null : names[names.length - 1], accounts: names.length, games: r.games });
  }
  return json({ error: 'Not found.' }, 404);
}
/** Friends, requests, invites, other players' profiles and comments.
     GET    /api/social                    -> {friends:[{user,name,record}], incoming, outgoing, invites}
     GET    /api/social/poll               -> {incoming:n, invites:[…]}      (cheap, for polling)
     POST   /api/social/request  {user}    ask to be friends (or accept, if they asked first)
     POST   /api/social/accept   {user}
     POST   /api/social/decline  {user}    turn down, or take back, a request
     POST   /api/social/remove   {user}    stop being friends
     POST   /api/social/invite   {user, code}   invite a friend to a room
     POST   /api/social/dismiss  {code}
     GET    /api/users?q=ab                -> {users:[{user,name}]}
     GET    /api/users/:u                  -> {username, name, record, games, relation}
     GET    /api/users/:u/games/:id        -> {game, comments}
     POST   /api/users/:u/games/:id/comments          {text}
     DELETE /api/users/:u/games/:id/comments/:cid */
async function socialRoute(request, env, p, me, secret, stub, stubFor, reply, json, body, url){
  if(!await stub.signedIn(secret)) return json({ error: 'Signed out.' }, 401);
  const method = request.method;
  const other = async user => {
    const v = cleanUser(user);
    if(!USER_RE.test(v)) return null;
    const s = stubFor(v);
    return (await s.exists()) ? { user: v, stub: s } : null;
  };

  if(p === '/api/social' && method === 'GET'){
    const r = await stub.rel();
    await stubFor(DIRECTORY).dirPut(me, await stub.displayName(), await stub.displayEmoji());      // accounts made before search existed
    const friends = await Promise.all(r.friends.map(async f => {
      const s = stubFor(f);
      try{ return { user: f, name: await s.displayName(), emoji: await s.displayEmoji(), record: await s.record() }; }catch(e){ return { user: f, name: f, record: null }; }
    }));
    const named = list => Promise.all(list.map(async o => { const s = stubFor(o.user); return Object.assign({}, o, { name: await s.displayName(), emoji: await s.displayEmoji() }); }));
    return json({ friends, incoming: await named(r.incoming), outgoing: await named(r.outgoing), invites: r.invites, max: FRIENDS_MAX });
  }
  if(p === '/api/social/poll' && method === 'GET'){
    const r = await stub.rel();
    return json({ incoming: r.incoming.length, invites: r.invites });
  }
  const sm = p.match(/^\/api\/social\/(request|accept|decline|remove|invite|dismiss)$/);
  if(sm && method === 'POST'){
    const b = await body();
    if(sm[1] === 'dismiss') return reply(await stub.relDismiss(String(b.code || '')));
    const o = await other(b.user);
    if(!o) return json({ error: 'No player with that username.' }, 404);
    if(o.user === me) return json({ error: 'That’s you.' }, 400);
    const mine = await stub.rel();
    switch(sm[1]){
      case 'request': {
        if(mine.friends.includes(o.user)) return json({ ok: true, friends: true });
        if(mine.friends.length >= FRIENDS_MAX) return json({ error: 'You already have ' + FRIENDS_MAX + ' friends.' }, 409);
        if(mine.incoming.some(x => x.user === o.user)){          // they asked first: this is a yes
          if(mine.friends.length >= FRIENDS_MAX) return json({ error: 'You already have ' + FRIENDS_MAX + ' friends.' }, 409);
          if(await o.stub.friendCount() >= FRIENDS_MAX) return json({ error: 'They already have ' + FRIENDS_MAX + ' friends.' }, 409);
          await stub.relBefriend(o.user); await o.stub.relBefriend(me);
          return json({ ok: true, friends: true });
        }
        const r = await o.stub.relIncoming(me);
        if(r.error) return reply(r);
        await stub.relOutgoing(o.user, !!r.friends);
        return json({ ok: true, friends: !!r.friends });
      }
      case 'accept': {
        if(!mine.incoming.some(x => x.user === o.user)) return json({ error: 'There’s no request from them.' }, 404);
        if(mine.friends.length >= FRIENDS_MAX) return json({ error: 'You already have ' + FRIENDS_MAX + ' friends.' }, 409);
        if(await o.stub.friendCount() >= FRIENDS_MAX) return json({ error: 'They already have ' + FRIENDS_MAX + ' friends.' }, 409);
        await stub.relBefriend(o.user); await o.stub.relBefriend(me);
        return json({ ok: true, friends: true });
      }
      case 'decline': case 'remove':
        await stub.relDrop(o.user); await o.stub.relDrop(me);
        return json({ ok: true });
      case 'invite': {
        if(!mine.friends.includes(o.user)) return json({ error: 'You can only invite friends.' }, 403);
        const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        if(!code) return json({ error: 'Which room?' }, 400);
        return reply(await o.stub.relInvite({ from: me, name: await stub.displayName(), emoji: await stub.displayEmoji(), code }));
      }
    }
  }

  if(p === '/api/users' && method === 'GET'){
    const q = cleanUser(url.searchParams.get('q') || '').replace(/[^a-z0-9_-]/g, '');
    if(q.length < 1) return json({ users: [] });
    const users = (await stubFor(DIRECTORY).dirSearch(q)).filter(x => x.user !== me);
    /* an account nobody has opened since search arrived isn't listed yet: an exact username still finds it */
    if(USER_RE.test(q) && q !== me && !users.some(x => x.user === q)){
      const card = await stubFor(q).card();
      if(card){ users.unshift(card); await stubFor(DIRECTORY).dirPut(card.user, card.name, card.emoji); }
    }
    return json({ users });
  }
  const um = p.match(/^\/api\/users\/([a-z0-9_-]{3,20})(?:\/games\/([A-Za-z0-9]{4,40})(?:\/comments(?:\/([a-f0-9]{6,20}))?)?)?$/i);
  if(um){
    const o = await other(um[1]);
    if(!o) return json({ error: 'No player with that username.' }, 404);
    if(!um[2] && method === 'GET'){
      const r = await o.stub.publicProfile();
      if(r.error) return reply(r);
      const mine = await stub.rel();
      r.relation = o.user === me ? 'self' : mine.friends.includes(o.user) ? 'friend'
        : mine.outgoing.some(x => x.user === o.user) ? 'asked' : mine.incoming.some(x => x.user === o.user) ? 'asking' : 'none';
      return json(r);
    }
    if(um[2] && !p.includes('/comments') && method === 'GET') return reply(await o.stub.publicGame(um[2]));
    if(um[2] && p.endsWith('/comments') && method === 'POST')
      return reply(await o.stub.addComment(um[2], me, await stub.displayName(), (await body()).text));
    if(um[3] && method === 'DELETE') return reply(await o.stub.deleteComment(um[2], um[3], me));
  }
  return json({ error: 'Not found.' }, 404);
}
