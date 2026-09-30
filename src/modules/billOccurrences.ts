import { DateTime } from 'luxon';

/**
 * Where a recurring money item falls: every due date of a bill between two
 * days, with the amount that applies on each.
 *
 * This is the one place the family's money calendar is laid out. The
 * calendar, the projection, the reserve pots, the reminders and the chat all
 * read occurrences from here rather than from rows of their own, so a bill is
 * never written twice and a change to it is seen everywhere at once.
 */

export type BillFrequency = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

/** Just what laying out a bill needs — a Prisma Bill row satisfies it. */
export interface BillShape {
  id: string;
  amount: number | null;
  estimateAmount: number | null;
  dueDay: number;
  everyMonths: number;
  dueMonth: number | null;
  frequency: BillFrequency;
  interval: number;
  startsOn: Date | null;
  endsOn: Date | null;
  /** Amount changes over time, any order. */
  amounts?: Array<{ effectiveFrom: Date; amount: number }>;
}

export interface Occurrence {
  /** Start of the due day, in the family's zone. */
  dueOn: DateTime;
  /** Satang, or null when the bill has neither an amount nor an estimate. */
  amount: number | null;
  /** The amount is the family's own guess, not a fixed charge. */
  estimated: boolean;
}

/** More than a daily bill can produce in a year, so a bad input cannot run away. */
const MAX_OCCURRENCES = 800;

/** The day a stored @db.Date column means, read in the family's zone. */
export function dateOnly(value: Date, zone: string): DateTime {
  // A DATE comes back as UTC midnight; its calendar day is the day meant.
  const utc = DateTime.fromJSDate(value, { zone: 'utc' });
  return DateTime.fromObject({ year: utc.year, month: utc.month, day: utc.day }, { zone });
}

/** Store a calendar day as a @db.Date column holds it: that day at UTC midnight. */
export function toDateColumn(day: DateTime): Date {
  return new Date(Date.UTC(day.year, day.month - 1, day.day));
}

/** Months since year 0, so a cycle of any length has a fixed starting point. */
const monthIndex = (dt: DateTime) => dt.year * 12 + (dt.month - 1);

/**
 * The amount due on a given day: the latest change on or before it, else the
 * bill's own amount, else the family's estimate.
 */
export function amountOn(bill: BillShape, day: DateTime, zone: string): { amount: number | null; estimated: boolean } {
  let best: { from: DateTime; amount: number } | null = null;
  for (const change of bill.amounts ?? []) {
    const from = dateOnly(change.effectiveFrom, zone);
    if (from <= day && (!best || from > best.from)) best = { from, amount: change.amount };
  }
  if (best) return { amount: best.amount, estimated: false };
  if (bill.amount !== null) return { amount: bill.amount, estimated: false };
  if (bill.estimateAmount !== null) return { amount: bill.estimateAmount, estimated: true };
  return { amount: null, estimated: false };
}

/** Every due date of `bill` from `from` to `to`, both inclusive, oldest first. */
export function billOccurrences(bill: BillShape, from: DateTime, to: DateTime, zone: string): Occurrence[] {
  const first = from.setZone(zone).startOf('day');
  const last = to.setZone(zone).startOf('day');
  const starts = bill.startsOn ? dateOnly(bill.startsOn, zone) : null;
  const ends = bill.endsOn ? dateOnly(bill.endsOn, zone) : null;
  const lo = starts && starts > first ? starts : first;
  const hi = ends && ends < last ? ends : last;
  if (hi < lo) return [];

  const days: DateTime[] = [];
  const step = Math.max(1, Math.floor(bill.interval || 1));

  switch (bill.frequency) {
    case 'ONCE': {
      if (starts && starts >= lo && starts <= hi) days.push(starts);
      break;
    }
    case 'DAILY':
    case 'WEEKLY': {
      // Counted from its own first day, so the rhythm holds whatever window is asked for.
      const anchor = starts ?? lo;
      const stepDays = bill.frequency === 'DAILY' ? step : step * 7;
      const skipped = Math.max(0, Math.ceil(lo.diff(anchor, 'days').days / stepDays));
      for (let d = anchor.plus({ days: skipped * stepDays }); d <= hi && days.length < MAX_OCCURRENCES; d = d.plus({ days: stepDays })) {
        if (d >= lo) days.push(d);
      }
      break;
    }
    case 'MONTHLY': {
      const every = Math.max(1, Math.floor(bill.everyMonths || 1));
      // The cycle counts from its first month — the start date if there is
      // one, else the month it was said to fall in (car insurance "every
      // March"), else January. Only matters when it is not every month.
      const anchor = starts ? monthIndex(starts) : (bill.dueMonth ?? 1) - 1;
      for (let m = lo.startOf('month'); m <= hi && days.length < MAX_OCCURRENCES; m = m.plus({ months: 1 })) {
        if ((((monthIndex(m) - anchor) % every) + every) % every !== 0) continue;
        // "Due on the 31st" still lands in February: on its last day.
        const day = m.set({ day: Math.min(bill.dueDay, m.daysInMonth ?? 28) });
        if (day >= lo && day <= hi) days.push(day);
      }
      break;
    }
  }

  return days.map((dueOn) => ({ dueOn, ...amountOn(bill, dueOn, zone) }));
}

/** How many times a year the bill comes round, for spreading it evenly. */
export function timesPerYear(bill: BillShape): number {
  switch (bill.frequency) {
    case 'ONCE':
      return 0;
    case 'DAILY':
      return 365 / Math.max(1, bill.interval);
    case 'WEEKLY':
      return 52 / Math.max(1, bill.interval);
    case 'MONTHLY':
      return 12 / Math.max(1, bill.everyMonths);
  }
}

/**
 * Lumpy: paid in one go less often than monthly — a premium, a school term,
 * a one-off repair ahead. These are what money is put aside for; a monthly
 * or weekly cost is simply paid out of that month.
 */
export function isLumpy(bill: BillShape): boolean {
  return bill.frequency === 'ONCE' || (bill.frequency === 'MONTHLY' && bill.everyMonths > 1);
}

/**
 * Split `total` satang into `parts` whole-satang shares that add back up to
 * it exactly — the first `remainder` shares carry the extra satang. Rounding
 * each share on its own would lose or invent money in the sum.
 */
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}
