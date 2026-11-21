// Demo data: lets the whole UI (and local test notifications) work without any backend.
import { DEFAULT_SETTINGS, WEEKDAYS, addDaysIso, instant, isoToJalaliKey, tehranIso } from './util.js';

const FOODS = {
  breakfast: [['پنیر خیار گوجه', 100000], ['کره مربا', 100000], ['حلوا ارده', 100000], ['تخم مرغ آب پز', 100000]],
  lunch: [['چلو خورشت قیمه', 250000], ['چلو کباب کوبیده', 350000], ['چلو خورشت سبزی', 250000], ['پیتزا مخصوص', 350000], ['زرشک پلو با مرغ', 250000]],
  dinner: [['خوراک مرغ', 250000], ['همبرگر', 250000], ['خوراک فیله و قارچ', 250000], ['خوراک کوبیده مرغ', 250000]],
};
const SELFS = ['شرقی', 'مهرنگار', 'مستر بابی'];
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export function buildDemoSnapshot(now = Date.now(), settings = DEFAULT_SETTINGS) {
  const today = tehranIso(new Date(now));
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const weekStart = addDaysIso(today, -((dow + 1) % 7)); // Saturday
  const weeks = [];
  for (const offset of [-1, 0, 1, 2]) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const iso = addDaysIso(weekStart, offset * 7 + i);
      const date = isoToJalaliKey(iso);
      const meals = {};
      for (const key of ['breakfast', 'lunch', 'dinner']) {
        if (i >= 5) { meals[key] = { hasMenu: false, reserved: false, editable: false, status: 'none', food: null, self: null, count: 0, calories: 0, paidRial: 0 }; continue; }
        const h = hash(iso + key);
        const [name, price] = FOODS[key][h % FOODS[key].length];
        const self = { id: String(h % 3), name: SELFS[(h >> 3) % 3] };
        const end = instant(iso, settings.meals[key].end);
        const past = end < now;
        const isNear = iso === today || iso === addDaysIso(today, 1);
        const wantReserved = key === 'breakfast' ? h % 4 === 0 : isNear || h % 5 < 3;
        let status;
        if (wantReserved) status = past ? (h % 6 === 0 ? 'reserved' : 'eaten') : 'reserved';
        else status = past || iso < today ? 'closed' : 'open';
        meals[key] = {
          hasMenu: true, reserved: wantReserved, editable: iso > today, status, statusText: null,
          eatenAt: status === 'eaten' ? '13:05:12' : null,
          self, food: { id: String(h), name, priceRial: price }, count: 1, calories: 0, paidRial: wantReserved ? price : 0,
        };
      }
      days.push({ weekday: WEEKDAYS[i], date, label: `${WEEKDAYS[i]} ${date}`, iso, meals });
    }
    weeks.push({ offset, label: `${days[0].date} الی ${days[6].date}`, from: days[0].date, to: days[6].date, days });
  }
  return { fetchedAt: now, user: { name: 'رضا محمدی', credit: 1200000, cafeteriaCredit: 0 }, weeks };
}
