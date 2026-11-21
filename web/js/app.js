import { createApi, ApiError, prefs } from './api.js';
import {
  MEALS, MEAL_META, WEEKDAYS, DEFAULT_SETTINGS, esc, fa, faDigits, faMoney, ago, fmtIn, fmtDayMonth,
  tehranIso, addDaysIso, nextMeal, mealView, firstName, instant,
} from './util.js';

const CFG = window.CULLINON || { apiUrl: '', version: 'dev' };
const api = createApi(CFG.apiUrl);
const root = document.getElementById('app');
const toastEl = document.getElementById('toast');

const S = {
  view: 'today', data: null, selIso: null, weekIdx: null,
  loading: true, refreshing: false, online: navigator.onLine,
  onb: { error: '', busy: false }, installEvt: null, heroKey: '', pollTries: 0, lastLoad: 0,
};

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const settings = () => S.data?.settings || DEFAULT_SETTINGS;
const weeks = () => S.data?.snapshot?.weeks || [];
const allDays = () => weeks().flatMap((w) => w.days).filter((d) => d.iso);
const icon = (id, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const SHORT_DAY = { 'شنبه': 'شنبه', 'یکشنبه': '۱شنبه', 'دوشنبه': '۲شنبه', 'سه شنبه': '۳شنبه', 'چهارشنبه': '۴شنبه', 'پنجشنبه': '۵شنبه', 'جمعه': 'جمعه' };

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

function applyTheme() {
  const t = prefs.get().theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1e1814' : '#ff7a00');
}

/* ============================================================ rendering */

const relDay = (iso) => {
  const t = tehranIso();
  return iso === t ? 'امروز' : iso === addDaysIso(t, 1) ? 'فردا' : iso === addDaysIso(t, -1) ? 'دیروز' : null;
};
const hhmm = (s) => faDigits(s);

function chrome(inner, title, sub) {
  const nav = [['today', 'امروز', 'i-home'], ['week', 'برنامه', 'i-calendar'], ['settings', 'تنظیمات', 'i-sliders']]
    .map(([k, label, ic]) => `<li><button data-act="nav" data-v="${k}" ${S.view === k ? 'aria-current="page"' : ''}><span class="pillbg">${icon(ic)}</span>${label}</button></li>`).join('');
  return `
  <main class="shell"><div class="view" id="view-${S.view}">
    <header class="topbar">
      <div class="brand"><img src="icons/icon-192.png" alt="" width="44" height="44"><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div></div>
      <button class="icon-btn ${S.refreshing ? 'spin' : ''}" data-act="refresh" aria-label="به‌روزرسانی از کالینان" ${S.refreshing ? 'disabled' : ''}>${icon('i-refresh')}</button>
    </header>
    ${inner}
  </div></main>
  <button class="fab" data-act="site" aria-label="رفتن به سایت اصلی کالینان">${icon('i-external')}<span>سایت کالینان</span></button>
  <nav class="nav" aria-label="ناوبری اصلی"><ul>${nav}</ul></nav>`;
}

function statusBar() {
  const d = S.data;
  const chips = [];
  if (d?.user?.credit != null) chips.push(`<span class="chip">${icon('i-card', 'sm')} اعتبار <b>${faMoney(d.user.credit)}</b> ریال</span>`);
  if (d?.session) {
    const stale = Date.now() - d.session.lastRefreshAt > 3 * 3600_000;
    chips.push(`<span class="chip ${stale ? 'warn' : ''}">${icon('i-clock', 'sm')} ${esc(ago(d.session.lastRefreshAt))}</span>`);
  }
  if (!S.online) chips.push(`<span class="chip warn">${icon('i-alert', 'sm')} آفلاین</span>`);
  return `<div class="chips">${chips.join('')}</div>`;
}

function banners() {
  let h = '';
  if (api.isDemo) h += `<div class="banner info">${icon('i-alert')}<div><b>نسخهٔ دمو</b><br>همهٔ داده‌ها نمونه است. برای اتصال واقعی، آدرس سرور را در تنظیمات ساخت (API_URL) وارد کنید.</div></div>`;
  if (S.data?.session?.state === 'expired') {
    h += `<div class="banner err">${icon('i-lock')}<div><b>نشست کالینان منقضی شده</b><br>داده‌های قبلی نمایش داده می‌شود، ولی تا ورود دوباره به‌روز نمی‌شود و یادآوری هم نمی‌آید.<br><button data-act="relogin"><span>ورود دوباره</span></button></div></div>`;
  } else if (S.data?.session?.lastError && S.data.session.state === 'ok') {
    h += `<div class="banner info">${icon('i-alert')}<div>دریافت آخرین اطلاعات از کالینان با خطا مواجه شد؛ به‌زودی دوباره تلاش می‌شود.</div></div>`;
  }
  return h;
}

function heroHtml(now) {
  const nm = nextMeal(allDays(), settings(), now);
  S.heroKey = nm ? `${nm.day.iso}:${nm.key}:${nm.state}` : '';
  if (!nm) {
    return `<section class="hero idle"><span class="eyebrow">${icon('i-check', 'sm')} همه‌چیز آرام است</span>
      <h2>وعدهٔ رزروشده‌ای در پیش نیست</h2><p>برای رزرو غذای روزهای آینده، به سایت کالینان بروید.</p>
      <button class="btn" data-act="site">${icon('i-external', 'sm')} رزرو در کالینان</button></section>`;
  }
  const meta = MEAL_META[nm.key];
  const live = nm.state === 'now';
  const dayWord = relDay(nm.day.iso) || nm.day.weekday;
  const f = nm.m.food;
  return `<section class="hero" aria-label="وعدهٔ بعدی">
    <span class="eyebrow">${icon(meta.icon, 'sm')} ${live ? 'الان وقت غذاست' : 'وعدهٔ بعدی'} · ${meta.fa} ${esc(dayWord)}</span>
    <h2>${esc(f?.name || 'غذای رزروشده')}</h2>
    <div class="where">
      ${nm.m.self ? `<span>${icon('i-pin', 'sm')} ${esc(nm.m.self.name)}</span>` : ''}
      <span>${icon('i-clock', 'sm')} ${hhmm(settings().meals[nm.key].start)} تا ${hhmm(settings().meals[nm.key].end)}</span>
    </div>
    <div class="count"><strong data-cd data-start="${nm.start}" data-end="${nm.end}">${live ? 'تا ساعت ' + hhmm(settings().meals[nm.key].end) : fmtIn(nm.start - now)}</strong><small>${live ? 'فرصت دریافت' : 'تا شروع وعده'}</small></div>
  </section>`;
}

function strip(selIso, now) {
  const today = tehranIso(new Date(now));
  const chips = allDays().map((d) => {
    const views = MEALS.map((k) => mealView(d, k, settings(), now));
    const dots = views.map((v) => `<i class="${v.state === 'eaten' ? 'done' : v.state === 'reserved' || v.state === 'now' ? 'on' : ''}"></i>`).join('');
    const off = views.every((v) => v.state === 'none');
    const j = d.date.split('/');
    return `<button class="day-chip ${d.iso === selIso ? 'sel' : ''} ${d.iso === today ? 'today' : ''} ${off ? 'off' : ''}" data-act="day" data-iso="${d.iso}" aria-pressed="${d.iso === selIso}" aria-label="${esc(d.weekday)} ${fa(+j[2])} ${fmtDayMonth(d.date).split(' ')[1]}">
      <small>${esc(SHORT_DAY[d.weekday] || d.weekday)}</small><strong>${fa(+j[2])}</strong><span class="dots">${dots}</span></button>`;
  }).join('');
  return `<div class="strip" id="strip" role="group" aria-label="انتخاب روز">${chips}</div>`;
}

const PILL = { reserved: 'رزرو شده', now: 'الان', eaten: 'تحویل گرفته شد', missed: 'استفاده نشد', open: 'رزرو نشده', closed: 'رزرو نشده' };

function mealCard(v) {
  const meta = MEAL_META[v.key];
  const m = v.m;
  const head = (pill) => `<div class="head"><span class="kind">${meta.fa}</span>${pill}</div>`;
  if (v.state === 'none' || !m.hasMenu) {
    return `<article class="meal none"><div class="ico">${icon(meta.icon)}</div><div class="body">${head('')}<div class="food">منویی برای این وعده ثبت نشده</div></div></article>`;
  }
  const pill = `<span class="pill ${v.state}">${esc(PILL[v.state])}${v.state === 'eaten' && m.eatenAt ? ' · ' + hhmm(m.eatenAt.slice(0, 5)) : ''}</span>`;
  if (v.state === 'open' || v.state === 'closed') {
    return `<article class="meal ${v.state}"><div class="ico">${icon(meta.icon)}</div><div class="body">${head(pill)}
      <div class="food">${v.state === 'open' ? 'هنوز رزرو نکرده‌ای' : 'رزرو این وعده بسته شده'}</div>
      <div class="meta"><span>${icon('i-clock', 'sm')} ${hhmm(settings().meals[v.key].start)} تا ${hhmm(settings().meals[v.key].end)}</span>${v.state === 'open' ? '<span>برای رزرو به سایت کالینان بروید</span>' : ''}</div></div></article>`;
  }
  const total = (m.food?.priceRial || 0) * (m.count || 1);
  return `<article class="meal ${v.state}"><div class="ico">${icon(meta.icon)}</div><div class="body">${head(pill)}
    <div class="food">${esc(m.food?.name || '')}${m.count > 1 ? ` <small>×${fa(m.count)}</small>` : ''}</div>
    <div class="meta">
      ${m.self ? `<span>${icon('i-pin', 'sm')} ${esc(m.self.name)}</span>` : ''}
      <span>${icon('i-clock', 'sm')} ${hhmm(settings().meals[v.key].start)} تا ${hhmm(settings().meals[v.key].end)}</span>
      ${total ? `<span>${icon('i-card', 'sm')} ${faMoney(total)} ریال</span>` : ''}
    </div></div></article>`;
}

function skeleton() {
  return `<div class="skel hero-s"></div><div class="skel card-s"></div><div class="skel card-s"></div><div class="skel card-s"></div>
    <p class="empty">در حال دریافت اطلاعات از کالینان…<br>بار اول چند ثانیه طول می‌کشد.</p>`;
}

function viewToday() {
  const now = Date.now();
  if (!S.data?.snapshot) return skeleton();
  const days = allDays();
  const today = tehranIso(new Date(now));
  if (!S.selIso || !days.some((d) => d.iso === S.selIso)) {
    S.selIso = (days.find((d) => d.iso === today) || days.find((d) => d.iso > today) || days[0])?.iso;
  }
  const day = days.find((d) => d.iso === S.selIso);
  const rel = day && relDay(day.iso);
  const cards = day
    ? MEALS.map((k) => mealCard(mealView(day, k, settings(), now))).join('')
    : '<p class="empty">برنامه‌ای برای نمایش نیست.</p>';
  return `${banners()}${statusBar()}${heroHtml(now)}${strip(S.selIso, now)}
    <div class="section-title"><h3>${day ? `${esc(day.weekday)} ${fmtDayMonth(day.date)}` : ''}</h3>${rel ? `<span class="badge">${rel}</span>` : ''}</div>
    <div class="cards">${cards}</div>`;
}

function viewWeek() {
  if (!S.data?.snapshot) return skeleton();
  const ws = weeks();
  if (S.weekIdx == null || S.weekIdx >= ws.length) S.weekIdx = Math.max(0, ws.findIndex((w) => w.offset === 0));
  const w = ws[S.weekIdx];
  const now = Date.now();
  const today = tehranIso(new Date(now));
  let reserved = 0, eaten = 0, cost = 0;
  const dayCards = w.days.map((d) => {
    const views = MEALS.map((k) => mealView(d, k, settings(), now));
    for (const v of views) {
      if (['reserved', 'now', 'missed', 'eaten'].includes(v.state)) { reserved++; cost += (v.m.food?.priceRial || 0) * (v.m.count || 1); }
      if (v.state === 'eaten') eaten++;
    }
    const rows = views.filter((v) => v.state !== 'none').map((v) => {
      const reservedLike = ['reserved', 'now', 'missed', 'eaten'].includes(v.state);
      return `<div class="row ${reservedLike ? '' : 'dim'}"><span class="k">${MEAL_META[v.key].fa}</span><span class="v">${reservedLike ? `${esc(v.m.food?.name || '')} <small>· ${esc(v.m.self?.name || '')}</small>` : 'رزرو نشده'}</span><span class="dot ${v.state}"></span></div>`;
    }).join('') || '<div class="row dim"><span class="v">بدون منو</span></div>';
    return `<button class="wday ${d.iso === today ? 'today' : ''}" data-act="pick-day" data-iso="${d.iso}"><div class="wh"><span>${esc(d.weekday)}</span><small>${fmtDayMonth(d.date)}${d.iso === today ? ' · امروز' : ''}</small></div>${rows}</button>`;
  }).join('');
  const name = w.offset === 0 ? 'این هفته' : w.offset === -1 ? 'هفتهٔ قبل' : w.offset === 1 ? 'هفتهٔ بعد' : `${fa(w.offset)} هفتهٔ بعد`;
  return `${banners()}
    <div class="week-switch">
      <button class="icon-btn" data-act="week" data-d="-1" aria-label="هفتهٔ قبل" ${S.weekIdx === 0 ? 'disabled' : ''}>${icon('i-prev')}</button>
      <div class="label"><strong>${name}</strong><small>${fmtDayMonth(w.from)} تا ${fmtDayMonth(w.to)}</small></div>
      <button class="icon-btn" data-act="week" data-d="1" aria-label="هفتهٔ بعد" ${S.weekIdx === ws.length - 1 ? 'disabled' : ''}>${icon('i-next')}</button>
    </div>
    <div class="stats"><div class="stat"><strong>${fa(reserved)}</strong><small>وعدهٔ رزروشده</small></div><div class="stat"><strong>${fa(eaten)}</strong><small>دریافت‌شده</small></div><div class="stat"><strong>${faMoney(Math.round(cost / 10))}</strong><small>تومان هزینه</small></div></div>
    ${dayCards}`;
}

function toggle(name, checked, label) {
  return `<label class="switch"><input type="checkbox" data-set="${name}" ${checked ? 'checked' : ''} aria-label="${esc(label)}"><i></i></label>`;
}

function viewSettings() {
  const s = settings();
  const t = prefs.get().theme;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  let notifNote = '';
  if (perm === 'unsupported') notifNote = 'این مرورگر از نوتیف پشتیبانی نمی‌کند.';
  else if (perm === 'denied') notifNote = 'اجازهٔ نوتیف در تنظیمات مرورگر مسدود شده است؛ از آنجا فعالش کنید.';
  else if (isIOS && !isStandalone()) notifNote = 'در آیفون ابتدا از منوی «اشتراک‌گذاری» گزینهٔ «افزودن به صفحهٔ اصلی» را بزنید و برنامه را از آنجا باز کنید؛ سپس نوتیف را فعال کنید.';
  const mealRows = MEALS.map((k) => `<div class="item"><div class="t"><b>${MEAL_META[k].fa}</b></div>
      <div class="times">${toggle(`meal.${k}.on`, s.meals[k].on, 'یادآوری ' + MEAL_META[k].fa)}
      <input class="time" type="time" data-set="meal.${k}.start" value="${s.meals[k].start}" aria-label="شروع ${MEAL_META[k].fa}"><span>تا</span>
      <input class="time" type="time" data-set="meal.${k}.end" value="${s.meals[k].end}" aria-label="پایان ${MEAL_META[k].fa}"></div></div>`).join('');
  const lead = [15, 30, 45, 60, 90, 120].map((n) => `<option value="${n}" ${s.leadMinutes === n ? 'selected' : ''}>${fa(n)} دقیقه</option>`).join('');
  return `${banners()}
  <section class="group"><h3>یادآوری وعده‌ها</h3>
    <div class="item"><div class="t"><b>نوتیف پیش از وعده</b><small>نام تو، وعده، غذا و سلف را اعلام می‌کند.</small></div>${toggle('notify', s.notify, 'نوتیف')}</div>
    <div class="item"><div class="t"><b>چه مدت قبل؟</b></div><select class="select" data-set="leadMinutes" aria-label="زمان یادآوری">${lead}</select></div>
    ${mealRows}
    <div class="item"><div class="t"><b>آزمایش نوتیف</b><small>همین حالا یک نوتیف نمونه بفرست.</small></div><button class="btn ghost" data-act="test-push">${icon('i-bell', 'sm')} ارسال</button></div>
    ${notifNote ? `<div class="note">${esc(notifNote)}</div>` : ''}
    <div class="note">ساعت وعده‌ها در سایت کالینان ثبت نمی‌شود؛ ساعت‌های بالا را مطابق سلف خودت تنظیم کن.</div>
  </section>
  <section class="group"><h3>ظاهر</h3>
    <div class="item"><div class="t"><b>پوسته</b></div><div class="seg" role="group" aria-label="پوسته">
      ${[['auto', 'خودکار'], ['light', 'روشن'], ['dark', 'تیره']].map(([k, l]) => `<button data-act="theme" data-v="${k}" class="${t === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    ${S.installEvt ? `<div class="item"><div class="t"><b>نصب برنامه</b><small>روی صفحهٔ اصلی گوشی یا رایانه</small></div><button class="btn ghost" data-act="install">نصب</button></div>` : ''}
  </section>
  <section class="group"><h3>حساب</h3>
    <div class="item"><div class="t"><b>${api.isDemo ? 'حالت دمو' : S.data?.session?.state === 'expired' ? 'نشست منقضی شده' : 'متصل به کالینان'}</b><small>${esc(S.data?.user?.name || '')}${S.data?.refreshMinutes ? ` · به‌روزرسانی خودکار هر ${fa(S.data.refreshMinutes)} دقیقه` : ''}</small></div>
      ${api.isDemo ? '' : `<button class="btn ghost" data-act="relogin">ورود دوباره</button>`}</div>
    <div class="item"><div class="t"><b>${api.isDemo ? 'خروج از دمو' : 'خروج و حذف اطلاعات'}</b><small>${api.isDemo ? 'برگشت به صفحهٔ شروع' : 'نشست و همهٔ داده‌ها از سرور و این دستگاه پاک می‌شود.'}</small></div><button class="btn danger" data-act="logout">${api.isDemo ? 'خروج' : 'حذف'}</button></div>
    <div class="note">${icon('i-shield', 'sm')} رمز عبور تو هرگز ذخیره نمی‌شود. فقط خواندن انجام می‌شود؛ کالینون هیچ رزرو یا تغییری در حساب تو نمی‌دهد.</div>
  </section>
  <p class="foot">کالینون · نسخهٔ ${esc(CFG.version)}</p>`;
}

function viewOnboarding() {
  const saved = prefs.get().loginUrl || '';
  const demo = api.demoCapable;
  return `<div class="onb view">
    <img class="logo" src="icons/icon-192.png" alt="کالینون" width="92" height="92">
    <h1>رزروهای غذایت،<br>همیشه جلوی چشمت</h1>
    <p class="lead">یک‌بار وارد کالینان شو؛ از این به بعد همین‌جا ببین چه غذایی، کجا و کِی داری. پیش از هر وعده هم خبرت می‌کنم.</p>
    ${demo ? `<div class="banner info">${icon('i-alert')}<div><b>نسخهٔ دمو</b><br>سرور تنظیم نشده؛ می‌توانی رابط را با داده‌های نمونه امتحان کنی.</div></div>` : `
    <ol class="steps"><li>آدرس صفحهٔ ورود کالینان دانشگاهت را اینجا بگذار.</li><li>در همان صفحه (که از طریق کالینون باز می‌شود) وارد شو.</li><li>تمام! دیگر لازم نیست دوباره وارد شوی.</li></ol>
    <form id="onbForm" novalidate>
      <div class="field"><label for="loginUrl">آدرس صفحهٔ ورود کالینان</label>
        <input id="loginUrl" name="loginUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://food.example.ac.ir/Login.aspx" value="${esc(saved)}" required>
        ${S.onb.error ? `<small class="err" role="alert">${esc(S.onb.error)}</small>` : '<small>همان آدرسی که در مرورگر برای ورود به سامانهٔ تغذیه باز می‌کنی.</small>'}</div>
      <details class="adv"><summary>تنظیمات پیشرفته</summary>
        <div class="field"><label for="resUrl">آدرس صفحهٔ «خرید هفتگی غذا» (اختیاری)</label>
        <input id="resUrl" name="resUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://food.example.ac.ir/Reservation/Reservation.aspx"><small>فقط اگر ورود انجام شد ولی برنامه نتوانست صفحه را پیدا کند.</small></div></details>
      <button class="btn block" type="submit" ${S.onb.busy ? 'disabled' : ''}>${icon('i-lock', 'sm')} ${S.onb.busy ? 'در حال آماده‌سازی…' : 'ورود به کالینان'}</button>
    </form>`}
    ${demo ? `<button class="btn block" data-act="demo">${icon('i-sun', 'sm')} ورود به نسخهٔ دمو</button>` : ''}
    <div class="trust">${icon('i-shield')}<span>رمز عبورت از مرورگرت فقط به سایت کالینان می‌رسد و هیچ‌جا ذخیره نمی‌شود. فقط نشستِ ورود، رمزنگاری‌شده روی سرور نگه داشته می‌شود و می‌توانی هر زمان حذفش کنی.</span></div>
  </div>`;
}

function render() {
  const keepStrip = document.getElementById('strip')?.scrollLeft;
  const keepY = window.scrollY;
  if (S.view === 'onboarding') {
    root.innerHTML = viewOnboarding();
  } else {
    const d = S.data;
    const first = firstName(d?.user?.name);
    const titles = {
      today: [first ? `سلام ${first} 👋` : 'سلام 👋', relDay(tehranIso()) ? `${new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'full', timeZone: 'Asia/Tehran' }).format(new Date())}` : ''],
      week: ['برنامهٔ هفتگی', 'رزروهای هفته‌های مختلف'],
      settings: ['تنظیمات', 'یادآوری، ظاهر و حساب'],
    };
    const inner = S.loading && !d ? skeleton() : S.view === 'week' ? viewWeek() : S.view === 'settings' ? viewSettings() : viewToday();
    root.innerHTML = chrome(inner, ...titles[S.view]);
  }
  const strip = document.getElementById('strip');
  if (strip) {
    if (keepStrip != null) strip.scrollLeft = keepStrip;
    else strip.querySelector('.sel')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
  if (keepY) window.scrollTo(0, keepY);
}

/* ============================================================ data */

async function loadState({ silent = false } = {}) {
  try {
    S.data = await api.state();
    S.lastLoad = Date.now();
    S.online = true;
    if (!S.data.snapshot && S.data.session?.state === 'ok' && S.pollTries < 20) {
      S.pollTries++;
      setTimeout(() => loadState({ silent: true }), 2000);
    } else if (S.data.snapshot) S.pollTries = 0;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await api.logout();
      S.data = null;
      S.view = 'onboarding';
      S.onb.error = 'نشست شما پایان یافته است؛ لطفاً دوباره وارد شوید.';
    } else if (e instanceof ApiError && e.status === 0) {
      S.online = false;
      if (!silent) toast('اتصال به سرور برقرار نشد؛ آخرین داده نمایش داده می‌شود.');
    }
  }
  S.loading = false;
  render();
}

async function manualRefresh() {
  if (S.refreshing) return;
  S.refreshing = true;
  render();
  try {
    S.data = await api.refresh();
    toast('اطلاعات به‌روز شد');
  } catch (e) {
    if (e.status === 409) { await loadState({ silent: true }); toast('نشست منقضی شده؛ دوباره وارد شوید.'); }
    else if (e.status === 429) toast('چند لحظه صبر کن و دوباره امتحان کن.');
    else toast('به‌روزرسانی انجام نشد.');
  }
  S.refreshing = false;
  render();
}

/* ============================================================ login flow */

function normalizeUrl(v) {
  let s = String(v || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null;
  } catch { return null; }
}

async function startLogin(loginUrl, resUrl) {
  S.onb.busy = true; S.onb.error = '';
  if (S.view === 'onboarding') render();
  try {
    prefs.set({ loginUrl });
    const { proxyUrl } = await api.start(loginUrl, resUrl || undefined);
    location.assign(proxyUrl); // the proxy sends us back here with #claim=… after a successful login
  } catch (e) {
    S.onb.busy = false;
    const m = { 403: 'این آدرس مجاز نیست. فقط سایت‌های تعریف‌شده در سرور پشتیبانی می‌شوند.', 400: 'آدرس معتبر نیست.', 429: 'درخواست‌ها زیاد بود؛ چند دقیقه بعد دوباره امتحان کن.', 0: 'اتصال به سرور برقرار نشد.' }[e.status] || 'شروع ورود ممکن نشد.';
    if (e.code === 'capacity_reached') S.onb.error = 'ظرفیت سرور تکمیل است.';
    else S.onb.error = m;
    if (S.view === 'onboarding') render(); else toast(S.onb.error);
  }
}

async function finishClaim(code) {
  S.view = 'today'; S.loading = true; render();
  try {
    await api.claim(code);
    toast('ورود انجام شد ✅');
    await loadState();
  } catch {
    S.view = 'onboarding';
    S.onb.error = 'ورود کامل نشد یا لینک منقضی شده بود. دوباره تلاش کن.';
    S.loading = false;
    render();
  }
}

/* ============================================================ notifications */

const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

async function localNotification() {
  const reg = await navigator.serviceWorker.ready;
  const nm = nextMeal(allDays(), settings(), Date.now());
  const first = firstName(S.data?.user?.name) || 'دوست من';
  const meta = nm ? MEAL_META[nm.key] : MEAL_META.lunch;
  const mins = nm ? Math.max(0, Math.round((nm.start - Date.now()) / 60000)) : settings().leadMinutes;
  await reg.showNotification(`${first} جان، ${meta.fa} ${mins > 1 ? `تا ${fa(mins)} دقیقه دیگر` : 'همین الان'}`, {
    body: `${nm?.m.food?.name || 'چلو خورشت قیمه'} — ${nm?.m.self?.name || 'سلف مرکزی'}\nساعت ${hhmm(settings().meals[nm?.key || 'lunch'].start)}`,
    icon: './icons/icon-192.png', dir: 'rtl', lang: 'fa', tag: 'cullinon-test', data: { url: './' },
  });
}

async function enablePush() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) { toast('این مرورگر از نوتیف پشتیبانی نمی‌کند.'); return false; }
  if (isIOS && !isStandalone()) { toast('ابتدا برنامه را به صفحهٔ اصلی اضافه کنید.'); return false; }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('اجازهٔ نوتیف داده نشد.'); return false; }
  if (api.isDemo) return true;
  try {
    const { vapidPublicKey } = await api.config();
    if (!vapidPublicKey) { toast('سرور برای ارسال نوتیف تنظیم نشده است.'); return false; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(vapidPublicKey) }));
    await api.pushSubscribe(sub.toJSON());
    return true;
  } catch {
    toast('فعال‌سازی نوتیف انجام نشد. اتصال یا مجوزها را بررسی کن.');
    return false;
  }
}

let saveTimer;
function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await api.saveSettings(S.data.settings); toast('ذخیره شد'); }
    catch (e) { toast(e.status === 400 ? 'مقدار واردشده معتبر نیست.' : 'ذخیره نشد.'); await loadState({ silent: true }); }
  }, 450);
}

async function onSetting(el) {
  const key = el.dataset.set;
  const s = S.data.settings;
  if (key === 'notify') {
    if (el.checked && !(await enablePush())) { el.checked = false; return; }
    s.notify = el.checked;
  } else if (key === 'leadMinutes') s.leadMinutes = Number(el.value);
  else {
    const [, meal, field] = key.split('.');
    if (field === 'on') s.meals[meal].on = el.checked;
    else {
      if (!/^\d\d:\d\d$/.test(el.value)) return;
      s.meals[meal][field] = el.value;
      if (s.meals[meal].end <= s.meals[meal].start) { toast('پایان وعده باید بعد از شروع باشد.'); return loadState({ silent: true }); }
    }
  }
  queueSave();
}

/* ============================================================ actions */

async function openSite() {
  if (api.isDemo) {
    toast('در حالت واقعی، این دکمه سایت کالینان را با نشست فعلی تو باز می‌کند.');
    const u = prefs.get().loginUrl;
    if (u) window.open(u, '_blank', 'noopener');
    return;
  }
  const w = window.open('', '_blank'); // opened synchronously so popup blockers allow it
  try { if (w) w.opener = null; } catch { /* ignore */ }
  const fab = document.querySelector('.fab');
  fab?.classList.add('loading');
  try {
    const { url } = await api.siteLink();
    if (w) w.location.href = url; else location.assign(url);
  } catch {
    w?.close();
    toast('باز کردن سایت کالینان ممکن نشد.');
  }
  fab?.classList.remove('loading');
}

root.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'nav') { S.view = el.dataset.v; render(); window.scrollTo(0, 0); }
  else if (act === 'day') { S.selIso = el.dataset.iso; render(); }
  else if (act === 'pick-day') { S.selIso = el.dataset.iso; S.view = 'today'; render(); window.scrollTo(0, 0); }
  else if (act === 'week') { S.weekIdx = Math.min(weeks().length - 1, Math.max(0, S.weekIdx + Number(el.dataset.d))); render(); }
  else if (act === 'refresh') manualRefresh();
  else if (act === 'site') openSite();
  else if (act === 'theme') { prefs.set({ theme: el.dataset.v }); applyTheme(); render(); }
  else if (act === 'install') { S.installEvt?.prompt(); S.installEvt = null; render(); }
  else if (act === 'demo') { api.startDemo(); S.view = 'today'; S.loading = true; render(); await loadState(); }
  else if (act === 'relogin') {
    const url = normalizeUrl(prefs.get().loginUrl) || S.data?.siteOrigin;
    if (url) startLogin(url); else { S.view = 'onboarding'; render(); }
  } else if (act === 'logout') {
    if (!confirm(api.isDemo ? 'از حالت دمو خارج می‌شوی؟' : 'نشست و همهٔ اطلاعات تو حذف شود؟')) return;
    await api.logout();
    S.data = null; S.view = 'onboarding'; S.onb = { error: '', busy: false };
    render();
  } else if (act === 'test-push') {
    try {
      if (!(await enablePush())) return;
      if (api.isDemo) { await localNotification(); toast('نوتیف نمونه ارسال شد'); return; }
      const r = await api.pushTest();
      toast(r.delivered > 0 ? 'نوتیف ارسال شد؛ چند ثانیه صبر کن.' : 'ارسال نشد. ابتدا نوتیف را فعال کن.');
    } catch { toast('ارسال نوتیف ناموفق بود.'); }
  }
});

root.addEventListener('change', (e) => { const el = e.target.closest('[data-set]'); if (el && S.data) onSetting(el); });

root.addEventListener('submit', (e) => {
  if (e.target.id !== 'onbForm') return;
  e.preventDefault();
  const url = normalizeUrl(e.target.loginUrl.value);
  if (!url) { S.onb.error = 'آدرس معتبر نیست؛ مثل https://food.university.ac.ir/Login.aspx'; render(); return; }
  const res = e.target.resUrl.value.trim();
  startLogin(url, res ? normalizeUrl(res) : null);
});

/* ============================================================ lifecycle */

function tick() {
  const el = document.querySelector('[data-cd]');
  if (!el || S.view !== 'today') return;
  const now = Date.now();
  const nm = nextMeal(allDays(), settings(), now);
  const key = nm ? `${nm.day.iso}:${nm.key}:${nm.state}` : '';
  if (key !== S.heroKey) { render(); return; }
  if (nm.state === 'reserved') el.textContent = fmtIn(nm.start - now);
}

window.addEventListener('online', () => { S.online = true; loadState({ silent: true }); });
window.addEventListener('offline', () => { S.online = false; render(); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; if (S.view === 'settings') render(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && api.hasSession && Date.now() - S.lastLoad > 30_000) loadState({ silent: true });
});
setInterval(() => { if (document.visibilityState === 'visible' && api.hasSession && !S.refreshing) loadState({ silent: true }); }, 60_000);
setInterval(tick, 20_000);

async function init() {
  applyTheme();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  const claim = /^#claim=([\w-]{16,64})$/.exec(location.hash);
  if (claim) {
    history.replaceState(null, '', location.pathname + location.search); // never leave the one-time code in history
    return finishClaim(claim[1]);
  }
  if (!api.hasSession) { S.view = 'onboarding'; return render(); }
  const cached = api.cached();
  if (cached) { S.data = cached; S.loading = false; }
  render();
  await loadState({ silent: true });
}

init();
