// Shared helpers: Persian formatting, Tehran time, meal metadata.

export const MEALS = ['breakfast', 'lunch', 'dinner'];
export const MEAL_META = {
  breakfast: { fa: 'صبحانه', icon: 'i-coffee' },
  lunch: { fa: 'ناهار', icon: 'i-sun' },
  dinner: { fa: 'شام', icon: 'i-moon' },
};
export const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
export const WEEKDAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];

export const DEFAULT_SETTINGS = {
  notify: true,
  leadMinutes: 45,
  meals: {
    breakfast: { on: false, start: '07:00', end: '09:00' },
    lunch: { on: true, start: '12:00', end: '14:30' },
    dinner: { on: true, start: '18:00', end: '20:30' },
  },
};

const FA = '۰۱۲۳۴۵۶۷۸۹';
export const faDigits = (s) => String(s).replace(/\d/g, (d) => FA[d]);
export const fa = (n) => faDigits(Number(n).toLocaleString('en-US'));
export const faMoney = (n) => faDigits(Number(n || 0).toLocaleString('en-US')).replace(/,/g, '٬');

/** HTML-escape anything that came from the network before it goes into innerHTML. */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isoFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });
const jFmt = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric' });

export const tehranIso = (d = new Date()) => isoFmt.format(d);
export function toJalali(d = new Date()) {
  const p = {};
  for (const x of jFmt.formatToParts(d)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day };
}
export const jKey = ({ y, m, d }) => `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
export const parseJ = (s) => { const [y, m, d] = s.split('/').map(Number); return { y, m, d }; };
export const fmtDayMonth = (jkey) => { const j = parseJ(jkey); return `${fa(j.d)} ${MONTHS[j.m - 1]}`; };

export const instant = (iso, hhmm) => Date.parse(`${iso}T${hhmm}:00+03:30`);
export const addDaysIso = (iso, n) => tehranIso(new Date(Date.parse(`${iso}T12:00:00+03:30`) + n * 86400000));
export const isoToJalaliKey = (iso) => jKey(toJalali(new Date(`${iso}T12:00:00+03:30`)));

export function fmtIn(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'کمتر از یک دقیقه';
  if (m < 60) return `${fa(m)} دقیقه`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${fa(h)} ساعت و ${fa(m % 60)} دقیقه` : `${fa(h)} ساعت`;
  const d = Math.floor(h / 24);
  return `${fa(d)} روز`;
}

export function ago(ts, now = Date.now()) {
  if (!ts) return 'هنوز به‌روز نشده';
  const m = Math.floor((now - ts) / 60000);
  if (m < 1) return 'همین الان';
  if (m < 60) return `${fa(m)} دقیقه پیش`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${fa(h)} ساعت پیش`;
  return `${fa(Math.floor(h / 24))} روز پیش`;
}

export const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';

/**
 * Display state of one meal, combining the site's status with the clock.
 * The site keeps calling a locked, passed meal "reserved, not eaten" — here that becomes "missed".
 */
export function mealView(day, key, settings, now = Date.now()) {
  const m = day.meals[key];
  const pref = settings.meals[key];
  const start = instant(day.iso, pref.start);
  const end = instant(day.iso, pref.end);
  let state = m.status;
  if (state === 'reserved') {
    if (now >= end) state = 'missed';
    else if (now >= start) state = 'now';
  }
  return { m, key, start, end, state };
}

export function nextMeal(days, settings, now = Date.now()) {
  let best = null;
  for (const day of days) {
    if (!day.iso) continue;
    for (const key of MEALS) {
      const v = mealView(day, key, settings, now);
      if ((v.state === 'reserved' || v.state === 'now') && v.end > now && (!best || v.start < best.start)) best = { ...v, day };
    }
  }
  return best;
}
