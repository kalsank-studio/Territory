/* The room relay, end to end, against a real local Worker (wrangler dev).
   node test/test-relay.mjs                    starts its own local Worker
   BASE=https://your.workers.dev node test/…   tests a deployed one instead */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

let BASE = process.env.BASE;
let dev = null;
let fails = 0;
const check = (cond, msg) => { if(!cond){ fails++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };

async function startDev(){
  const port = 8790 + Math.floor(Math.random() * 100);
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  BASE = `http://127.0.0.1:${port}`;
  for(let i = 0; i < 120; i++){
    try{ const r = await fetch(BASE + '/api/rooms/NOPE0'); if(r.status) return; }catch(e){}
    await wait(500);
  }
  throw new Error('wrangler dev did not start');
}

/** A socket plus an inbox to wait on. */
function connect(code, q = ''){
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + `/api/rooms/${code}/socket` + q);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', e => {
    const m = e.data === 'pong' ? 'pong' : JSON.parse(e.data);
    const w = waiters.findIndex(x => x.test(m));
    if(w >= 0){ waiters.splice(w, 1)[0].resolve(m); } else inbox.push(m);
  });
  const next = (test = () => true, ms = 4000) => {
    const i = inbox.findIndex(test);
    if(i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      waiters.push(w);
      setTimeout(() => { const k = waiters.indexOf(w); if(k >= 0){ waiters.splice(k, 1); reject(new Error('timed out')); } }, ms);
    });
  };
  const opened = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  opened.catch(() => {});                       // a refused connection is checked through `closed`
  const closed = new Promise(res => ws.addEventListener('close', e => res(e)));
  return { ws, next, opened, closed, send: o => ws.send(typeof o === 'string' ? o : JSON.stringify(o)) };
}

try{
  if(!BASE) await startDev();
  console.log('relay at', BASE);

  const page = await fetch(BASE + '/');
  check(page.status === 200 && (await page.text()).includes('<title>Territory</title>'), 'the game page is served at /');
  const lib = await fetch(BASE + '/library.json');
  check(lib.status === 200 && (await lib.json()).cards.length > 0, 'library.json is served beside it');

  check((await fetch(BASE + '/api/rooms/ZZZZZ')).status === 404, 'an unknown room code is a 404');
  const made = await (await fetch(BASE + '/api/rooms', { method: 'POST', body: '{}' })).json();
  check(/^[A-Z2-9]{5}$/.test(made.code), 'a room gets a five-character code: ' + made.code);
  const code = made.code;

  const host = connect(code, '?name=Kal');
  await host.opened;
  const hw = await host.next(m => m.sys === 'welcome');
  check(hw.seat === 0 && hw.host === 0 && hw.token, 'the first to connect is the host, seat 0');

  const guest = connect(code.toLowerCase(), '?name=Sam');
  await guest.opened;
  const gw = await guest.next(m => m.sys === 'welcome');
  check(gw.seat === 1, 'the next is seat 1 (the code is not case-sensitive)');
  const joined = await host.next(m => m.sys === 'seats');
  check(joined.joined === 1 && joined.seats.every(s => s.online) && joined.seats[1].name === 'Sam', 'the host hears that Sam joined');

  guest.send({ data: { t: 'place', uid: 'cabc', p: 0, s: 1 } });
  const toHost = await host.next(m => m.from === 1);
  check(toHost.data.t === 'place', "a guest's message goes to the host");
  host.send({ data: { view: 'state for seat 1' } });
  const toGuest = await guest.next(m => m.from === 0);
  check(toGuest.data.view === 'state for seat 1', "the host's message goes to the guest");
  host.send({ to: 1, data: 'direct' });
  check((await guest.next(m => m.from === 0)).data === 'direct', 'the host can address one seat');

  guest.send('ping');
  check((await guest.next(m => m === 'pong')) === 'pong', 'ping is answered pong');
  guest.send('not json');
  check((await guest.next(m => m.sys === 'error')).why.includes('JSON'), 'a non-JSON message gets an error back');

  const third = connect(code);
  const refused = await Promise.race([
    new Promise(res => { third.ws.addEventListener('error', () => res(true)); third.ws.addEventListener('close', () => res(true)); }),
    third.opened.then(() => false, () => true),
    wait(4000).then(() => false)
  ]);
  check(refused, 'a third player is turned away from a two-seat room');
  const status = await (await fetch(BASE + `/api/rooms/${code}`)).json();
  check(status.players.length === 2, 'the room lists its two players');

  /* the guest drops and comes back with its token */
  guest.ws.close();
  const left = await host.next(m => m.sys === 'seats' && m.left === 1);
  check(left.seats.find(s => s.seat === 1).online === false, 'the host hears the guest left');
  const back = connect(code, `?token=${gw.token}`);
  await back.opened;
  const bw = await back.next(m => m.sys === 'welcome');
  check(bw.seat === 1 && bw.token === gw.token, 'the guest reclaims seat 1 with its token');
  await host.next(m => m.sys === 'seats' && m.joined === 1);
  back.send({ data: 'hello again' });
  check((await host.next(m => m.from === 1)).data === 'hello again', 'relaying works after reconnecting');

  host.ws.close(); back.ws.close();
  const big = await (await fetch(BASE + '/api/rooms', { method: 'POST', body: JSON.stringify({ seats: 4 }) })).json();
  check(big.seats === 4, 'a room can have up to four seats');
}catch(e){
  fails++; console.log('  FAIL', e.message);
}finally{
  if(dev) dev.kill();
  console.log(fails ? fails + ' failures' : 'relay: all checks passed');
  process.exit(fails ? 1 : 0);
}
