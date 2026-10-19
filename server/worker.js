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

  async info(){
    const room = await this.ctx.storage.get('room');
    if(!room) return null;
    return { code: room.code, seats: room.seats, host: 0, players: await this.seatList() };
  }

  /** Who holds which seat, and whether they're connected right now. */
  async seatList(except){
    const holders = (await this.ctx.storage.get('holders')) || [];
    const online = new Set(this.ctx.getWebSockets().filter(ws => ws !== except).map(ws => (ws.deserializeAttachment() || {}).seat));
    return holders.map(h => ({ seat: h.seat, name: h.name, online: online.has(h.seat) }));
  }

  async fetch(request){
    const room = await this.ctx.storage.get('room');
    if(!room) return json({ error: 'No room with that code.' }, 404);
    const url = new URL(request.url);
    const token = (url.searchParams.get('token') || '').slice(0, 64);
    const name = (url.searchParams.get('name') || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_MAX);

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
  }
  async webSocketError(ws){ return this.webSocketClose(ws, 1011, 'error'); }

  /** A day with nobody connected: the room forgets itself. */
  async alarm(){
    if(this.ctx.getWebSockets().length){ await this.ctx.storage.setAlarm(Date.now() + IDLE_MS); return; }
    await this.ctx.storage.deleteAll();
  }

  broadcast(obj, except){
    const out = JSON.stringify(obj);
    this.ctx.getWebSockets().forEach(s => { if(s !== except){ try{ s.send(out); }catch(e){} } });
  }
  tell(ws, why){ try{ ws.send(JSON.stringify({ sys: 'error', why })); }catch(e){} }
}
