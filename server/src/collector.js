import { extractForm, isReservationPage, looksLikeLoginPage, parseReservationPage } from './parser.js';
import { jalaliIsoMap, jalaliKey, toJalali } from './jalali.js';
import { httpError } from './upstream.js';

export class SessionExpiredError extends Error {
  constructor(msg = 'Session expired') { super(msg); this.name = 'SessionExpiredError'; }
}

/**
 * READ-ONLY GUARANTEE: the only POSTs this server ever sends to the university site are the three
 * week-navigation image buttons below. Nothing here can reserve, cancel or change a meal.
 */
const NAV = Object.freeze({
  last: 'ctl00$cphMain$imgbtnLastWeek',
  current: 'ctl00$cphMain$imgbtnCurrentWeek',
  next: 'ctl00$cphMain$imgbtnNextWeek',
});

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

function baseHeaders(origin, referer) {
  return {
    'user-agent': UA,
    'accept-language': 'fa-IR,fa;q=0.9,en;q=0.5',
    accept: 'text/html,application/xhtml+xml',
    referer: referer || origin + '/',
  };
}

async function getPage({ upstream, jar, url, origin }) {
  const r = await upstream.request(url, { headers: baseHeaders(origin, url), jar, maxBytes: 4_000_000 });
  return classify(r, url, origin);
}

function classify(r, url) {
  if (r.status >= 300 && r.status < 400) {
    // A redirect away from the page almost always means "go log in".
    throw new SessionExpiredError(`Redirected (${r.status}) to ${r.headers.location || '?'}`);
  }
  if (r.status >= 500) throw httpError(502, `Upstream error ${r.status}`);
  if (r.status !== 200) throw httpError(502, `Unexpected upstream status ${r.status}`);
  const html = r.body.toString('utf8');
  if (!isReservationPage(html)) {
    if (looksLikeLoginPage(html)) throw new SessionExpiredError('Login page returned');
    throw httpError(502, 'Reservation grid not found (page layout changed?)');
  }
  return html;
}

async function postNav({ upstream, jar, url, origin, html, button }) {
  const name = NAV[button];
  const form = extractForm(html);
  if (!form.has(name)) return null; // button not present (e.g. no next week) → stop the chain

  const params = new URLSearchParams();
  for (const [k, v] of form.fields) params.append(k, v);
  params.set('__EVENTTARGET', '');
  params.set('__EVENTARGUMENT', '');
  params.append(`${name}.x`, '12');
  params.append(`${name}.y`, '9');

  const action = new URL(form.action || url, url).href;
  if (new URL(action).origin !== origin) throw httpError(502, 'Form action leaves the university origin');

  const r = await upstream.request(action, {
    method: 'POST',
    headers: {
      ...baseHeaders(origin, url),
      'content-type': 'application/x-www-form-urlencoded',
      origin,
    },
    body: params.toString(),
    jar,
    maxBytes: 4_000_000,
  });
  return classify(r, action, origin);
}

/**
 * Fetches week 0 and up to `weeksBack` previous / `weeksAhead` next weeks.
 * @returns {Promise<{snapshot: object, warnings: string[]}>}
 */
export async function collectSnapshot({ user, jar, upstream, cfg, now = new Date() }) {
  const origin = user.origin;
  const url = user.reservationUrl;
  const ctx = { upstream, jar, url, origin };
  const warnings = [];
  const isoMap = jalaliIsoMap(now, 90);
  const today = jalaliKey(toJalali(now));
  const inWeek = (p) => p.week.from && p.week.to && p.week.from <= today && today <= p.week.to;

  const weeks = new Map(); // offset → parsed page
  const keep = (offset, html) => {
    const parsed = parseReservationPage(html);
    if (parsed) weeks.set(offset, parsed);
    return parsed;
  };

  let html = await getPage(ctx);
  let page = parseReservationPage(html);
  if (!inWeek(page)) {
    // The site remembers the last viewed week in the session; jump back to the current one.
    const back = await postNav({ ...ctx, html, button: 'current' });
    if (back) { html = back; page = parseReservationPage(html); }
    if (!inWeek(page)) warnings.push('could_not_confirm_current_week');
  }
  keep(0, html);
  const userInfo = page.user;

  // Walk the site's own week navigation, always remembering where the server-side "viewed week" is.
  let latest = html;
  let latestOffset = 0;
  const go = async (button, offset) => {
    const next = await postNav({ ...ctx, html: latest, button });
    if (!next) return false;
    latest = next;
    latestOffset = offset;
    keep(offset, next);
    return true;
  };

  for (let i = 1; i <= cfg.weeksAhead; i++) {
    if (!(await go('next', i))) { warnings.push(`next_week_${i}_unavailable`); break; }
  }

  if (cfg.weeksBack > 0) {
    if (latestOffset !== 0) {
      if (!(await go('current', 0))) warnings.push('could_not_return_to_current_week');
    }
    if (latestOffset === 0) {
      for (let i = 1; i <= cfg.weeksBack; i++) {
        if (!(await go('last', -i))) { warnings.push(`last_week_${i}_unavailable`); break; }
      }
    }
  }

  // Leave the server-side "viewed week" on the current week so the user's own browser isn't surprised.
  if (latestOffset !== 0) {
    try { await go('current', 0); } catch { /* best effort */ }
  }

  const out = [...weeks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([offset, p]) => ({
      offset,
      label: p.week.label,
      from: p.week.from,
      to: p.week.to,
      days: p.days.map((d) => ({ ...d, iso: isoMap.get(d.date) || null })),
    }));

  return {
    snapshot: { fetchedAt: now.getTime(), user: userInfo, weeks: out },
    warnings,
  };
}
