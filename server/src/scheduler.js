import { collectSnapshot, SessionExpiredError } from './collector.js';
import { tehranInstant, tehranIso } from './jalali.js';

export const MEALS = ['breakfast', 'lunch', 'dinner'];
export const MEAL_FA = { breakfast: 'صبحانه', lunch: 'ناهار', dinner: 'شام' };

export const faDigits = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

/** Reserved, not-yet-eaten meals whose reminder window is open right now and that were not announced yet. */
export function computeDue(user, nowMs) {
  const s = user.settings;
  if (!s?.notify || !user.snapshot) return [];
  const todayIso = tehranIso(new Date(nowMs));
  const tomorrowIso = tehranIso(new Date(nowMs + 86_400_000));
  const due = [];
  for (const week of user.snapshot.weeks) {
    for (const day of week.days) {
      if (!day.iso || (day.iso !== todayIso && day.iso !== tomorrowIso)) continue;
      for (const key of MEALS) {
        const pref = s.meals[key];
        const meal = day.meals[key];
        if (!pref?.on || !meal || meal.status !== 'reserved') continue;
        const start = tehranInstant(day.iso, pref.start);
        const end = tehranInstant(day.iso, pref.end);
        const id = `${day.iso}:${key}`;
        if (nowMs >= start - s.leadMinutes * 60_000 && nowMs < end && !user.notified[id]) {
          due.push({ id, key, day, meal, start, end });
        }
      }
    }
  }
  return due;
}

export function buildMealPayload(user, item, nowMs) {
  const first = (user.snapshot?.user?.name || '').trim().split(/\s+/)[0] || 'دوست من';
  const mins = Math.round((item.start - nowMs) / 60_000);
  const when = mins > 1 ? `تا ${faDigits(mins)} دقیقه دیگر` : 'همین الان';
  const hhmm = user.settings.meals[item.key].start;
  const where = item.meal.self?.name ? ` — ${item.meal.self.name}` : '';
  return {
    type: 'meal',
    title: `${first} جان، ${MEAL_FA[item.key]} ${when}`,
    body: `${item.meal.food?.name || 'غذای رزروشده'}${where}\nساعت ${faDigits(hhmm)}`,
    tag: `meal-${item.id}`,
    url: './',
  };
}

export function createScheduler({ cfg, store, upstream, pusher, collect = collectSnapshot, clock = Date.now, log = console }) {
  const refreshMs = cfg.refreshMinutes * 60_000;
  const retryMs = 5 * 60_000;
  const inflight = new Set();
  let timer = null;
  let ticking = false;

  async function notifyExpired(user) {
    if (user.expiredNotified) return;
    await pusher.sendToUser(
      user,
      {
        type: 'session',
        title: 'نشست کالینان منقضی شد',
        body: 'برای ادامه‌ی یادآوری‌ها، یک‌بار دیگر وارد شوید.',
        tag: 'session-expired',
        url: './#relogin',
      },
      () => store.save()
    );
    user.expiredNotified = true;
  }

  async function refreshUser(user) {
    if (inflight.has(user.id)) return { skipped: true };
    inflight.add(user.id);
    try {
      const jar = store.jarOf(user);
      const { snapshot, warnings } = await collect({ user, jar, upstream, cfg, now: new Date(clock()) });
      user.snapshot = snapshot;
      user.warnings = warnings;
      user.lastRefreshAt = clock();
      user.lastError = null;
      user.sessionState = 'ok';
      user.expiredNotified = false;
      return { ok: true };
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        user.sessionState = 'expired';
        user.lastError = 'session_expired';
        await notifyExpired(user);
        return { expired: true };
      }
      user.lastError = String(e.message || e).slice(0, 200);
      user.lastRefreshAt = clock() - (refreshMs - retryMs); // retry in ~5 min, not in 20
      log.warn?.(`[refresh] ${user.id}: ${user.lastError}`);
      return { error: user.lastError };
    } finally {
      inflight.delete(user.id);
      store.save();
    }
  }

  async function notifyDue(user, now) {
    for (const item of computeDue(user, now)) {
      const delivered = await pusher.sendToUser(user, buildMealPayload(user, item, now), () => store.save());
      if (delivered > 0) user.notified[item.id] = now;
    }
    for (const [k, t] of Object.entries(user.notified)) {
      if (now - t > 3 * 86_400_000) delete user.notified[k];
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = clock();
      for (const user of store.all()) {
        if (now - user.lastSeenAt > cfg.inactiveDays * 86_400_000) {
          store.delete(user.id); // privacy: forget accounts that were abandoned
          continue;
        }
        if (user.sessionState === 'ok' && now - user.lastRefreshAt >= refreshMs) await refreshUser(user);
        await notifyDue(user, now);
      }
      store.save();
    } catch (e) {
      log.error?.('[tick]', e);
    } finally {
      ticking = false;
    }
  }

  return {
    refreshUser,
    tick,
    start() { timer = setInterval(tick, 60_000); timer.unref?.(); setTimeout(tick, 2_000).unref?.(); },
    stop() { clearInterval(timer); },
  };
}
