import fs from 'node:fs';
import path from 'node:path';
import { open, seal, sha256, randomToken } from './crypto.js';
import { Jar } from './upstream.js';

export const DEFAULT_SETTINGS = Object.freeze({
  notify: true,
  leadMinutes: 45,
  meals: {
    breakfast: { on: false, start: '07:00', end: '09:00' },
    lunch: { on: true, start: '12:00', end: '14:30' },
    dinner: { on: true, start: '18:00', end: '20:30' },
  },
});

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Strict validation: unknown keys are dropped, bad values rejected. */
export function sanitizeSettings(input, current = DEFAULT_SETTINGS) {
  const out = structuredClone(current);
  if (!input || typeof input !== 'object') return out;
  if (typeof input.notify === 'boolean') out.notify = input.notify;
  if (input.leadMinutes !== undefined) {
    const n = Number(input.leadMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 240) throw new Error('leadMinutes must be an integer 5..240');
    out.leadMinutes = n;
  }
  if (input.meals && typeof input.meals === 'object') {
    for (const k of ['breakfast', 'lunch', 'dinner']) {
      const m = input.meals[k];
      if (!m || typeof m !== 'object') continue;
      if (typeof m.on === 'boolean') out.meals[k].on = m.on;
      for (const f of ['start', 'end']) {
        if (m[f] === undefined) continue;
        if (!HHMM.test(m[f])) throw new Error(`meals.${k}.${f} must be HH:MM`);
        out.meals[k][f] = m[f];
      }
      if (out.meals[k].end <= out.meals[k].start) throw new Error(`meals.${k}: end must be after start`);
    }
  }
  return out;
}

export class Store {
  constructor(dir, key) {
    this.dir = dir;
    this.key = key;
    this.file = path.join(dir, 'store.bin');
    this.data = { v: 1, users: {} };
    this.byToken = new Map();
    this._timer = null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    this.data = open(fs.readFileSync(this.file), this.key); // throws if key is wrong / file tampered
    for (const u of Object.values(this.data.users)) this.byToken.set(u.tokenHash, u.id);
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 300);
    this._timer.unref?.();
  }

  flush() {
    clearTimeout(this._timer);
    for (const u of Object.values(this.data.users)) if (u._jar) u.jar = u._jar.toJSON();
    const json = JSON.parse(JSON.stringify(this.data, (k, v) => (k.startsWith('_') ? undefined : v)));
    const buf = seal(json, this.key);
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  all() { return Object.values(this.data.users); }
  count() { return this.all().length; }
  get(id) { return this.data.users[id] || null; }

  findByToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const id = this.byToken.get(sha256(token));
    return id ? this.get(id) : null;
  }

  jarOf(user) {
    if (!user._jar) user._jar = new Jar(user.jar || {});
    return user._jar;
  }

  /** Creates a user and returns { user, token }. The token is only ever returned once. */
  create({ origin, loginUrl, reservationUrl, jar }) {
    const token = randomToken(32);
    const id = randomToken(9);
    const user = {
      id,
      tokenHash: sha256(token),
      origin,
      loginUrl,
      reservationUrl,
      jar: jar.toJSON(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      push: [],
      settings: structuredClone(DEFAULT_SETTINGS),
      snapshot: null,
      lastRefreshAt: 0,
      lastManualRefreshAt: 0,
      lastError: null,
      sessionState: 'ok',
      expiredNotified: false,
      notified: {},
    };
    this.data.users[id] = user;
    this.byToken.set(user.tokenHash, id);
    this.save();
    return { user, token };
  }

  delete(id) {
    const u = this.get(id);
    if (!u) return;
    this.byToken.delete(u.tokenHash);
    delete this.data.users[id];
    this.save();
  }
}
