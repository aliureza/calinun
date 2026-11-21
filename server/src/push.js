import crypto from 'node:crypto';
import { b64u, fromB64u } from './crypto.js';
import { isPushHost } from './upstream.js';

/* ---------------------------------------------------------------- VAPID (RFC 8292) */

function vapidPrivateKey(cfg) {
  const pub = fromB64u(cfg.vapid.publicKey); // 0x04 || X || Y
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: cfg.vapid.privateKey },
    format: 'jwk',
  });
}

const jwtCache = new Map();
function vapidJwt(cfg, audience) {
  const hit = jwtCache.get(audience);
  if (hit && hit.exp - Date.now() > 3_600_000) return hit.jwt;
  const exp = Date.now() + 12 * 3_600_000;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: audience, exp: Math.floor(exp / 1000), sub: cfg.vapid.subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), {
    key: vapidPrivateKey(cfg),
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${head}.${body}.${b64u(sig)}`;
  jwtCache.set(audience, { jwt, exp });
  return jwt;
}

/* ------------------------------------------------------ payload encryption (RFC 8291) */

export function encryptPayload(subscription, payload) {
  const uaPublic = fromB64u(subscription.keys.p256dh);
  const authSecret = fromB64u(subscription.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Bad subscription keys');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));

  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const plain = Buffer.concat([Buffer.from(JSON.stringify(payload), 'utf8'), Buffer.from([0x02])]);
  if (plain.length > 3800) throw new Error('Payload too large');
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

/** Reverse of encryptPayload — used by tests to prove the wire format round-trips. */
export function decryptPayload(body, uaPrivateEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idLen = body[20];
  const asPublic = body.subarray(21, 21 + idLen);
  const ct = body.subarray(21 + idLen);
  const uaPublic = uaPrivateEcdh.getPublicKey();
  const shared = uaPrivateEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(0x02)).toString('utf8'));
}

/* ----------------------------------------------------------------------- sending */

export function validSubscription(sub) {
  try {
    if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 1000) return false;
    const u = new URL(sub.endpoint);
    if (u.protocol !== 'https:' || !isPushHost(u.hostname.toLowerCase())) return false;
    return fromB64u(sub.keys?.p256dh).length === 65 && fromB64u(sub.keys?.auth).length === 16;
  } catch { return false; }
}

export function createPusher({ cfg, upstream }) {
  const enabled = !!(cfg.vapid.publicKey && cfg.vapid.privateKey);

  /** @returns {'ok'|'gone'|'error'} */
  async function send(subscription, payload) {
    if (!enabled) return 'error';
    if (!validSubscription(subscription)) return 'gone';
    const u = new URL(subscription.endpoint);
    try {
      const body = encryptPayload(subscription, payload);
      const r = await upstream.request(subscription.endpoint, {
        method: 'POST',
        body,
        allow: isPushHost,
        ports: [443],
        timeoutMs: 15_000,
        maxBytes: 100_000,
        headers: {
          authorization: `vapid t=${vapidJwt(cfg, u.origin)}, k=${cfg.vapid.publicKey}`,
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: '3600',
          urgency: 'high',
        },
      });
      if (r.status >= 200 && r.status < 300) return 'ok';
      if (r.status === 404 || r.status === 410) return 'gone';
      return 'error';
    } catch {
      return 'error';
    }
  }

  /** Sends to every subscription of a user and prunes dead ones. Returns number delivered. */
  async function sendToUser(user, payload, onChange) {
    let delivered = 0;
    for (const sub of [...user.push]) {
      const res = await send(sub, payload);
      if (res === 'ok') delivered++;
      if (res === 'gone') {
        user.push = user.push.filter((s) => s.endpoint !== sub.endpoint);
        onChange?.();
      }
    }
    return delivered;
  }

  return { enabled, send, sendToUser };
}
