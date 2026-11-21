import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseReservationPage, extractForm, classifyStatus, isReservationPage, looksLikeLoginPage } from '../src/parser.js';
import { toJalali, jalaliKey, jalaliIsoMap, tehranInstant } from '../src/jalali.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/store.js';
import { computeDue, buildMealPayload } from '../src/scheduler.js';
import { encryptPayload, decryptPayload, validSubscription } from '../src/push.js';
import { generateVapidKeys, seal, open, parseMasterKey } from '../src/crypto.js';
import { isPrivateAddress, Jar } from '../src/upstream.js';
import { rewriteHtml, rewriteCss, rewriteUrl } from '../src/proxy.js';
import { hostMatches } from '../src/config.js';

const html = fs.readFileSync(new URL('./fixtures/reservation-week0.html', import.meta.url), 'utf8');

test('parser: reads user, week and every day of the real page layout', () => {
  const p = parseReservationPage(html);
  assert.equal(p.user.credit, 1_200_000);
  assert.deepEqual([p.week.from, p.week.to], ['1405/08/30', '1405/09/06']);
  assert.equal(p.days.length, 7);
  assert.equal(p.days[0].weekday, 'شنبه');
  assert.equal(p.days[3].weekday, 'سه شنبه');
});

test('parser: meal statuses, food, self and price', () => {
  const p = parseReservationPage(html);
  const sat = p.days[0].meals;
  assert.equal(sat.lunch.status, 'eaten');
  assert.equal(sat.lunch.eatenAt, '12:53:54');
  assert.equal(sat.dinner.status, 'reserved');
  assert.equal(sat.breakfast.status, 'closed');
  const mon = p.days[2].meals;
  assert.equal(mon.lunch.status, 'reserved');
  assert.equal(mon.lunch.food.name, 'چلو خورشت قیمه');
  assert.equal(mon.lunch.food.priceRial, 250_000);
  assert.equal(mon.lunch.self.name, 'مهرنگار');
  assert.equal(mon.lunch.editable, true);
  assert.equal(mon.breakfast.status, 'open');
  assert.equal(p.days[3].meals.lunch.self.name, 'مستر بابی');
  assert.equal(p.days[5].meals.lunch.status, 'none'); // Thursday: no menu
  assert.equal(p.days[5].meals.lunch.food, null);
});

test('parser: classifyStatus', () => {
  assert.equal(classifyStatus({ reserved: true, hasMenu: true, editable: false, title: 'خورده شده - دستگاه - 12:00:00' }), 'eaten');
  assert.equal(classifyStatus({ reserved: true, hasMenu: true, editable: false, title: 'رزرو شده، خورده نشده، غیرفعال' }), 'reserved');
  assert.equal(classifyStatus({ reserved: false, hasMenu: true, editable: true, title: '' }), 'open');
  assert.equal(classifyStatus({ reserved: false, hasMenu: true, editable: false, title: 'غیرفعال' }), 'closed');
  assert.equal(classifyStatus({ reserved: false, hasMenu: false, editable: false, title: 'غیرفعال' }), 'none');
});

test('parser: page detection and unrelated pages', () => {
  assert.equal(isReservationPage(html), true);
  assert.equal(parseReservationPage('<html><body>hi</body></html>'), null);
  assert.equal(looksLikeLoginPage('<input type="password" name="p">'), true);
  assert.equal(looksLikeLoginPage(html), false);
});

test('form: serialises like a browser (no buttons, only checked boxes, selected options)', () => {
  const f = extractForm(html);
  const names = f.fields.map((x) => x[0]);
  assert.equal(f.action, './Reservation.aspx');
  assert.ok(names.includes('__VIEWSTATE') && names.includes('__EVENTVALIDATION'));
  assert.ok(!names.some((n) => n.includes('imgbtn')), 'image buttons must not be serialised');
  assert.equal(names.filter((n) => n.includes('chkReserve')).length, 3, 'only the 3 editable+checked boxes');
  assert.ok(!f.fields.some(([n]) => n.includes('drpFood') && n.includes('ctl02')), 'disabled selects are skipped');
  assert.ok(f.has('ctl00$cphMain$imgbtnNextWeek'));
});

test('jalali: Intl based conversion matches the page header date', () => {
  const d = new Date('2026-11-21T09:00:00Z');
  assert.equal(jalaliKey(toJalali(d)), '1405/09/30'.replace('09/30', '08/30'));
  assert.equal(jalaliIsoMap(d, 10).get('1405/09/02'), '2026-11-23');
  assert.equal(new Date(tehranInstant('2026-11-23', '12:00')).toISOString(), '2026-11-23T08:30:00.000Z');
});

test('settings: validation', () => {
  const s = sanitizeSettings({ leadMinutes: 60, meals: { lunch: { start: '12:30', end: '15:00' }, evil: { on: true } }, junk: 1 });
  assert.equal(s.leadMinutes, 60);
  assert.equal(s.meals.lunch.start, '12:30');
  assert.equal('evil' in s.meals, false);
  assert.throws(() => sanitizeSettings({ leadMinutes: 1 }));
  assert.throws(() => sanitizeSettings({ leadMinutes: '45; DROP' }));
  assert.throws(() => sanitizeSettings({ meals: { lunch: { start: '25:00' } } }));
  assert.throws(() => sanitizeSettings({ meals: { lunch: { start: '14:00', end: '13:00' } } }));
});

function userWith(snapshotDays, settings = {}) {
  return {
    settings: sanitizeSettings(settings, DEFAULT_SETTINGS),
    notified: {},
    snapshot: { user: { name: 'علیرضا حیدری' }, weeks: [{ offset: 0, days: snapshotDays }] },
  };
}
const meal = (status, food = 'چلو کباب', self = 'مهرنگار') => ({ status, food: { name: food }, self: { name: self } });
const empty = { status: 'none' };

test('notifications: window opens at (start - lead) and closes at end; once only', () => {
  const day = { iso: '2026-11-23', meals: { breakfast: empty, lunch: meal('reserved'), dinner: meal('open') } };
  const u = userWith([day]); // lunch 12:00–14:30, lead 45
  const at = (hhmm) => tehranInstant('2026-11-23', hhmm);
  assert.equal(computeDue(u, at('11:10')).length, 0);
  const due = computeDue(u, at('11:16'));
  assert.equal(due.length, 1);
  assert.equal(due[0].key, 'lunch');
  const p = buildMealPayload(u, due[0], at('11:16'));
  assert.match(p.title, /^علیرضا جان، ناهار تا ۴۴ دقیقه دیگر$/);
  assert.match(p.body, /چلو کباب — مهرنگار/);
  u.notified[due[0].id] = 1;
  assert.equal(computeDue(u, at('11:30')).length, 0);
  assert.equal(computeDue(userWith([day]), at('14:31')).length, 0);
});

test('notifications: respects toggles, eaten meals and per-meal switches', () => {
  const day = { iso: '2026-11-23', meals: { breakfast: meal('reserved'), lunch: meal('eaten'), dinner: meal('reserved') } };
  const at = (hhmm) => tehranInstant('2026-11-23', hhmm);
  assert.equal(computeDue(userWith([day]), at('06:30')).length, 0, 'breakfast is off by default');
  assert.equal(computeDue(userWith([day], { meals: { breakfast: { on: true } } }), at('06:30')).length, 1);
  assert.equal(computeDue(userWith([day]), at('12:00')).filter((d) => d.key === 'lunch').length, 0, 'eaten meal');
  assert.equal(computeDue(userWith([day], { notify: false }), at('17:30')).length, 0);
  assert.equal(computeDue(userWith([day]), at('17:30')).length, 1, 'dinner reminder');
});

test('web push: payload encryption round-trips (RFC 8291)', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const msg = { title: 'سلام', body: 'چلو کباب — مهرنگار' };
  const wire = encryptPayload(sub, msg);
  assert.deepEqual(decryptPayload(wire, ua, auth), msg);
  assert.equal(validSubscription(sub), true);
});

test('web push: subscription endpoints are restricted to real push services', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  for (const endpoint of ['https://evil.example.com/x', 'http://fcm.googleapis.com/x', 'https://169.254.169.254/x', 'https://fcm.googleapis.com.evil.com/x']) {
    assert.equal(validSubscription({ endpoint, keys }), false, endpoint);
  }
  for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w']) {
    assert.equal(validSubscription({ endpoint, keys }), true, endpoint);
  }
});

test('crypto: sealed store detects tampering and wrong keys', () => {
  const key = parseMasterKey(crypto.randomBytes(32).toString('hex'));
  const blob = seal({ a: 1 }, key);
  assert.deepEqual(open(blob, key), { a: 1 });
  blob[blob.length - 1] ^= 1;
  assert.throws(() => open(blob, key));
  assert.throws(() => open(seal({ a: 1 }, key), parseMasterKey(crypto.randomBytes(32).toString('hex'))));
  assert.throws(() => parseMasterKey('short'));
  const v = generateVapidKeys();
  assert.equal(Buffer.from(v.publicKey, 'base64url').length, 65);
});

test('ssrf: private/loopback/link-local/mapped addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:a00:1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '185.1.2.3']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(hostMatches('food.uni.ac.ir', ['*.uni.ac.ir']), true);
  assert.equal(hostMatches('uni.ac.ir', ['*.uni.ac.ir']), false);
  assert.equal(hostMatches('evil-uni.ac.ir', ['*.uni.ac.ir']), false);
  assert.equal(hostMatches('food.uni.ac.ir.evil.com', ['food.uni.ac.ir']), false);
});

test('cookie jar: set, overwrite and delete', () => {
  const j = new Jar();
  j.update(['a=1; path=/; HttpOnly', 'b=2']);
  assert.equal(j.header(), 'a=1; b=2');
  j.update(['a=; expires=Thu, 01 Jan 1970 00:00:00 GMT', 'b=3']);
  assert.equal(j.header(), 'b=3');
  j.update(['b=9; Max-Age=0']);
  assert.equal(j.size, 0);
});

test('proxy rewriting keeps everything inside the proxy prefix', () => {
  const o = 'https://food.uni.ac.ir', p = '/p/SID';
  assert.equal(rewriteUrl('/Styles/a.css', p, o), '/p/SID/Styles/a.css');
  assert.equal(rewriteUrl('https://food.uni.ac.ir/x?y=1', p, o), '/p/SID/x?y=1');
  assert.equal(rewriteUrl('//food.uni.ac.ir/x', p, o), '/p/SID/x');
  assert.equal(rewriteUrl('../Styles/a.css', p, o), '../Styles/a.css');
  assert.equal(rewriteUrl('//cdn.evil.com/x.js', p, o), '//cdn.evil.com/x.js');
  assert.equal(rewriteUrl('javascript:__doPostBack()', p, o), 'javascript:__doPostBack()');
  const out = rewriteHtml('<img src="/c.png"><a href=\'/x\'>l</a><form action="./Login.aspx"><div style="background:url(/b.png)">', p, o);
  assert.match(out, /src="\/p\/SID\/c\.png"/);
  assert.match(out, /href='\/p\/SID\/x'/);
  assert.match(out, /action="\.\/Login\.aspx"/);
  assert.match(out, /url\(\/p\/SID\/b\.png\)/);
  assert.equal(rewriteCss('a{background:url("/i.png")}', p, o), 'a{background:url("/p/SID/i.png")}');
});
