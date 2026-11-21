// Headless smoke test of the whole UI in demo mode, using a tiny DOM stub (no browser needed).
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
const el = (extra = {}) => ({ innerHTML: '', textContent: '', handlers: {}, classList: { add() {}, remove() {} }, addEventListener(t, f) { this.handlers[t] = f; }, querySelector: () => null, ...extra });
const nodes = { app: el(), toast: el() };
Object.assign(globalThis, {
  window: globalThis,
  document: { getElementById: (id) => nodes[id], querySelector: () => null, addEventListener() {}, documentElement: { dataset: {} }, visibilityState: 'visible' },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  location: { hash: '', pathname: '/', search: '', assign() {} },
  history: { replaceState() {} },
  scrollTo() {}, addEventListener() {}, scrollY: 0,
});
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }, configurable: true });
window.CULLINON = { apiUrl: '', version: 'test' };
globalThis.confirm = () => true;

const click = async (act, dataset = {}) => {
  const target = { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, ...dataset } } : null) };
  await nodes.app.handlers.click({ target });
  await new Promise((r) => setTimeout(r, 400));
};
const bad = (html) => assert.doesNotMatch(html, /undefined|NaN|\[object|null</);

test('smoke: onboarding → demo → today/week/settings render sanely', async () => {
  await import('../js/app.js');
  await new Promise((r) => setTimeout(r, 50));
  let html = nodes.app.innerHTML;
  assert.match(html, /ورود به نسخهٔ دمو/);
  bad(html);

  await click('demo');
  html = nodes.app.innerHTML;
  assert.match(html, /سلام رضا/);
  assert.match(html, /class="hero/);
  assert.match(html, /سایت کالینان/);
  assert.equal((html.match(/day-chip/g) || []).length >= 28, true, '4 weeks of day chips');
  assert.match(html, /class="meal /);
  bad(html);

  await click('nav', { v: 'week' });
  html = nodes.app.innerHTML;
  assert.match(html, /این هفته/);
  assert.match(html, /class="wday/);
  bad(html);
  await click('week', { d: '1' });
  assert.match(nodes.app.innerHTML, /هفتهٔ بعد/);
  await click('week', { d: '-1' });
  await click('week', { d: '-1' });
  assert.match(nodes.app.innerHTML, /هفتهٔ قبل/);

  await click('nav', { v: 'settings' });
  html = nodes.app.innerHTML;
  assert.match(html, /یادآوری وعده‌ها/);
  assert.match(html, /حالت دمو/);
  bad(html);

  await click('theme', { v: 'dark' });
  assert.equal(document.documentElement.dataset.theme, 'dark');
  await click('logout');
  assert.match(nodes.app.innerHTML, /ورود به نسخهٔ دمو/);
});

test('xss: server-supplied strings are escaped', async () => {
  const { esc } = await import('../js/util.js');
  assert.equal(esc('<img src=x onerror=alert(1)>"\''), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;');
});

test('util: next meal logic and Persian formatting', async () => {
  const u = await import('../js/util.js');
  assert.equal(u.faDigits('1405/09/02'), '۱۴۰۵/۰۹/۰۲');
  assert.equal(u.faMoney(1200000), '۱٬۲۰۰٬۰۰۰');
  assert.equal(u.fmtIn(80 * 60000), '۱ ساعت و ۲۰ دقیقه');
  const day = { iso: '2026-11-23', meals: { breakfast: { status: 'none' }, lunch: { status: 'reserved' }, dinner: { status: 'reserved' } } };
  const at = (hhmm) => u.instant('2026-11-23', hhmm);
  assert.equal(u.nextMeal([day], u.DEFAULT_SETTINGS, at('10:00')).key, 'lunch');
  assert.equal(u.nextMeal([day], u.DEFAULT_SETTINGS, at('12:30')).state, 'now');
  assert.equal(u.nextMeal([day], u.DEFAULT_SETTINGS, at('15:00')).key, 'dinner');
  assert.equal(u.nextMeal([day], u.DEFAULT_SETTINGS, at('21:00')), null);
  assert.equal(u.mealView(day, 'lunch', u.DEFAULT_SETTINGS, at('16:00')).state, 'missed');
});

// app.js starts polling timers by design; end the process once the tests are done.
import { after } from 'node:test';
after(() => setTimeout(() => process.exit(process.exitCode || 0), 50));
