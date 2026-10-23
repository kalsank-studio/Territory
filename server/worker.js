/* ===================================================================
   TERRITORY — the online room relay (Cloudflare Worker + Durable Object)

   The game page itself is static (dist/, served by Cloudflare straight from
   the assets folder). This Worker only answers /api/…, and its one job is to
   pass messages between the players in a room. It never looks inside them:
   the host's browser runs the game and decides what everyone else sees.

     POST /api/rooms                  -> 201 {code, seats}       make a room
     GET  /api/rooms/:code            -> 200 {code, seats, ...}  does it exist, who's in it
     GET  /api/rooms/:code/socket     -> WebSocket                take a seat
          ?token=…  reclaim the seat this token held (reconnecting)
          ?name=…   what to call this player

   Player accounts (name, record, match history) are in accounts.js:
   /api/account/… — see there.

   On the socket, a client sends JSON:
     {data, to?}   relay `data`; `to` is a seat number, 'host' or 'all'.
                   Unset: the host's messages go to everyone else, a guest's
                   to the host.
     "ping"        answered "pong" without waking the room (keep-alive)
   and receives JSON:
     {sys:'welcome', seat, token, host, size, seats}   you're in; keep the token
     {sys:'seats', seats, joined?|left?}         someone came or went
     {from, data}                                a relayed message
     {sys:'error', why}                          something it couldn't relay

   Seat 0 is the host: whoever made the room and connects first. A room that
   has had nobody connected for a day deletes itself.
   =================================================================== */

import { DurableObject } from 'cloudflare:workers';
import { Account, accountRoute } from './accounts.js';
export { Account };

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
const CODE_LENGTH = 5;
const MAX_SEATS = 4;
const IDLE_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 24;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

function newCode(){
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const roomFor = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    if(request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if(url.pathname === '/api/rooms' && request.method === 'POST'){
      let opts = {};
      try{ opts = await request.json(); }catch(e){}
      const seats = Math.min(MAX_SEATS, Math.max(2, parseInt(opts.seats, 10) || 2));
      /* five characters from 31 is 28 million codes; a clash is rare, but checked */
      for(let tries = 0; tries < 5; tries++){
        const code = newCode();
        if(await roomFor(env, code).init(code, seats)) return json({ code, seats }, 201);
      }
      return json({ error: 'Could not find a free room code. Try again.' }, 503);
    }

    if(url.pathname === '/api/lobbies' && request.method === 'GET'){
      const reg = env.ACCOUNTS.get(env.ACCOUNTS.idFromName('~lobbies'));
      return json({ lobbies: await reg.lobbyList() });
    }
    const lm = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/listing\/?$/);
    if(lm && request.method === 'POST'){
      let b = {};
      try{ b = await request.json(); }catch(e){}
      const r = await roomFor(env, cleanCode(lm[1])).setListing(String(b.token || ''), b);
      return r.error ? json({ error: r.error }, r.status || 400) : json(r);
    }

    const m = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)(\/socket)?\/?$/);
    if(m){
      const code = cleanCode(m[1]);
      const room = roomFor(env, code);
      if(m[2]){
        if(request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Connect with a WebSocket.' }, 426);
        return room.fetch(request);
      }
      const info = await room.info();
      return info ? json(info) : json({ error: 'No room with that code.' }, 404);
    }

    const acct = await accountRoute(request, env, url, json);
    if(acct) return acct;

    if(url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
    /* Everything else is a file in dist/, served before this Worker runs.
       Reaching here means there's no such file. */
    return new Response('Not found', { status: 404 });
  }
};

/* -------------------------------------------------------------------
   One room. Its state is tiny: the code, how many seats, and who holds
   each seat (a random token per seat, so a dropped player can come back
   to the same chair). Sockets use the hibernation API: an idle room costs
   nothing, and wakes when a message arrives.
   ------------------------------------------------------------------- */
export class Room extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    /* keep-alives are answered without waking the room */
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Make the room. False if this code is already in use. */
  async init(code, seats){
    if(await this.ctx.storage.get('room')) return false;
    await this.ctx.storage.put('room', { code, seats, created: Date.now() });
    await this.ctx.storage.put('holders', []);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    return true;
  }

  /* --- the lobby search ------------------------------------------------
     The host says whether the room is public and what it's playing; the room
     itself knows how many seats are left and whether the host is here, and
     keeps the shared list (one more object, "~lobbies") up to date. */
  async setListing(token, info){
    const holders = (await this.ctx.storage.get('holders')) || [];
    const host = holders.find(h => h.seat === 0);
    if(!host || !token || host.token !== token) return { error: 'Only the host can list this room.', status: 403 };
    const clean = v => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, 40);
    const listing = { public: !!info.public, playing: !!info.playing, planets: info.planets | 0, rounds: info.rounds | 0,
                      sandbox: !!info.sandbox, sharedDeck: !!info.sharedDeck, emoji: clean(info.emoji).replace(/[A-Za-z0-9<>]/g, '').slice(0, 16) };
    await this.ctx.storage.put('listing', listing);
    await this.pushListing();
    return { ok: true };
  }
  async pushListing(gone, except){
    const room = await this.ctx.storage.get('room');
    if(!room) return;
    const reg = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('~lobbies'));
    const listing = await this.ctx.storage.get('listing');
    const holders = (await this.ctx.storage.get('holders')) || [];
    const hostHere = this.ctx.getWebSockets('seat:0').filter(w => w !== except).length > 0 && !gone;
    if(gone || !listing || !listing.public){ await reg.lobbyPut(room.code, null); return; }
    const host = holders.find(h => h.seat === 0) || {};
    await reg.lobbyPut(room.code, Object.assign({}, listing, { code: room.code, seats: room.seats, taken: holders.length,
      host: host.name || 'Host', hostHere, updated: Date.now() }));
  }

  async info(){
    const room = await this.ctx.storage.get('room');
    if(!room) return null;
    return { code: room.code, seats: room.seats, host: 0, players: await this.seatList() };
  }

  /** Who holds which seat, and whether they're connected right now. */
  async seatList(except){
    const holders = (await this.ctx.storage.get('holders')) || [];
    const online = new Set(this.ctx.getWebSockets().filter(ws => ws !== except).map(ws => (ws.deserializeAttachment() || {}).seat));
    return holders.map(h => ({ seat: h.seat, name: h.name, emoji: h.emoji || '', online: online.has(h.seat) }));
  }

  async fetch(request){
    const room = await this.ctx.storage.get('room');
    if(!room) return json({ error: 'No room with that code.' }, 404);
    const url = new URL(request.url);
    const token = (url.searchParams.get('token') || '').slice(0, 64);
    const name = (url.searchParams.get('name') || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_MAX);
    const rawEmoji = (url.searchParams.get('emoji') || '').replace(/[\u0000-\u001f\s]/g, '').slice(0, 16);
    const emoji = /[A-Za-z0-9<>]/.test(rawEmoji) ? '' : rawEmoji;

    const holders = (await this.ctx.storage.get('holders')) || [];
    let me = token && holders.find(h => h.token === token);
    if(!me){
      const taken = new Set(holders.map(h => h.seat));
      let seat = 0;
      while(taken.has(seat)) seat++;
      if(seat >= room.seats) return json({ error: 'That room is full.' }, 409);
      me = { seat, token: crypto.randomUUID(), name: name || (seat === 0 ? 'Host' : 'Player ' + (seat + 1)) };
      holders.push(me);
    }else if(name) me.name = name;
    if(url.searchParams.has('emoji')) me.emoji = emoji;
    await this.ctx.storage.put('holders', holders);

    /* the same seat connecting again replaces its older socket */
    this.ctx.getWebSockets('seat:' + me.seat).forEach(old => { try{ old.close(4000, 'Replaced by a newer connection'); }catch(e){} });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['seat:' + me.seat]);
    server.serializeAttachment({ seat: me.seat });

    const seats = await this.seatList();
    server.send(JSON.stringify({ sys: 'welcome', seat: me.seat, token: me.token, host: 0, code: room.code, size: room.seats, seats }));
    this.broadcast({ sys: 'seats', seats, joined: me.seat }, server);
    this.ctx.waitUntil(this.pushListing().catch(() => {}));
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message){
    const from = (ws.deserializeAttachment() || {}).seat;
    if(from == null || typeof message !== 'string') return;
    let msg;
    try{ msg = JSON.parse(message); }catch(e){ return this.tell(ws, 'Messages must be JSON.'); }
    if(!msg || typeof msg !== 'object' || !('data' in msg)) return this.tell(ws, 'Send {data, to?}.');

    const to = msg.to == null ? (from === 0 ? 'all' : 'host') : msg.to;
    const out = JSON.stringify({ from, data: msg.data });
    const targets = to === 'all'  ? this.ctx.getWebSockets().filter(s => s !== ws)
                  : to === 'host' ? this.ctx.getWebSockets('seat:0')
                  : Number.isInteger(to) ? this.ctx.getWebSockets('seat:' + to)
                  : null;
    if(!targets) return this.tell(ws, '"to" must be a seat number, "host" or "all".');
    if(!targets.length && to !== 'all') return this.tell(ws, to === 'host' ? 'The host is not connected.' : 'Seat ' + to + ' is not connected.');
    targets.forEach(s => { try{ s.send(out); }catch(e){} });
  }

  async webSocketClose(ws, code, reason){
    const seat = (ws.deserializeAttachment() || {}).seat;
    try{ ws.close(code, reason); }catch(e){}
    this.broadcast({ sys: 'seats', seats: await this.seatList(ws), left: seat }, ws);
    if(seat === 0){ try{ await this.pushListing(false, ws); }catch(e){} }
  }
  async webSocketError(ws){ return this.webSocketClose(ws, 1011, 'error'); }

  /** A day with nobody connected: the room forgets itself. */
  async alarm(){
    if(this.ctx.getWebSockets().length){ await this.ctx.storage.setAlarm(Date.now() + IDLE_MS); return; }
    try{ await this.pushListing(true); }catch(e){}
    await this.ctx.storage.deleteAll();
  }

  broadcast(obj, except){
    const out = JSON.stringify(obj);
    this.ctx.getWebSockets().forEach(s => { if(s !== except){ try{ s.send(out); }catch(e){} } });
  }
  tell(ws, why){ try{ ws.send(JSON.stringify({ sys: 'error', why })); }catch(e){} }
}
