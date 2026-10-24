/* The admin lock on the Studio, against a real local Worker.
   Needs ADMIN_PASSWORD in .dev.vars (wrangler dev reads it), or pass ADMIN_PW with BASE for a deployed copy.
   node test/test-admin.mjs */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
let BASE = process.env.BASE, dev = null, fails = 0;
let PW = process.env.ADMIN_PW;
if(!PW){ try{ PW = readFileSync('.dev.vars', 'utf8').match(/ADMIN_PASSWORD\s*=\s*"?([^"\n]*)"?/)[1]; }catch(e){} }
const check = (c, m) => { if(!c){ fails++; console.log('  FAIL', m); } else console.log('  ok  ', m); };
async function startDev(){
  const port = 9100 + Math.floor(Math.random() * 100);
  dev = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  BASE = `http://127.0.0.1:${port}`;
  for(let i = 0; i < 120; i++){ try{ const r = await fetch(BASE + '/api/rooms/NOPE0'); if(r.status) return; }catch(e){} await wait(500); }
  throw new Error('wrangler dev did not start');
}
const call = async (method, path, body, token, ip) => {
  const h = { 'Content-Type': 'application/json' };
  if(token) h.Authorization = 'Bearer ' + token;
  if(ip) h['CF-Connecting-IP'] = ip;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try{ j = await r.json(); }catch(e){}
  return { status: r.status, body: j || {} };
};
try{
  if(!PW) throw new Error('No admin password: put ADMIN_PASSWORD in .dev.vars');
  if(!BASE) await startDev();
  console.log('admin at', BASE);
  let r = await call('GET', '/api/admin');
  check(r.status === 401, 'no session, no admin');
  r = await call('POST', '/api/admin/login', { password: PW + 'x' });
  check(r.status === 401 && !r.body.token, 'a wrong password is refused');
  r = await call('POST', '/api/admin/login', { password: PW });
  check(r.status === 200 && /^admin\./.test(r.body.token || ''), 'the right password (symbols and spaces and all) opens a session');
  const t = r.body.token;
  r = await call('GET', '/api/admin', null, t);
  check(r.status === 200 && r.body.admin === true, 'the session is an admin');
  r = await call('GET', '/api/admin', null, 'admin.' + 'f'.repeat(64));
  check(r.status === 401, 'a made-up session is refused');
  r = await call('GET', '/api/admin', null, t.replace(/^admin\./, 'kal.'));
  check(r.status === 401, 'a player token is not an admin session');
  // a guesser: five wrong tries from one address, then it waits — even with the right password
  const ip = '203.0.113.' + Math.floor(Math.random() * 200);
  for(let i = 0; i < 5; i++) await call('POST', '/api/admin/login', { password: 'guess' + i }, null, ip);
  r = await call('POST', '/api/admin/login', { password: PW }, null, ip);
  check(r.status === 429, 'after five wrong passwords that address has to wait');
  r = await call('POST', '/api/admin/logout', null, t);
  r = await call('GET', '/api/admin', null, t);
  check(r.status === 401, 'locking the Studio ends the session');
}catch(e){ fails++; console.log('  FAIL', e.message); }
finally{ if(dev) dev.kill(); console.log(fails ? fails + ' failures' : 'admin: all checks passed'); process.exit(fails ? 1 : 0); }
