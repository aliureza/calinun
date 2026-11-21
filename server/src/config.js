import { parseMasterKey } from './crypto.js';

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v));
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export function createConfig(env = process.env) {
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const appUrl = env.APP_URL || '';
  if (!publicUrl) throw new Error('PUBLIC_URL is required (the public https URL of this server)');
  if (!appUrl) throw new Error('APP_URL is required (the URL of the PWA, e.g. https://user.github.io/cullinon/)');

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(publicUrl);
  if (!isLocal && !publicUrl.startsWith('https://')) {
    throw new Error('PUBLIC_URL must be https:// (session cookies and tokens must never travel over plain HTTP)');
  }

  const appOrigin = (env.APP_ORIGIN || new URL(appUrl).origin).replace(/\/+$/, '');
  if (new URL(publicUrl).origin === appOrigin) {
    throw new Error(
      'APP_URL and PUBLIC_URL must be on different origins. The login proxy runs the university site\'s scripts; ' +
        'keeping it on a separate origin stops those scripts from touching the app\'s storage.'
    );
  }

  const allowedHosts = list(env.ALLOWED_HOSTS);
  if (!allowedHosts.length) {
    throw new Error('ALLOWED_HOSTS is required (comma separated, e.g. food.example.ac.ir,*.example.ac.ir)');
  }

  return Object.freeze({
    port: int(env.PORT, 8787),
    host: env.HOST || '0.0.0.0',
    publicUrl,
    appUrl,
    appOrigin,
    isLocal,
    secureCookies: publicUrl.startsWith('https://'),
    trustProxy: bool(env.TRUST_PROXY, false),
    dataDir: env.DATA_DIR || './data',
    masterKey: parseMasterKey(env.MASTER_KEY),
    allowedHosts,
    allowHttpUpstream: bool(env.ALLOW_HTTP_UPSTREAM, false),
    allowPrivateUpstream: bool(env.ALLOW_PRIVATE_UPSTREAM, false),
    allowedPorts: (list(env.ALLOWED_PORTS).length ? list(env.ALLOWED_PORTS) : ['80', '443']).map(Number),
    reservationPath: env.RESERVATION_PATH || '/Reservation/Reservation.aspx',
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY || '',
      privateKey: env.VAPID_PRIVATE_KEY || '',
      subject: env.VAPID_SUBJECT || 'mailto:admin@example.com',
    },
    refreshMinutes: Math.max(5, int(env.REFRESH_MINUTES, 20)),
    weeksBack: Math.min(4, Math.max(0, int(env.WEEKS_BACK, 1))),
    weeksAhead: Math.min(4, Math.max(0, int(env.WEEKS_AHEAD, 2))),
    inactiveDays: int(env.INACTIVE_DAYS, 45),
    maxUsers: int(env.MAX_USERS, 50),
  });
}

/** Host allow-list matching: exact host or "*.suffix" wildcard. */
export function hostMatches(host, patterns) {
  host = String(host).toLowerCase();
  return patterns.some((p) => {
    if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
    return host === p;
  });
}
