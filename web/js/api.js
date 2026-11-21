// Backend client + demo backend. The UI only talks to this module.
import { DEFAULT_SETTINGS } from './util.js';
import { buildDemoSnapshot } from './demo.js';

const K = { token: 'cullinon.token', cache: 'cullinon.cache', demo: 'cullinon.demo', demoSettings: 'cullinon.demo.settings', ui: 'cullinon.ui' };

export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
export const readJson = (k, d = null) => { try { return JSON.parse(ls.get(k)) ?? d; } catch { return d; } };
export const writeJson = (k, v) => ls.set(k, JSON.stringify(v));

export const prefs = {
  get: () => readJson(K.ui, { theme: 'auto', loginUrl: '' }),
  set: (p) => writeJson(K.ui, { ...prefs.get(), ...p }),
};

export function createApi(apiUrl) {
  const base = String(apiUrl || '').replace(/\/+$/, '');
  const demoCapable = !base;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const token = () => ls.get(K.token);
  const isDemo = () => ls.get(K.demo) === '1';

  async function call(method, path, body, { auth = true } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && token()) headers.authorization = `Bearer ${token()}`;
    let res;
    try {
      res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit' });
    } catch {
      throw new ApiError(0, 'network');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new ApiError(res.status, data?.error || 'error');
    return data;
  }

  /* ---------------- demo backend ---------------- */
  const demo = {
    settings: () => ({ ...structuredClone(DEFAULT_SETTINGS), ...readJson(K.demoSettings, {}) }),
    state() {
      const settings = demo.settings();
      const snap = buildDemoSnapshot(Date.now(), settings);
      const last = readJson('cullinon.demo.last', Date.now() - 4 * 60000);
      return {
        user: snap.user, snapshot: snap, settings,
        session: { state: 'ok', lastRefreshAt: last, lastError: null, warnings: [] },
        push: { subscriptions: 0, serverEnabled: false }, siteOrigin: 'https://example.ac.ir', refreshMinutes: 20, serverTime: Date.now(), demo: true,
      };
    },
  };

  return {
    demoCapable,
    get isDemo() { return isDemo(); },
    get hasSession() { return isDemo() || !!token(); },

    config: () => (isDemo() ? Promise.resolve({ vapidPublicKey: null }) : call('GET', '/api/config', undefined, { auth: false })),

    startDemo() { ls.set(K.demo, '1'); },
    async start(loginUrl, reservationUrl) {
      const body = { loginUrl };
      if (reservationUrl) body.reservationUrl = reservationUrl;
      return call('POST', '/api/session/start', body, { auth: !!token() });
    },
    async claim(code) {
      const r = await call('POST', '/api/session/claim', { code }, { auth: false });
      if (r.token) ls.set(K.token, r.token);
      return r;
    },

    async state() {
      if (isDemo()) { await sleep(150); return demo.state(); }
      const s = await call('GET', '/api/state');
      writeJson(K.cache, s);
      return s;
    },
    cached: () => (isDemo() ? null : readJson(K.cache)),
    async refresh() {
      if (isDemo()) { await sleep(700); writeJson('cullinon.demo.last', Date.now()); return demo.state(); }
      const s = await call('POST', '/api/refresh');
      writeJson(K.cache, s);
      return s;
    },
    async saveSettings(settings) {
      if (isDemo()) { writeJson(K.demoSettings, settings); return { settings }; }
      return call('PUT', '/api/settings', settings);
    },
    pushSubscribe: (subscription) => (isDemo() ? Promise.resolve({ subscriptions: 1 }) : call('PUT', '/api/push', { subscription })),
    pushUnsubscribe: (endpoint) => (isDemo() ? Promise.resolve({}) : call('DELETE', '/api/push', { endpoint })),
    pushTest: () => (isDemo() ? Promise.resolve({ delivered: 0, local: true }) : call('POST', '/api/push/test')),
    siteLink: () => (isDemo() ? Promise.resolve({ url: null }) : call('POST', '/api/site-link')),

    async logout() {
      if (!isDemo() && token()) { try { await call('DELETE', '/api/session'); } catch { /* still wipe locally */ } }
      for (const k of Object.values(K)) if (k !== K.ui) ls.del(k);
      ls.del('cullinon.demo.last');
    },
  };
}
