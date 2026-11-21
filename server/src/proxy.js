import { randomToken } from './crypto.js';
import { Jar, httpError } from './upstream.js';
import { isReservationPage } from './parser.js';

const SID_RE = /^\/p\/([A-Za-z0-9_-]{22})(\/.*)?$/;
const UA_FALLBACK = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const LOGIN_TTL = 15 * 60_000;
const SITE_TTL = 30 * 60_000;
const CLAIM_TTL = 2 * 60_000;

/* ------------------------------------------------------------------ rewriting */

export function rewriteUrl(u, prefix, origin) {
  const t = u.trim();
  const host = new URL(origin).host;
  if (t === origin) return `${prefix}/`;
  if (t.startsWith(`${origin}/`)) return prefix + t.slice(origin.length);
  if (t.startsWith(`//${host}/`)) return prefix + t.slice(2 + host.length);
  if (t.startsWith('/') && !t.startsWith('//')) return prefix + t;
  return u;
}

export function rewriteCss(css, prefix, origin) {
  return css.replace(/url\(\s*(['"]?)(\/(?!\/)[^'")\s]*|https?:\/\/[^'")\s]+)\1\s*\)/gi, (m, q, u) => {
    const out = rewriteUrl(u, prefix, origin);
    return out === u ? m : `url(${q}${out}${q})`;
  });
}

export function rewriteHtml(html, prefix, origin) {
  let out = html.replace(
    /(\s(?:href|src|action|poster|background|data-src)\s*=\s*)(["'])([^"']*)\2/gi,
    (m, a, q, u) => `${a}${q}${rewriteUrl(u, prefix, origin)}${q}`
  );
  out = out.replace(
    /(<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*content\s*=\s*["'][^"']*url\s*=\s*)([^"'>\s]+)/gi,
    (m, a, u) => a + rewriteUrl(u, prefix, origin)
  );
  return rewriteCss(out, prefix, origin);
}

function rewriteAjaxDelta(body, prefix, origin) {
  // MS Ajax partial postbacks can redirect with "…|pageRedirect||<urlencoded>|…"
  return body.replace(/(\|pageRedirect\|\|)([^|]*)(\|)/g, (m, a, enc, z) => {
    try {
      const url = decodeURIComponent(enc);
      return a + encodeURIComponent(rewriteUrl(url, prefix, origin)) + z;
    } catch { return m; }
  });
}

const BANNER = {
  login: (appUrl) =>
    `<div dir="rtl" style="position:fixed;inset:0 0 auto 0;z-index:2147483647;display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 12px;background:#FF7A00;color:#fff;font:600 13px/1.5 system-ui,Tahoma,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25)"><span>🔒 ورود امن به کالینان از طریق «کالینون» — رمز عبور شما ذخیره نمی‌شود.</span><a href="${appUrl}" style="color:#fff;text-decoration:underline;white-space:nowrap">انصراف</a></div><div style="height:40px"></div>`,
  site: (appUrl) =>
    `<a href="${appUrl}" dir="rtl" style="position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:10px 16px;border-radius:999px;background:#FF7A00;color:#fff;font:700 14px system-ui,Tahoma,sans-serif;text-decoration:none;box-shadow:0 6px 18px rgba(0,0,0,.3)">← بازگشت به کالینون</a>`,
};

/* ---------------------------------------------------------------------- proxy */

export function createProxy({ cfg, store, upstream, onLogin }) {
  const sessions = new Map(); // sid → session
  const claims = new Map(); // code → { userId, token, exp }
  const securePart = cfg.secureCookies ? '; Secure' : '';

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k);
    for (const [k, c] of claims) if (c.exp < now) claims.delete(k);
  }, 60_000);
  sweep.unref?.();

  /* --- creating sessions --- */

  function startLogin({ loginUrl, reservationUrl, user, ip }) {
    const u = upstream.check(loginUrl);
    let resUrl = null;
    if (reservationUrl) {
      const r = upstream.check(reservationUrl);
      if (r.origin !== u.origin) throw httpError(400, 'Reservation page must be on the same site as the login page');
      resUrl = r.href;
    }
    let pending = 0, mine = 0;
    for (const s of sessions.values()) if (s.kind === 'login') { pending++; if (s.ip === ip) mine++; }
    if (pending >= 100 || mine >= 5) throw httpError(429, 'Too many pending logins, try again in a few minutes');

    const sid = randomToken(16);
    sessions.set(sid, {
      sid, kind: 'login', origin: u.origin, loginUrl: u.href, reservationUrl: resUrl,
      jar: new Jar(), userId: user?.id || null, ip, lastProbe: 0, expires: Date.now() + LOGIN_TTL,
    });
    return `${cfg.publicUrl}/p/${sid}${u.pathname}${u.search}`;
  }

  function startSite(user) {
    const sid = randomToken(16);
    const resUrl = new URL(user.reservationUrl);
    sessions.set(sid, {
      sid, kind: 'site', origin: user.origin, jar: store.jarOf(user), userId: user.id,
      expires: Date.now() + SITE_TTL,
    });
    return `${cfg.publicUrl}/p/${sid}${resUrl.pathname}`;
  }

  function claim(code) {
    const c = claims.get(String(code));
    if (!c || c.exp < Date.now()) return null;
    claims.delete(String(code)); // single use
    return c;
  }

  /* --- login detection --- */

  function candidateUrls(s) {
    if (s.reservationUrl) return [s.reservationUrl];
    const lp = new URL(s.loginUrl).pathname;
    let dir = lp.slice(0, lp.lastIndexOf('/') + 1) || '/';
    const dirs = [dir];
    while (dir !== '/') {
      dir = dir.slice(0, dir.slice(0, -1).lastIndexOf('/') + 1) || '/';
      dirs.push(dir);
    }
    const rp = cfg.reservationPath.replace(/^\/+/, '');
    return dirs.map((d) => s.origin + d + rp);
  }

  async function probe(s) {
    const now = Date.now();
    if (now - s.lastProbe < 1500 || !s.jar.size) return null;
    s.lastProbe = now;
    for (const url of candidateUrls(s)) {
      try {
        const r = await upstream.request(url, {
          headers: { 'user-agent': UA_FALLBACK, accept: 'text/html', 'accept-language': 'fa-IR,fa;q=0.9' },
          jar: s.jar, maxBytes: 4_000_000, timeoutMs: 15_000,
        });
        if (r.status === 200 && isReservationPage(r.body.toString('utf8'))) return url;
      } catch { /* try next candidate */ }
    }
    return null;
  }

  /* --- request handling --- */

  const cookieOf = (req, name) => {
    const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
    return m ? m[1] : null;
  };

  const baseHeaders = (extra = {}) => ({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin', // severs window.opener for the tab opened from the app
    'x-robots-tag': 'noindex',
    ...extra,
  });

  function gonePage(res) {
    const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body dir="rtl" style="font:16px system-ui,Tahoma;padding:32px;text-align:center"><h2>این لینک منقضی شده است</h2><p>به برنامه برگردید و دوباره شروع کنید.</p><p><a href="${cfg.appUrl}">بازگشت به کالینون</a></p>`;
    res.writeHead(410, baseHeaders({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }));
    res.end(body);
  }

  async function readBody(req, max = 1_000_000) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) throw httpError(413, 'Request too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  function mapLocation(loc, fromUrl, prefix, origin) {
    let u;
    try { u = new URL(loc, fromUrl); } catch { return '/'; }
    if (u.origin === origin) return `${prefix}${u.pathname}${u.search}`;
    return /^https?:$/.test(u.protocol) ? u.href : '/'; // external hops (e.g. a payment gateway) leave the proxy
  }

  async function handle(req, res) {
    const raw = req.url || '/';
    const qi = raw.indexOf('?');
    const rawPath = qi < 0 ? raw : raw.slice(0, qi);
    const search = qi < 0 ? '' : raw.slice(qi);

    let sid, upPath;
    const m = SID_RE.exec(rawPath);
    if (m) { sid = m[1]; upPath = m[2] || '/'; }
    else { // e.g. "../x" climbing above the page's directory resolved to /p/x — recover the session from the cookie
      sid = cookieOf(req, 'pxs');
      upPath = rawPath.slice(2);
    }
    const sess = sid && sessions.get(sid);
    if (!sess || sess.expires < Date.now()) return gonePage(res);
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) { res.writeHead(405); return res.end(); }
    if (!upPath.startsWith('/')) upPath = `/${upPath}`;

    const prefix = `/p/${sess.sid}`;
    const upstreamUrl = sess.origin + upPath + search;
    const isDelta = /delta=true/i.test(req.headers['x-microsoftajax'] || '');

    const headers = {
      'user-agent': req.headers['user-agent'] || UA_FALLBACK,
      accept: req.headers.accept || '*/*',
      'accept-language': req.headers['accept-language'] || 'fa-IR,fa;q=0.9',
      referer: sess.origin + '/',
    };
    if (req.headers['x-requested-with']) headers['x-requested-with'] = req.headers['x-requested-with'];
    if (req.headers['x-microsoftajax']) headers['x-microsoftajax'] = req.headers['x-microsoftajax'];

    let body;
    if (req.method === 'POST') {
      body = await readBody(req);
      headers['content-type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
      headers.origin = sess.origin;
    }

    const r = await upstream.request(upstreamUrl, {
      method: req.method === 'HEAD' ? 'GET' : req.method,
      headers, body, jar: sess.jar, maxBytes: 15_000_000,
    });
    if (sess.kind === 'site') store.save(); // cookies may have rotated

    // Did the login just succeed? Check on every POST / redirect, then hand over to the app.
    if (sess.kind === 'login' && (req.method === 'POST' || (r.status >= 300 && r.status < 400))) {
      const found = await probe(sess);
      if (found) {
        const out = await onLogin({ sess, reservationUrl: found });
        sessions.delete(sess.sid);
        const code = randomToken(24);
        claims.set(code, { ...out, exp: Date.now() + CLAIM_TTL });
        const target = `${cfg.appUrl}#claim=${code}`;
        if (isDelta) {
          const enc = encodeURIComponent(target);
          res.writeHead(200, baseHeaders({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }));
          return res.end(`1|#||4|${enc.length}|pageRedirect||${enc}|`);
        }
        res.writeHead(302, baseHeaders({ location: target, 'cache-control': 'no-store' }));
        return res.end();
      }
    }

    const out = baseHeaders({
      'set-cookie': `pxs=${sess.sid}; Path=/p; HttpOnly; SameSite=Lax; Max-Age=1800${securePart}`,
    });
    if (r.headers['content-disposition']) out['content-disposition'] = r.headers['content-disposition'];

    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      out.location = mapLocation(r.headers.location, upstreamUrl, prefix, sess.origin);
      out['cache-control'] = 'no-store';
      res.writeHead(r.status, out);
      return res.end();
    }

    const ct = String(r.headers['content-type'] || 'application/octet-stream');
    const lower = ct.toLowerCase();
    let payload = r.body;
    let contentType = ct;

    if (lower.includes('text/html')) {
      const charset = /charset=([\w-]+)/i.exec(ct)?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(r.body.subarray(0, 2048).toString('latin1'))?.[1] || 'utf-8';
      let html;
      try { html = new TextDecoder(charset).decode(r.body); } catch { html = r.body.toString('utf8'); }
      html = rewriteHtml(html, prefix, sess.origin);
      if (!isDelta && /<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${BANNER[sess.kind](cfg.appUrl)}</body>`);
      }
      payload = Buffer.from(html, 'utf8');
      contentType = 'text/html; charset=utf-8';
      out['cache-control'] = 'no-store';
    } else if (lower.includes('text/css')) {
      payload = Buffer.from(rewriteCss(r.body.toString('utf8'), prefix, sess.origin), 'utf8');
      contentType = 'text/css; charset=utf-8';
      out['cache-control'] = 'private, max-age=600';
    } else if (isDelta && lower.startsWith('text/')) {
      payload = Buffer.from(rewriteAjaxDelta(r.body.toString('utf8'), prefix, sess.origin), 'utf8');
      out['cache-control'] = 'no-store';
    } else {
      out['cache-control'] = lower.startsWith('image/') || lower.includes('javascript') || lower.includes('font')
        ? 'private, max-age=600' : 'no-store';
    }

    out['content-type'] = contentType;
    out['content-length'] = payload.length;
    res.writeHead(r.status, out);
    res.end(req.method === 'HEAD' ? undefined : payload);
  }

  return { handle, startLogin, startSite, claim, _sessions: sessions };
}
