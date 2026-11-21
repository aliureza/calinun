// Jalali (Persian) calendar helpers built on Intl — no external dependencies.
// Tehran has no DST since 2022, so a fixed +03:30 offset is safe for meal times.

const TZ = 'Asia/Tehran';
const jFmt = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
});
const isoFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

export const pad = (n) => String(n).padStart(2, '0');

export function toJalali(date = new Date()) {
  const p = {};
  for (const part of jFmt.formatToParts(date)) p[part.type] = part.value;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

export const jalaliKey = ({ y, m, d }) => `${y}/${pad(m)}/${pad(d)}`;

/** Gregorian YYYY-MM-DD of the given instant, as seen in Tehran. */
export const tehranIso = (date = new Date()) => isoFmt.format(date);

/** Map of "1405/09/02" -> "2026-11-23" for ±span days around `center`. */
export function jalaliIsoMap(center = new Date(), span = 70) {
  const map = new Map();
  for (let i = -span; i <= span; i++) {
    const dt = new Date(center.getTime() + i * 86400000);
    map.set(jalaliKey(toJalali(dt)), tehranIso(dt));
  }
  return map;
}

/** Instant (ms) of HH:MM on the given Tehran calendar day. */
export function tehranInstant(iso, hhmm) {
  return new Date(`${iso}T${hhmm}:00+03:30`).getTime();
}

export function normalizeDigits(s) {
  return String(s)
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}
