import http from 'node:http';
import { createProxy } from './proxy.js';
import { sanitizeSettings } from './store.js';
import { validSubscription } from './push.js';
import { httpError } from './upstream.js';
import { SessionExpiredError } from './collector.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

/** Tiny fixed-window rate limiter (in memory — fine for a single small instance). */
function createLimiter() {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60_000).unref?.();
  return (key, max, windowMs) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    h.n++;
    return h.n <= max;
  };
}

export function createApp({ cfg, store, upstream, pusher, scheduler }) {
  const limit = createLimiter();

  async function onLogin({ sess, reservationUrl }) {
    if (sess.userId) {
      const u = store.get(sess.userId);
      if (u) { // re-login of an existing account: the app already holds its token
        u._jar = sess.jar;
        u.reservationUrl = reservationUrl;
        u.sessionState = 'ok';
        u.expiredNotified = false;
        u.lastError = null;
        store.save();
        scheduler.refreshUser(u);
        return { userId: u.id, token: null };
      }
    }
    const { user, token } = store.create({
      origin: sess.origin, loginUrl: sess.loginUrl, reservationUrl, jar: sess.jar,
    });
    user._jar = sess.jar;
    scheduler.refreshUser(user); // fire and forget; the app polls /api/state
    return { userId: user.id, token };
  }

  const proxy = createProxy({ cfg, store, upstream, onLogin });

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && origin === cfg.appOrigin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
  }

  function send(res, status, obj) {
    res.writeHead(status, JSON_HEADERS);
    res.end(JSON.stringify(obj));
  }

  async function readJson(req, max = 16_384) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) throw httpError(413, 'Body too large');
      chunks.push(c);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'Invalid JSON'); }
  }

  function auth(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const user = m ? store.findByToken(m[1]) : null;
    if (!user) throw httpError(401, 'unauthorized');
    if (Date.now() - user.lastSeenAt > 10 * 60_000) { user.lastSeenAt = Date.now(); store.save(); }
    return user;
  }

  const publicState = (u) => ({
    user: u.snapshot?.user ?? null,
    snapshot: u.snapshot,
    settings: u.settings,
    session: { state: u.sessionState, lastRefreshAt: u.lastRefreshAt, lastError: u.lastError, warnings: u.warnings || [] },
    push: { subscriptions: u.push.length, serverEnabled: pusher.enabled },
    siteOrigin: u.origin,
    refreshMinutes: cfg.refreshMinutes,
    serverTime: Date.now(),
  });

  async function route(req, res, url) {
    const ip = clientIp(req);
    const { pathname } = url;
    const m = req.method;

    if (pathname === '/healthz') return send(res, 200, { ok: true });

    if (pathname === '/api/config' && m === 'GET') {
      return send(res, 200, { vapidPublicKey: pusher.enabled ? cfg.vapid.publicKey : null, refreshMinutes: cfg.refreshMinutes });
    }

    if (pathname === '/api/session/start' && m === 'POST') {
      if (!limit(`start:${ip}`, 10, 10 * 60_000)) throw httpError(429, 'rate_limited');
      const body = await readJson(req);
      let user = null;
      if (req.headers.authorization) user = auth(req); // re-login
      else if (store.count() >= cfg.maxUsers) throw httpError(403, 'capacity_reached');
      if (typeof body.loginUrl !== 'string' || body.loginUrl.length > 500) throw httpError(400, 'loginUrl is required');
      const proxyUrl = proxy.startLogin({
        loginUrl: body.loginUrl.trim(),
        reservationUrl: typeof body.reservationUrl === 'string' && body.reservationUrl.trim() ? body.reservationUrl.trim() : null,
        user, ip,
      });
      return send(res, 200, { proxyUrl });
    }

    if (pathname === '/api/session/claim' && m === 'POST') {
      if (!limit(`claim:${ip}`, 20, 10 * 60_000)) throw httpError(429, 'rate_limited');
      const body = await readJson(req);
      const c = proxy.claim(body.code);
      if (!c) throw httpError(404, 'invalid_or_expired_code');
      return send(res, 200, { token: c.token, relogin: !c.token });
    }

    // ---- everything below needs a token
    if (pathname.startsWith('/api/')) {
      const user = auth(req);
      if (!limit(`api:${user.id}`, 120, 60_000)) throw httpError(429, 'rate_limited');

      if (pathname === '/api/state' && m === 'GET') return send(res, 200, publicState(user));

      if (pathname === '/api/refresh' && m === 'POST') {
        if (user.sessionState === 'expired') throw httpError(409, 'session_expired');
        if (Date.now() - user.lastManualRefreshAt < 20_000) throw httpError(429, 'too_soon');
        user.lastManualRefreshAt = Date.now();
        await scheduler.refreshUser(user);
        return send(res, 200, publicState(user));
      }

      if (pathname === '/api/settings' && m === 'PUT') {
        const body = await readJson(req);
        try { user.settings = sanitizeSettings(body, user.settings); } catch (e) { throw httpError(400, e.message); }
        store.save();
        return send(res, 200, { settings: user.settings });
      }

      if (pathname === '/api/push' && m === 'PUT') {
        const { subscription } = await readJson(req);
        if (!validSubscription(subscription)) throw httpError(400, 'invalid_subscription');
        const sub = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
        user.push = [...user.push.filter((s) => s.endpoint !== sub.endpoint), sub].slice(-5);
        store.save();
        return send(res, 200, { subscriptions: user.push.length });
      }

      if (pathname === '/api/push' && m === 'DELETE') {
        const { endpoint } = await readJson(req);
        user.push = user.push.filter((s) => s.endpoint !== endpoint);
        store.save();
        return send(res, 200, { subscriptions: user.push.length });
      }

      if (pathname === '/api/push/test' && m === 'POST') {
        if (!limit(`ptest:${user.id}`, 3, 60_000)) throw httpError(429, 'rate_limited');
        const first = (user.snapshot?.user?.name || '').trim().split(/\s+/)[0] || 'دوست من';
        const delivered = await pusher.sendToUser(
          user,
          { type: 'test', title: `${first} جان، یادآوری‌ها فعال است ✅`, body: 'از این پس پیش از هر وعده، همین‌جا خبرت می‌کنم.', tag: 'test', url: './' },
          () => store.save()
        );
        return send(res, 200, { delivered });
      }

      if (pathname === '/api/site-link' && m === 'POST') {
        return send(res, 200, { url: proxy.startSite(user) });
      }

      if (pathname === '/api/session' && m === 'DELETE') {
        store.delete(user.id);
        return send(res, 200, { deleted: true });
      }
    }

    throw httpError(404, 'not_found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/p/') || url.pathname === '/p') {
        if (!limit(`proxy:${clientIp(req)}`, 900, 60_000)) { res.writeHead(429); return res.end('Too many requests'); }
        return await proxy.handle(req, res);
      }
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      return await route(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e.status || (e instanceof SessionExpiredError ? 409 : 500);
      if (status >= 500) console.error('[http]', req.method, req.url?.split('?')[0], e.message);
      // never leak internals; the codes are stable identifiers for the client
      send(res, status, { error: status >= 500 ? 'server_error' : e.message });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;

  return { server, proxy };
}
