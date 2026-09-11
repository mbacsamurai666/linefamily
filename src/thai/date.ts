import { DateTime } from 'luxon';
import { normalizeThaiDigits, parseThaiNumber } from './number.js';

/**
 * Thai date/time expression parser.
 *
 * The date part and the time part are matched independently and then combined,
 * because people write them in either order and often supply only one
 * ("พรุ่งนี้" with no time, "บ่ายสาม" with no date).
 *
 * `matched` carries the exact substrings consumed so the caller can strip them
 * from the message and use whatever is left as the title.
 */
export interface ThaiDateTimeMatch {
  start: DateTime;
  /** True when a date was given with no time of day. */
  allDay: boolean;
  matched: string[];
  /**
   * False when only a clock time matched and the date was defaulted to
   * "today or tomorrow, whichever is next" rather than named explicitly.
   * A message like "บ่าย 3 ไปหาหมอ" (no date word at all — and the same
   * gap shows up when a date word is misspelled and silently fails to
   * match, e.g. "พรุ้งนี้" instead of "พรุ่งนี้") is genuinely ambiguous
   * about which day is meant; callers should treat that guess as lower
   * confidence than a message where a date was actually named.
   */
  hasExplicitDate: boolean;
}

// ------------------------------------------------------------------ tables

const WEEKDAYS: Record<string, number> = {
  จันทร์: 1,
  อังคาร: 2,
  พุธ: 3,
  พฤหัสบดี: 4,
  พฤหัส: 4,
  ศุกร์: 5,
  เสาร์: 6,
  อาทิตย์: 7,
};

const MONTHS: Record<string, number> = {
  มกราคม: 1, 'ม.ค.': 1, มค: 1, มกรา: 1,
  กุมภาพันธ์: 2, 'ก.พ.': 2, กพ: 2, กุมภา: 2,
  มีนาคม: 3, 'มี.ค.': 3, มีค: 3, มีนา: 3,
  เมษายน: 4, 'เม.ย.': 4, เมย: 4, เมษา: 4,
  พฤษภาคม: 5, 'พ.ค.': 5, พค: 5, พฤษภา: 5,
  มิถุนายน: 6, 'มิ.ย.': 6, มิย: 6, มิถุนา: 6,
  กรกฎาคม: 7, 'ก.ค.': 7, กค: 7, กรกฎา: 7,
  สิงหาคม: 8, 'ส.ค.': 8, สค: 8, สิงหา: 8,
  กันยายน: 9, 'ก.ย.': 9, กย: 9, กันยา: 9,
  ตุลาคม: 10, 'ต.ค.': 10, ตค: 10, ตุลา: 10,
  พฤศจิกายน: 11, 'พ.ย.': 11, พย: 11, พฤศจิกา: 11,
  ธันวาคม: 12, 'ธ.ค.': 12, ธค: 12, ธันวา: 12,
};

/** Spelled-out numerals that can appear in a clock time, longest-first. */
const NUM = '\\d{1,2}|สิบสอง|สิบเอ็ด|สิบ|หนึ่ง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า';

/** Longest-first so "พฤหัสบดี" wins over "พฤหัส". */
function alternation(keys: string[]): string {
  return [...keys]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

const WEEKDAY_ALT = alternation(Object.keys(WEEKDAYS));
const MONTH_ALT = alternation(Object.keys(MONTHS));

// ------------------------------------------------------------------ years

/**
 * Thai text mixes Buddhist and Gregorian years, in both 4- and 2-digit forms.
 * 2569 -> 2026, 69 -> 2026, 26 -> 2026, 2026 -> 2026.
 */
export function toGregorianYear(year: number): number {
  if (year >= 2400) return year - 543;
  if (year >= 100) return year;
  // Two-digit: >=50 reads as a short Buddhist year, below that as short CE.
  return year >= 50 ? 2500 + year - 543 : 2000 + year;
}

// ------------------------------------------------------------------ time

interface TimeMatch {
  hour: number;
  minute: number;
  text: string;
}

function num(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  return parseThaiNumber(raw);
}

/**
 * Spoken Thai clock times. Ordered most-specific first — "เที่ยงคืน" must be
 * tried before "เที่ยง", and "บ่ายโมง" before the generic "บ่าย N".
 */
function matchTime(text: string): TimeMatch | null {
  const half = '(ครึ่ง)?';

  const rules: Array<[RegExp, (m: RegExpMatchArray) => { hour: number; minute: number } | null]> = [
    [/เที่ยงคืน/, () => ({ hour: 0, minute: 0 })],
    [new RegExp(`เที่ยง(?:วัน)?${half}`), (m) => ({ hour: 12, minute: m[1] ? 30 : 0 })],

    // ตี 1-5 -> 01:00-05:00
    [new RegExp(`ตี\\s?(${NUM})${half}`), (m) => {
      const n = num(m[1]);
      return n !== null && n >= 1 && n <= 5 ? { hour: n, minute: m[2] ? 30 : 0 } : null;
    }],

    // N ทุ่ม -> 19:00-24:00
    [new RegExp(`(${NUM})\\s?ทุ่ม${half}`), (m) => {
      const n = num(m[1]);
      return n !== null && n >= 1 && n <= 6 ? { hour: 18 + n, minute: m[2] ? 30 : 0 } : null;
    }],

    [new RegExp(`บ่ายโมง${half}`), (m) => ({ hour: 13, minute: m[1] ? 30 : 0 })],

    // บ่าย 1-4 -> 13:00-16:00
    [new RegExp(`บ่าย\\s?(${NUM})(?:\\s?โมง)?${half}`), (m) => {
      const n = num(m[1]);
      return n !== null && n >= 1 && n <= 4 ? { hour: 12 + n, minute: m[2] ? 30 : 0 } : null;
    }],

    // N โมงเย็น -> 16:00-18:00
    [new RegExp(`(${NUM})\\s?โมงเย็น${half}`), (m) => {
      const n = num(m[1]);
      return n !== null && n >= 4 && n <= 6 ? { hour: 12 + n, minute: m[2] ? 30 : 0 } : null;
    }],

    // N โมงเช้า -> 06:00-11:00
    [new RegExp(`(${NUM})\\s?โมงเช้า${half}`), (m) => {
      const n = num(m[1]);
      return n !== null && n >= 6 && n <= 11 ? { hour: n, minute: m[2] ? 30 : 0 } : null;
    }],

    // A colon always means a clock time.
    [/(?<![\d.])(\d{1,2}):(\d{2})(?!\d)(?:\s?น\.?(?![ก-๛]))?/, (m) => {
      const h = Number(m[1]);
      const min = Number(m[2]);
      return h <= 23 && min <= 59 ? { hour: h, minute: min } : null;
    }],

    // A dot is only a time separator when something disambiguates it from a
    // decimal amount: either the น. marker, or an hour that cannot be money's
    // integer part in practice. Without this, "ค่าข้าว 1.50" reads as 01:50.
    [/(?<![\d.])(\d{1,2})\.(\d{2})(?!\d)\s?น\.?(?![ก-๛])/, (m) => {
      const h = Number(m[1]);
      const min = Number(m[2]);
      return h <= 23 && min <= 59 ? { hour: h, minute: min } : null;
    }],
    [/(?<![\d.])(1[3-9]|2[0-3])\.(\d{2})(?!\d)/, (m) => {
      const h = Number(m[1]);
      const min = Number(m[2]);
      return min <= 59 ? { hour: h, minute: min } : null;
    }],

    // Bare "N น." is unambiguous because of the unit marker.
    [/(?<!\d)(\d{1,2})\s?น\.(?![ก-๛])/, (m) => {
      const h = Number(m[1]);
      return h <= 23 ? { hour: h, minute: 0 } : null;
    }],

    // Bare "N โมง" with no เช้า/เย็น qualifier. Thai counts these from 6am in
    // the traditional system, so "สามโมง" is 09:00, not 15:00. Modern spoken
    // usage is genuinely split here — the confirm card is what catches a
    // wrong read, which is why guessing the traditional value is acceptable.
    [new RegExp(`(${NUM})\\s?โมง${half}`), (m) => {
      const n = num(m[1]);
      if (n === null || n > 23) return null;
      const hour = n >= 1 && n <= 5 ? 6 + n : n;
      return { hour, minute: m[2] ? 30 : 0 };
    }],
  ];

  for (const [re, resolve] of rules) {
    const m = text.match(re);
    if (!m) continue;
    const resolved = resolve(m);
    if (resolved) return { ...resolved, text: m[0] };
  }
  return null;
}

// ------------------------------------------------------------------ date

interface DateMatch {
  date: DateTime;
  text: string;
}

/** Next occurrence of a weekday, always strictly in the future. */
function nextWeekday(now: DateTime, target: number): DateTime {
  const delta = (target - now.weekday + 7) % 7;
  return now.plus({ days: delta === 0 ? 7 : delta }).startOf('day');
}

function matchDate(text: string, now: DateTime): DateMatch | null {
  const today = now.startOf('day');

  // Explicit calendar dates first — they are unambiguous, so nothing else
  // should be allowed to claim their digits.

  // "5 กันยายน 2569" / "5 ก.ย." / "5ก.ย.69"
  const named = text.match(new RegExp(`(\\d{1,2})\\s?(${MONTH_ALT})\\s?(\\d{2,4})?`));
  if (named) {
    const day = Number(named[1]);
    const month = MONTHS[named[2] as string];
    if (month !== undefined && day >= 1 && day <= 31) {
      const year = named[3] ? toGregorianYear(Number(named[3])) : today.year;
      let dt = DateTime.fromObject({ year, month, day }, { zone: now.zone });
      if (dt.isValid) {
        // A bare "5 ก.ย." that already passed means next year.
        if (!named[3] && dt < today) dt = dt.plus({ years: 1 });
        return { date: dt, text: named[0] };
      }
    }
  }

  // "5/9/2569" or "5/9"
  const slash = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const year = slash[3] ? toGregorianYear(Number(slash[3])) : today.year;
      let dt = DateTime.fromObject({ year, month, day }, { zone: now.zone });
      if (dt.isValid) {
        if (!slash[3] && dt < today) dt = dt.plus({ years: 1 });
        return { date: dt, text: slash[0] };
      }
    }
  }

  // "วันจันทร์หน้า" / "จันทร์หน้า" / "วันศุกร์นี้" — checked before the bare
  // "อาทิตย์หน้า" relative rule, which would otherwise swallow the weekday.
  const weekday = text.match(new RegExp(`(?:วัน)?(${WEEKDAY_ALT})(นี้|หน้า)?`));
  if (weekday) {
    const target = WEEKDAYS[weekday[1] as string];
    // "อาทิตย์หน้า" with no "วัน" prefix means next week, not next Sunday.
    const isBareWeekPhrase =
      weekday[1] === 'อาทิตย์' && weekday[2] === 'หน้า' && !weekday[0].startsWith('วัน');
    if (target !== undefined && !isBareWeekPhrase) {
      return { date: nextWeekday(today, target), text: weekday[0] };
    }
  }

  const relatives: Array<[RegExp, () => DateTime]> = [
    [/วันนี้/, () => today],
    [/พรุ่งนี้/, () => today.plus({ days: 1 })],
    [/มะรืน(?:นี้)?/, () => today.plus({ days: 2 })],
    [/เมื่อวาน(?:นี้)?/, () => today.minus({ days: 1 })],
    [/ต้นเดือนหน้า/, () => today.plus({ months: 1 }).startOf('month')],
    [/สิ้นเดือน(?:นี้)?/, () => today.endOf('month').startOf('day')],
    [/สิ้นปี(?:นี้)?/, () => today.endOf('year').startOf('day')],
    [/(?:สัปดาห์|อาทิตย์)หน้า/, () => today.plus({ weeks: 1 })],
    [/เดือนหน้า/, () => today.plus({ months: 1 })],
    [/ปีหน้า/, () => today.plus({ years: 1 })],
  ];

  for (const [re, resolve] of relatives) {
    const m = text.match(re);
    if (m) return { date: resolve(), text: m[0] };
  }

  return null;
}

// ------------------------------------------------------------------ combine

/**
 * Parse a Thai date and/or time out of free text.
 *
 * Returns null when neither is present — callers treat that as "this message
 * is not about a scheduled thing" rather than guessing a date.
 */
export function parseThaiDateTime(input: string, now: DateTime): ThaiDateTimeMatch | null {
  const text = normalizeThaiDigits(input);

  const timeHit = matchTime(text);
  // Never let the time regex and the date regex consume the same characters.
  const dateSource = timeHit ? text.replace(timeHit.text, ' ') : text;
  const dateHit = matchDate(dateSource, now);

  if (!timeHit && !dateHit) return null;

  const matched: string[] = [];
  if (dateHit) matched.push(dateHit.text);
  if (timeHit) matched.push(timeHit.text);

  if (!timeHit && dateHit) {
    return { start: dateHit.date, allDay: true, matched, hasExplicitDate: true };
  }

  const time = timeHit as TimeMatch;
  const base = dateHit ? dateHit.date : now.startOf('day');
  let start = base.set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });

  // A time with no date means the next time that clock reading comes around.
  if (!dateHit && start <= now) start = start.plus({ days: 1 });

  return { start, allDay: false, matched, hasExplicitDate: dateHit !== null };
}

/**
 * Strip the consumed date/time substrings to leave a usable title.
 * "พรุ่งนี้บ่าย 3 พาแม่ไปหาหมอ" -> "พาแม่ไปหาหมอ"
 */
export function stripMatched(input: string, matched: string[]): string {
  let out = normalizeThaiDigits(input);
  for (const m of matched) out = out.replace(m, ' ');
  return out.replace(/\s+/g, ' ').trim();
}
