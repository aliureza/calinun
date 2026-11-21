import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { hostMatches } from './config.js';

/* ------------------------------------------------------------------ cookies */

/** Minimal single-host cookie jar (name → value). Honors deletion via Max-Age / Expires. */
export class Jar {
  constructor(obj = {}) { this.c = new Map(Object.entries(obj)); }
  get size() { return this.c.size; }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; '); }
  toJSON() { return Object.fromEntries(this.c); }
  clone() { return new Jar(this.toJSON()); }
  update(setCookies = []) {
    for (const sc of setCookies) {
      const [pair, ...attrs] = String(sc).split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const name = pair.slice(0, i).trim();
      const val = pair.slice(i + 1).trim();
      let del = val === '';
      for (const a of attrs) {
        const [k, ...r] = a.split('=');
        const key = k.trim().toLowerCase();
        const v = r.join('=').trim();
        if (key === 'max-age' && Number(v) <= 0) del = true;
        if (key === 'expires') {
          const t = Date.parse(v);
          if (!Number.isNaN(t) && t < Date.now()) del = true;
        }
      }
      if (del) this.c.delete(name); else this.c.set(name, val);
    }
  }
}

/* --------------------------------------------------------------------- SSRF */

function isPrivate4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivate4(ip);
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const dotted = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivate4(dotted[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivate4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(l.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
  }
  return true;
}

/** Hosts that may receive Web Push messages (user-supplied subscription endpoints!). */
export const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com',
];
export const isPushHost = (h) =>
  PUSH_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));

/* ------------------------------------------------------------------- client */

export function createUpstream(cfg) {
  // DNS-level guard: the address that is actually connected to is what gets checked,
  // which also defeats DNS-rebinding between "check" and "connect".
  const lookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!cfg.allowPrivateUpstream) {
        for (const a of addrs) {
          if (isPrivateAddress(a.address)) {
            return cb(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
          }
        }
      }
      if (options.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  };

  function assertAllowed(u, allow, ports) {
    const okProto = u.protocol === 'https:' || (u.protocol === 'http:' && (cfg.allowHttpUpstream || cfg.allowPrivateUpstream));
    if (!okProto) throw httpError(400, 'Only https upstreams are allowed');
    if (u.username || u.password) throw httpError(400, 'Credentials in URL are not allowed');
    const host = u.hostname.toLowerCase();
    if (!allow(host)) throw httpError(403, 'Host is not allowed');
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!ports.includes(port)) throw httpError(403, 'Port is not allowed');
    if (net.isIP(host) && !cfg.allowPrivateUpstream && isPrivateAddress(host)) {
      throw httpError(403, 'Blocked address');
    }
  }

  const defaultAllow = (h) => hostMatches(h, cfg.allowedHosts);

  /** @returns {Promise<{status:number, headers:Record<string,any>, body:Buffer}>} */
  function request(urlStr, opts = {}) {
    const {
      method = 'GET', headers = {}, body, jar, maxBytes = 8_000_000, timeoutMs = 20_000,
      allow = defaultAllow, ports = cfg.allowedPorts,
    } = opts;
    let u;
    try { u = new URL(urlStr); } catch { return Promise.reject(httpError(400, 'Bad URL')); }
    try { assertAllowed(u, allow, ports); } catch (e) { return Promise.reject(e); }

    const lib = u.protocol === 'https:' ? https : http;
    const h = { 'accept-encoding': 'identity', connection: 'close', ...headers };
    if (jar?.size) h.cookie = jar.header();
    if (body) h['content-length'] = Buffer.byteLength(body);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('Upstream timeout'), { status: 504 })), timeoutMs);
      const req = lib.request(
        {
          method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
          headers: h, lookup, agent: false,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) return req.destroy(Object.assign(new Error('Upstream response too large'), { status: 502 }));
            chunks.push(c);
          });
          res.on('end', () => {
            clearTimeout(timer);
            jar?.update(res.headers['set-cookie']);
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
          });
          res.on('error', (e) => { clearTimeout(timer); reject(e); });
        }
      );
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      if (body) req.write(body);
      req.end();
    });
  }

  /** Throws an httpError if the URL could never be fetched (used to validate user-supplied URLs up-front). */
  function check(urlStr, { allow = defaultAllow, ports = cfg.allowedPorts } = {}) {
    let u;
    try { u = new URL(urlStr); } catch { throw httpError(400, 'Bad URL'); }
    assertAllowed(u, allow, ports);
    return u;
  }

  return { request, check, defaultAllow };
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
