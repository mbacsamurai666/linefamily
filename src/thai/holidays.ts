import type { DateTime } from 'luxon';
import holidays from './holidays.json' with { type: 'json' };

/**
 * Thai public holidays, for "วันทำการถัดไป".
 *
 * Only the dates that fall on the same day every year are shipped. The
 * Buddhist ones (มาฆบูชา, วิสาขบูชา, อาสาฬหบูชา, เข้าพรรษา) follow the lunar
 * calendar and the substitution days are announced by cabinet resolution each
 * year — guessing those would put a wrong date in front of someone who
 * trusted it, so they live in `extra` and are filled in per year from the
 * official announcement:
 *
 *   "extra": { "2027": [{ "month": 3, "day": 2, "name": "มาฆบูชา" }] }
 */

interface HolidayEntry {
  month: number;
  day: number;
  name: string;
}

const FIXED = holidays.fixed as HolidayEntry[];
const EXTRA = holidays.extra as Record<string, HolidayEntry[] | undefined>;

/** The holiday falling on `date`, or null. Weekends are not holidays here. */
export function holidayOn(date: DateTime): string | null {
  const fixed = FIXED.find((h) => h.month === date.month && h.day === date.day);
  if (fixed) return fixed.name;

  const extra = EXTRA[String(date.year)]?.find(
    (h) => h.month === date.month && h.day === date.day,
  );
  return extra?.name ?? null;
}

/**
 * Whether anyone has filled in `year`'s announced holidays. Without them the
 * app still works — it just treats มาฆบูชา as a working day — so this is what
 * lets `สถานะระบบ` say so, instead of the gap only surfacing when someone's
 * "next working day" lands on a closed office.
 */
export function announcedHolidaysKnown(year: number): boolean {
  return (EXTRA[String(year)]?.length ?? 0) > 0;
}

/** Saturday, Sunday, or a public holiday. */
export function isNonWorkingDay(date: DateTime): boolean {
  return date.weekday >= 6 || holidayOn(date) !== null;
}

/**
 * The next day the offices are open, starting the day after `date`. Capped so
 * a mistake in the holiday table can never spin forever.
 */
export function nextBusinessDay(date: DateTime): DateTime {
  let candidate = date.plus({ days: 1 }).startOf('day');
  for (let i = 0; i < 14 && isNonWorkingDay(candidate); i++) {
    candidate = candidate.plus({ days: 1 });
  }
  return candidate;
}
