import crypto from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => Buffer.from(String(s), 'base64url');

/** Accepts 32 bytes as hex (64 chars) or base64/base64url. */
export function parseMasterKey(str) {
  if (!str) throw new Error('MASTER_KEY is required');
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(str)) buf = Buffer.from(str, 'hex');
  else buf = Buffer.from(str, 'base64');
  if (buf.length !== 32) throw new Error('MASTER_KEY must decode to exactly 32 bytes');
  return buf;
}

/** AES-256-GCM. Layout: [1 byte version][12 byte iv][16 byte tag][ciphertext] */
export function seal(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
}

export function open(buf, key) {
  if (buf[0] !== 1) throw new Error('Unsupported store version');
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  const pt = Buffer.concat([d.update(buf.subarray(29)), d.final()]);
  return JSON.parse(pt.toString('utf8'));
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const publicRaw = Buffer.concat([Buffer.from([4]), fromB64u(pub.x), fromB64u(pub.y)]);
  return { publicKey: b64u(publicRaw), privateKey: priv.d };
}
