/**
 * Thai repeat phrases -> RFC 5545 RRULE.
 *
 * Only the shapes a family actually says out loud are here. Anything more
 * elaborate ("ทุกวันจันทร์เว้นจันทร์") is left unmatched on purpose: a repeat
 * rule that is guessed wrong quietly fills the calendar with appointments
 * nobody asked for, which is worse than not matching at all.
 */

export interface RecurrenceMatch {
  /** The RRULE body, without the "RRULE:" prefix. */
  rrule: string;
  /** The exact substring consumed, so the caller can strip it from the title. */
  matched: string;
}

const WEEKDAY_CODE: Record<string, string> = {
  จันทร์: 'MO',
  อังคาร: 'TU',
  พุธ: 'WE',
  พฤหัสบดี: 'TH',
  พฤหัส: 'TH',
  ศุกร์: 'FR',
  เสาร์: 'SA',
  อาทิตย์: 'SU',
};

const WEEKDAY_ALT = Object.keys(WEEKDAY_CODE)
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * "อาทิตย์" is left out of the bare form on purpose: "ทุกอาทิตย์" is every
 * week, while "ทุกวันอาทิตย์" is every Sunday — the same trap thai/date.ts
 * handles for "อาทิตย์หน้า".
 */
const BARE_WEEKDAY_ALT = Object.keys(WEEKDAY_CODE)
  .filter((day) => day !== 'อาทิตย์')
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * Ordered most-specific first. "ทุกวันอาทิตย์" is every Sunday, while a bare
 * "ทุกอาทิตย์" is every week — so the weekday forms have to be tried before
 * the plain weekly one.
 */
const RULES: Array<[RegExp, (m: RegExpMatchArray) => string | null]> = [
  [new RegExp(`ทุก\\s?วัน(${WEEKDAY_ALT})`), (m) => `FREQ=WEEKLY;BYDAY=${WEEKDAY_CODE[m[1] as string]}`],
  [
    new RegExp(`ทุก\\s?(${BARE_WEEKDAY_ALT})`),
    (m) => `FREQ=WEEKLY;BYDAY=${WEEKDAY_CODE[m[1] as string]}`,
  ],
  [
    /ทุก\s?วันที่\s*(\d{1,2})/,
    (m) => {
      const day = Number(m[1]);
      return day >= 1 && day <= 31 ? `FREQ=MONTHLY;BYMONTHDAY=${day}` : null;
    },
  ],
  [/ทุก\s?วัน(?!ที่)/, () => 'FREQ=DAILY'],
  [/ทุก\s?(?:สัปดาห์|อาทิตย์)/, () => 'FREQ=WEEKLY'],
  [/ทุก\s?เดือน/, () => 'FREQ=MONTHLY'],
  [/ทุก\s?ปี/, () => 'FREQ=YEARLY'],
];

export function matchRecurrence(text: string): RecurrenceMatch | null {
  for (const [re, build] of RULES) {
    const m = text.match(re);
    if (!m) continue;
    const rrule = build(m);
    if (rrule) return { rrule, matched: m[0] };
  }
  return null;
}

const LABEL: Array<[RegExp, string]> = [
  [/FREQ=DAILY/, 'ทุกวัน'],
  [/FREQ=WEEKLY;BYDAY=MO/, 'ทุกวันจันทร์'],
  [/FREQ=WEEKLY;BYDAY=TU/, 'ทุกวันอังคาร'],
  [/FREQ=WEEKLY;BYDAY=WE/, 'ทุกวันพุธ'],
  [/FREQ=WEEKLY;BYDAY=TH/, 'ทุกวันพฤหัสบดี'],
  [/FREQ=WEEKLY;BYDAY=FR/, 'ทุกวันศุกร์'],
  [/FREQ=WEEKLY;BYDAY=SA/, 'ทุกวันเสาร์'],
  [/FREQ=WEEKLY;BYDAY=SU/, 'ทุกวันอาทิตย์'],
  [/FREQ=WEEKLY/, 'ทุกสัปดาห์'],
  [/FREQ=MONTHLY;BYMONTHDAY=(\d{1,2})/, 'ทุกวันที่ $1'],
  [/FREQ=MONTHLY/, 'ทุกเดือน'],
  [/FREQ=YEARLY/, 'ทุกปี'],
];

/** Back to Thai, for the confirm card and the reminder text. */
export function recurrenceLabel(rrule: string): string {
  for (const [re, label] of LABEL) {
    const m = rrule.match(re);
    if (m) return label.replace('$1', m[1] ?? '');
  }
  return 'ซ้ำ';
}
