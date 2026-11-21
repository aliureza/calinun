import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createUpstream } from '../src/upstream.js';
import { createPusher } from '../src/push.js';
import { createScheduler } from '../src/scheduler.js';
import { createApp } from '../src/app.js';
import { startMockSite } from './helpers/mock-site.js';

let site, app, base, dir, store, cfg;
const APP_URL = 'http://localhost:5173/cullinon/';

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const J = (token, method, p, body) => fetch(base + p, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  site = await startMockSite();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cull-'));
  cfg = createConfig({
    PUBLIC_URL: base, APP_URL, ALLOWED_HOSTS: '127.0.0.1', ALLOW_PRIVATE_UPSTREAM: 'true',
    ALLOWED_PORTS: String(site.port), MASTER_KEY: crypto.randomBytes(32).toString('hex'), DATA_DIR: dir,
  });
  store = new Store(dir, cfg.masterKey);
  const upstream = createUpstream(cfg);
  const pusher = createPusher({ cfg, upstream });
  const scheduler = createScheduler({ cfg, store, upstream, pusher, log: { warn() {}, error() {} } });
  app = createApp({ cfg, store, upstream, pusher, scheduler });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
});
after(() => { app.server.close(); site.close(); store.flush(); });

let token, proxyUrl, sid;

test('config refuses unsafe setups', () => {
  const ok = { PUBLIC_URL: 'https://api.x.com', APP_URL: 'https://u.github.io/a/', ALLOWED_HOSTS: 'a.b', MASTER_KEY: 'aa'.repeat(32) };
  assert.doesNotThrow(() => createConfig(ok));
  assert.throws(() => createConfig({ ...ok, PUBLIC_URL: 'http://api.x.com' }), /https/);
  assert.throws(() => createConfig({ ...ok, PUBLIC_URL: 'https://u.github.io' }), /different origins/);
  assert.throws(() => createConfig({ ...ok, ALLOWED_HOSTS: '' }), /ALLOWED_HOSTS/);
  assert.throws(() => createConfig({ ...ok, MASTER_KEY: '' }), /MASTER_KEY/);
});

test('start: rejects hosts outside the allow-list and internal addresses', async () => {
  for (const loginUrl of ['https://evil.example.com/Login.aspx', 'http://169.254.169.254/latest', `http://localhost:${site.port}/Login.aspx`, 'ftp://x/y', 'not a url']) {
    const r = await J(null, 'POST', '/api/session/start', { loginUrl });
    assert.ok([400, 403].includes(r.status), `${loginUrl} → ${r.status}`);
  }
});

test('start → proxied login page is rewritten, cookies stay server-side', async () => {
  const r = await J(null, 'POST', '/api/session/start', { loginUrl: `http://127.0.0.1:${site.port}/Login.aspx` });
  assert.equal(r.status, 200);
  proxyUrl = (await r.json()).proxyUrl;
  sid = /\/p\/([\w-]{22})\//.exec(proxyUrl)[1];
  const page = await fetch(proxyUrl);
  const html = await page.text();
  assert.match(html, new RegExp(`href="/p/${sid}/Styles/a.css"`));
  assert.match(html, new RegExp(`src="/p/${sid}/Captcha.ashx`));
  assert.match(html, new RegExp(`url\\(/p/${sid}/img/bg.png\\)`));
  assert.match(html, /رمز عبور شما ذخیره نمی‌شود/);
  const setCookie = page.headers.getSetCookie().join('|');
  assert.doesNotMatch(setCookie, /ASP\.NET_SessionId/, 'upstream cookies must never reach the browser');
  assert.match(setCookie, /^pxs=/);
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  const img = await fetch(`${base}/p/${sid}/Captcha.ashx?id=1`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await img.arrayBuffer()).byteLength, 7);
});

test('wrong password does not finish the login', async () => {
  const r = await fetch(`${base}/p/${sid}/Login.aspx`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=demo&pwd=bad' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /wrong/);
});

test('correct password → redirect to the app with a one-time claim code → token', async () => {
  await sleep(1600); // probe debounce
  const r = await fetch(`${base}/p/${sid}/Login.aspx`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=demo&pwd=ok' });
  assert.equal(r.status, 302);
  const loc = r.headers.get('location');
  assert.ok(loc.startsWith(`${APP_URL}#claim=`), loc);
  const code = loc.split('#claim=')[1];
  const c1 = await J(null, 'POST', '/api/session/claim', { code });
  assert.equal(c1.status, 200);
  token = (await c1.json()).token;
  assert.ok(token.length >= 40);
  assert.equal((await J(null, 'POST', '/api/session/claim', { code })).status, 404, 'claim codes are single-use');
  assert.equal((await fetch(proxyUrl)).status, 410, 'login proxy link dies after success');
});

test('the password is never stored anywhere on disk', async () => {
  store.flush();
  const raw = fs.readFileSync(path.join(dir, 'store.bin'));
  assert.ok(!raw.includes(Buffer.from('AUTH=session-123')), 'store is encrypted at rest');
  assert.ok(!raw.includes(Buffer.from('127.0.0.1')), 'store is encrypted at rest');
  assert.equal((fs.statSync(path.join(dir, 'store.bin')).mode & 0o077), 0, 'file mode is 0600');
  assert.ok(!JSON.stringify(store.all()).includes('pwd=ok'));
});

test('initial collection fetches 4 weeks using only week-navigation postbacks', async () => {
  let st;
  for (let i = 0; i < 40; i++) {
    st = await (await J(token, 'GET', '/api/state')).json();
    if (st.snapshot) break;
    await sleep(100);
  }
  assert.ok(st.snapshot, 'snapshot arrives after login');
  assert.deepEqual(st.snapshot.weeks.map((w) => w.offset), [-1, 0, 1, 2]);
  for (const w of st.snapshot.weeks) assert.equal(w.days.length, 7);
  const w0 = st.snapshot.weeks.find((w) => w.offset === 0);
  assert.equal(w0.days[2].iso, '2026-11-23');
  assert.equal(st.snapshot.weeks.find((w) => w.offset === 1).from, '1405/09/07');
  assert.equal(st.snapshot.weeks.find((w) => w.offset === -1).from, '1405/08/23');
  assert.equal(site.state.badPosts, 0, 'every POST carried a valid VIEWSTATE, Origin and a nav button');
  for (const body of site.state.posts) {
    assert.match(body, /imgbtn(Next|Last|Current)Week\.x=/);
    // Form state is echoed back unchanged (exactly what the browser does), but only a week button is "clicked".
    const buttons = [...new URLSearchParams(body).keys()].filter((k) => /\.(x|y)$/.test(k) || /btn/i.test(k));
    assert.deepEqual(buttons.map((k) => k.replace(/\.[xy]$/, '')).filter((v, i, a) => a.indexOf(v) === i).length, 1);
    assert.doesNotMatch(body, /btnSave|btnReserve|btnSubmit|btnDelete|btnCancel/i);
  }
  assert.equal(st.session.state, 'ok');
  assert.ok(!('jar' in st) && !JSON.stringify(st).includes('session-123'), 'state never exposes cookies');
  assert.equal(st.user.credit, 1_200_000);
  assert.equal(site.state.offsets.get('u'), 0, 'the viewed week was restored to the current week');
});

test('auth: missing/garbage tokens are rejected', async () => {
  assert.equal((await J(null, 'GET', '/api/state')).status, 401);
  assert.equal((await J('x'.repeat(43), 'GET', '/api/state')).status, 401);
  assert.equal((await J(token + 'a', 'GET', '/api/state')).status, 401);
});

test('cors: only the app origin is allowed', async () => {
  const good = await fetch(`${base}/api/config`, { headers: { origin: 'http://localhost:5173' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const bad = await fetch(`${base}/api/config`, { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const pre = await fetch(`${base}/api/state`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
  assert.equal(pre.status, 204);
});

test('settings and push subscription validation', async () => {
  assert.equal((await J(token, 'PUT', '/api/settings', { leadMinutes: 60, meals: { lunch: { start: '12:30' } } })).status, 200);
  assert.equal((await J(token, 'PUT', '/api/settings', { leadMinutes: 9999 })).status, 400);
  const st = await (await J(token, 'GET', '/api/state')).json();
  assert.equal(st.settings.leadMinutes, 60);
  const evil = await J(token, 'PUT', '/api/push', { subscription: { endpoint: 'https://127.0.0.1/x', keys: { p256dh: 'a', auth: 'b' } } });
  assert.equal(evil.status, 400);
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const ok = await J(token, 'PUT', '/api/push', { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).subscriptions, 1);
});

test('refresh is rate limited', async () => {
  assert.equal((await J(token, 'POST', '/api/refresh')).status, 200);
  assert.equal((await J(token, 'POST', '/api/refresh')).status, 429);
});

test('site link opens the real site already logged in (shared session)', async () => {
  const r = await J(token, 'POST', '/api/site-link');
  const { url } = await r.json();
  assert.match(url, /\/p\/[\w-]{22}\/Reservation\/Reservation\.aspx$/);
  const page = await fetch(url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /cphMain_grdReservationLunch/);
  assert.match(html, /بازگشت به کالینون/);
});

test('expired university session is detected, never retried blindly, and re-login keeps the token', async () => {
  site.state.expired = true;
  store.get(store.all()[0].id).lastManualRefreshAt = 0;
  const r = await J(token, 'POST', '/api/refresh');
  assert.equal(r.status, 200);
  let st = await r.json();
  assert.equal(st.session.state, 'expired');
  assert.ok(st.snapshot, 'last good data stays visible');
  assert.equal((await J(token, 'POST', '/api/refresh')).status, 409);

  const s = await J(token, 'POST', '/api/session/start', { loginUrl: `http://127.0.0.1:${site.port}/Login.aspx` });
  const p2 = (await s.json()).proxyUrl;
  const sid2 = /\/p\/([\w-]{22})\//.exec(p2)[1];
  await fetch(p2);
  site.state.expired = false;
  const done = await fetch(`${base}/p/${sid2}/Login.aspx`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'user=demo&pwd=ok' });
  assert.equal(done.status, 302);
  const claim = await (await J(null, 'POST', '/api/session/claim', { code: done.headers.get('location').split('#claim=')[1] })).json();
  assert.equal(claim.token, null);
  assert.equal(claim.relogin, true);
  for (let i = 0; i < 40; i++) { st = await (await J(token, 'GET', '/api/state')).json(); if (st.session.state === 'ok') break; await sleep(100); }
  assert.equal(st.session.state, 'ok');
});

test('logout deletes everything', async () => {
  assert.equal((await J(token, 'DELETE', '/api/session')).status, 200);
  assert.equal((await J(token, 'GET', '/api/state')).status, 401);
  assert.equal(store.count(), 0);
});
