import { normalizeDigits } from './jalali.js';

/* The university site is classic ASP.NET WebForms, whose GridView output is very regular.
   A tiny tolerant tag scanner is enough and keeps the server free of third-party code. */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export const text = (html) =>
  decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseAttrs(tag) {
  const attrs = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<\s*[\w:-]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(inner))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/* ------------------------------------------------------------- page detection */

export const GRID_IDS = {
  breakfast: 'cphMain_grdReservationBreakfast',
  lunch: 'cphMain_grdReservationLunch',
  dinner: 'cphMain_grdReservationDinner',
};

export function isReservationPage(html) {
  html = String(html);
  return Object.values(GRID_IDS).some((id) => html.includes(`id="${id}"`));
}

export const looksLikeLoginPage = (html) => /type\s*=\s*["']?password/i.test(String(html));

/* ---------------------------------------------------------------- grid parsing */

function sliceTable(html, id) {
  const idx = html.indexOf(`id="${id}"`);
  if (idx < 0) return null;
  const start = html.lastIndexOf('<table', idx);
  const end = html.indexOf('</table>', idx);
  if (start < 0 || end < 0) return null;
  return html.slice(start, end);
}

const byIdText = (html, tag, id) => {
  const m = new RegExp(`<${tag}\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
  return m ? text(m[1]) : '';
};

function selectedOption(cell) {
  const m = /<select\b[^>]*>([\s\S]*?)<\/select>/i.exec(cell);
  if (!m) return null;
  const opts = [...m[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({
    attrs: parseAttrs(`<option ${o[1]}>`),
    label: text(o[2]),
  }));
  const pick = opts.find((o) => 'selected' in o.attrs) || opts[0];
  return pick ? { value: pick.attrs.value ?? '', label: pick.label } : null;
}

const toInt = (s) => {
  const n = Number(normalizeDigits(String(s)).replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const isDash = (s) => !s || /^[-–—\s]*$/.test(s);

function parseFoodLabel(label) {
  const norm = normalizeDigits(label);
  const m = /^(.*?)\s*(\d[\d,]*)\s*ر[یي]ال\s*$/.exec(norm);
  return m ? { name: m[1].trim(), priceRial: toInt(m[2]) } : { name: norm.trim(), priceRial: 0 };
}

/**
 * eaten    – the card was used (title says "خورده شده")
 * reserved – reserved and not eaten *yet* (the site also labels locked/past ones "خورده نشده";
 *            whether that means "missed" depends on the clock, so consumers decide)
 * open     – a menu exists, nothing reserved, and the reservation can still change
 * closed   – a menu exists, nothing reserved, and the site has locked it
 * none     – no menu that day
 */
export function classifyStatus({ reserved, hasMenu, editable, title }) {
  const t = String(title || '');
  const notEaten = /خورده[\s\u200c]*نشده/.test(t);
  const eaten = !notEaten && /خورده[\s\u200c]*شده/.test(t);
  if (eaten) return 'eaten';
  if (reserved) return 'reserved';
  if (!hasMenu) return 'none';
  return editable ? 'open' : 'closed';
}

function parseMealRow(rowHtml) {
  const cells = rowHtml.split(/<td\b[^>]*>/i).slice(1);
  if (cells.length < 4) return null;

  const dayText = normalizeDigits(text(cells[1]));
  const dm = /^(.+?)\s+(\d{4}\/\d{1,2}\/\d{1,2})$/.exec(dayText);
  if (!dm) return null;
  const [y, mo, d] = dm[2].split('/');
  const date = `${y}/${mo.padStart(2, '0')}/${d.padStart(2, '0')}`;

  const cb = /<input\b[^>]*type\s*=\s*["']?checkbox[^>]*>/i.exec(cells[0]);
  const cbAttrs = cb ? parseAttrs(cb[0]) : {};
  const reservedFlag = 'checked' in cbAttrs;
  const editable = cb ? !('disabled' in cbAttrs) : false;

  const self = selectedOption(cells[2]);
  const food = selectedOption(cells[3]);
  const count = selectedOption(cells[4] || '');
  const hasMenu = !!food && !isDash(food.label);

  const spans = (c) => [...(c || '').matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((s) => text(s[1]));
  const calories = toInt(spans(cells[5])[0]);
  const paidRial = toInt(spans(cells[6])[0]);

  const img = /<img\b[^>]*>/i.exec(cells[7] || '');
  const title = img ? parseAttrs(img[0]).title || '' : '';

  const status = classifyStatus({ reserved: reservedFlag && hasMenu, hasMenu, editable, title });
  const eatenAt = status === 'eaten' ? (/(\d{1,2}:\d{2}(?::\d{2})?)/.exec(normalizeDigits(title)) || [])[1] || null : null;
  const f = hasMenu ? parseFoodLabel(food.label) : null;

  return {
    weekday: dm[1].trim(),
    date,
    meal: {
      hasMenu,
      reserved: reservedFlag && hasMenu,
      editable,
      status,
      statusText: title || null,
      eatenAt,
      self: self && !isDash(self.label) ? { id: self.value, name: self.label } : null,
      food: f ? { id: food.value, name: f.name, priceRial: f.priceRial } : null,
      count: count ? toInt(count.label) : hasMenu ? 1 : 0,
      calories,
      paidRial,
    },
  };
}

/** Parses one week of the "weekly food purchase" page. Returns null if this is not that page. */
export function parseReservationPage(html) {
  html = String(html);
  if (!isReservationPage(html)) return null;

  const days = new Map(); // date → day
  for (const [mealKey, id] of Object.entries(GRID_IDS)) {
    const table = sliceTable(html, id);
    if (!table) continue;
    for (const tr of table.split(/<tr\b[^>]*>/i).slice(1)) {
      if (!/<td\b/i.test(tr)) continue; // header row
      const row = parseMealRow(tr);
      if (!row) continue;
      if (!days.has(row.date)) {
        days.set(row.date, { weekday: row.weekday, date: row.date, label: `${row.weekday} ${row.date}`, meals: {} });
      }
      days.get(row.date).meals[mealKey] = row.meal;
    }
  }

  const empty = { hasMenu: false, reserved: false, editable: false, status: 'none', statusText: null, eatenAt: null, self: null, food: null, count: 0, calories: 0, paidRial: 0 };
  const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of list) for (const k of Object.keys(GRID_IDS)) d.meals[k] ??= { ...empty };

  const weekLabel = normalizeDigits(byIdText(html, 'label', 'cphMain_lblWeekDate'));
  const [from, to] = weekLabel.match(/\d{4}\/\d{2}\/\d{2}/g) || [list[0]?.date, list.at(-1)?.date];

  return {
    user: {
      name: byIdText(html, 'div', 'divUsername'),
      credit: toInt(byIdText(html, 'label', 'lblCredit')),
      cafeteriaCredit: toInt(byIdText(html, 'label', 'lblCafeteriaCredit')),
    },
    week: { label: weekLabel, from, to },
    days: list,
  };
}

/* --------------------------------------------------------------- postback form */

/**
 * Serialises the page's <form> the way a browser would on submit
 * (minus buttons — the caller adds the one image button it wants to "click").
 */
export function extractForm(html) {
  html = String(html);
  const formTag = /<form\b[^>]*>/i.exec(html);
  const action = formTag ? parseAttrs(formTag[0]).action || '' : '';
  const fields = [];

  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (!a.name || 'disabled' in a) continue;
    const type = (a.type || 'text').toLowerCase();
    if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !('checked' in a)) continue;
    fields.push([a.name, type === 'checkbox' && a.value === undefined ? 'on' : a.value ?? '']);
  }

  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const a = parseAttrs(`<select ${m[1]}>`);
    if (!a.name || 'disabled' in a) continue;
    const opts = [...m[2].matchAll(/<option\b([^>]*)>/gi)].map((o) => parseAttrs(`<option ${o[1]}>`));
    const pick = opts.find((o) => 'selected' in o) || opts[0];
    if (pick) fields.push([a.name, pick.value ?? '']);
  }

  return { action, fields, has: (name) => new RegExp(`name="${name.replace(/[$]/g, '\\$')}"`).test(html) };
}
