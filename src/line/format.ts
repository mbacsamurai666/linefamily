import type { DateTime } from 'luxon';

/**
 * Thai display formatting. Dates are shown in พ.ศ. because that is what people
 * read on every other Thai document; storage stays Gregorian throughout.
 */

const THAI_DAYS = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];

const THAI_MONTHS = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

export function toBuddhistYear(gregorian: number): number {
  return gregorian + 543;
}

/** "พฤ. 5 ก.ย. 69" — short year, the way a Thai calendar prints it. */
export function formatThaiDate(dt: DateTime): string {
  const day = THAI_DAYS[dt.weekday - 1] ?? '';
  const month = THAI_MONTHS[dt.month - 1] ?? '';
  const shortYear = String(toBuddhistYear(dt.year)).slice(-2);
  return `${day} ${dt.day} ${month} ${shortYear}`;
}

export function formatThaiTime(dt: DateTime): string {
  return `${dt.toFormat('HH:mm')} น.`;
}

export function formatThaiDateTime(dt: DateTime, allDay: boolean): string {
  return allDay ? formatThaiDate(dt) : `${formatThaiDate(dt)} ${formatThaiTime(dt)}`;
}

/**
 * An appointment's when, spans included: "พฤ. 1 ต.ค. 69 – พ. 7 ต.ค. 69".
 * An all-day span's end is its last day, inclusive.
 */
export function formatThaiSpan(start: DateTime, end: DateTime | null | undefined, allDay: boolean): string {
  const first = formatThaiDateTime(start, allDay);
  if (!end || end.hasSame(start, 'day')) return first;
  return `${first} – ${formatThaiDateTime(end, allDay)}`;
}

/** "อีก 2 วัน" / "วันนี้" / "พรุ่งนี้" — the relative hint used in digests. */
export function formatRelativeDay(target: DateTime, now: DateTime): string {
  const days = Math.round(target.startOf('day').diff(now.startOf('day'), 'days').days);
  if (days === 0) return 'วันนี้';
  if (days === 1) return 'พรุ่งนี้';
  if (days === 2) return 'มะรืนนี้';
  if (days < 0) return `เลยมา ${Math.abs(days)} วัน`;
  return `อีก ${days} วัน`;
}
