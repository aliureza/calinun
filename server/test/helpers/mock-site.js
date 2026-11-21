// A tiny fake of the university site: login form + captcha + ASP.NET-style week navigation.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURE = fs.readFileSync(fileURLToPath(new URL('../fixtures/reservation-week0.html', import.meta.url)), 'utf8');
const WEEK0 = ['1405/08/30', '1405/09/01', '1405/09/02', '1405/09/03', '1405/09/04', '1405/09/05', '1405/09/06'];
const dim = (m) => (m <= 6 ? 31 : m <= 11 ? 30 : 29);

function addDays([y, m, d], n) {
  while (n > 0) { d++; if (d > dim(m)) { d = 1; m++; if (m > 12) { m = 1; y++; } } n--; }
  while (n < 0) { d--; if (d < 1) { m--; if (m < 1) { m = 12; y--; } d = dim(m); } n++; }
  return [y, m, d];
}
const fmt = ([y, m, d]) => `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;

export function weekHtml(offset) {
  if (offset === 0) return FIXTURE;
  const start = [1405, 8, 30];
  let html = FIXTURE;
  WEEK0.forEach((_, i) => { html = html.replaceAll(WEEK0[i], `@@${i}@@`); });
  WEEK0.forEach((_, i) => { html = html.replaceAll(`@@${i}@@`, fmt(addDays(start, offset * 7 + i + (i > 0 ? 1 : 0) - (i > 0 ? 1 : 0)))); });
  return html;
}

export function startMockSite() {
  const state = { expired: false, posts: [], badPosts: 0, offsets: new Map(), logins: 0, requests: [] };
  const AUTH = 'AUTH=session-123';

  const server = http.createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`);
    const authed = !state.expired && (req.headers.cookie || '').includes(AUTH);
    const url = new URL(req.url, 'http://x');
    const html = (body, status = 200, extra = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extra });
      res.end(body);
    };
    const redirect = (to, extra = {}) => { res.writeHead(302, { location: to, ...extra }); res.end(); };

    if (url.pathname === '/Login.aspx') {
      if (req.method === 'POST') {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => {
          const p = new URLSearchParams(b);
          if (p.get('user') === 'demo' && p.get('pwd') === 'ok') {
            state.logins++;
            state.expired = false;
            return redirect('/Profile/Profile.aspx', { 'set-cookie': [`${AUTH}; path=/; HttpOnly`, 'ASP.NET_SessionId=zzz; path=/; HttpOnly'] });
          }
          return html('<html><body><form method="post" action="./Login.aspx"><input name="user"><input type="password" name="pwd"><span>wrong</span></form></body></html>');
        });
        return;
      }
      return html(`<html><head><link rel="stylesheet" href="/Styles/a.css"><style>.x{background:url(/img/bg.png)}</style></head><body>
        <img src="/Captcha.ashx?id=1"><form method="post" action="./Login.aspx"><input name="user"><input type="password" name="pwd"></form></body></html>`,
      200, { 'set-cookie': 'ASP.NET_SessionId=pre; path=/; HttpOnly' });
    }
    if (url.pathname === '/Captcha.ashx') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])); }
    if (url.pathname === '/Styles/a.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('body{background:url(/img/x.png)}'); }

    if (url.pathname === '/Profile/Profile.aspx') return authed ? html('<html><body>profile</body></html>') : redirect('/Login.aspx');

    if (url.pathname === '/Reservation/Reservation.aspx') {
      if (!authed) return redirect('/Login.aspx');
      const key = 'u';
      if (req.method === 'POST') {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => {
          const p = new URLSearchParams(b);
          state.posts.push(b);
          if (p.get('__VIEWSTATE') !== 'FAKE+VIEWSTATE/abc==') { state.badPosts++; return html('bad viewstate', 500); }
          if (req.headers.origin !== `http://${req.headers.host}`) state.badPosts++;
          let off = state.offsets.get(key) || 0;
          if (p.has('ctl00$cphMain$imgbtnNextWeek.x')) off++;
          else if (p.has('ctl00$cphMain$imgbtnLastWeek.x')) off--;
          else if (p.has('ctl00$cphMain$imgbtnCurrentWeek.x')) off = 0;
          else state.badPosts++;
          state.offsets.set(key, off);
          html(weekHtml(off));
        });
        return;
      }
      return html(weekHtml(state.offsets.get(key) || 0));
    }
    res.writeHead(404); res.end('nope');
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port, close: () => server.close() })));
}
