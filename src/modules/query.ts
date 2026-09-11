import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { computeExpenseSummary } from './expenseSummary.js';

/**
 * Looking back.
 *
 * Every summary in the app before this was pinned to "this month", which is
 * fine on week one and useless by month three — the question a family actually
 * asks is "was the electricity worse than last month?".
 *
 * Month references are resolved here rather than in the chat command so the
 * same phrases work wherever they turn up.
 */

const THAI_MONTHS: Record<string, number> = {
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

const MONTH_ALT = Object.keys(THAI_MONTHS)
  .sort((a, b) => b.length - a.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/** Matches the trailing month phrase of a question, if there is one. */
export const MONTH_REF = new RegExp(
  `(เดือนนี้|เดือนที่แล้ว|เดือนก่อน|ปีนี้|(?:เดือน\\s*)?(?:${MONTH_ALT})(?:\\s*(\\d{2,4}))?)\\s*$`,
);

export interface MonthRef {
  /** "2026-09", or null for a whole-year question. */
  yearMonth: string | null;
  /** Set instead of yearMonth when the question was about the year. */
  year: number | null;
  label: string;
}

/**
 * "เดือนที่แล้ว" / "ส.ค." / "ส.ค. 68" / "ปีนี้" -> the period to report on.
 * A named month that has not happened yet this year is read as last year's.
 */
export function parseMonthRef(text: string, now: DateTime): MonthRef | null {
  const m = text.match(MONTH_REF);
  if (!m) return null;

  const phrase = (m[1] as string).trim();

  if (phrase === 'เดือนนี้') {
    return { yearMonth: now.toFormat('yyyy-MM'), year: null, label: 'เดือนนี้' };
  }
  if (phrase === 'เดือนที่แล้ว' || phrase === 'เดือนก่อน') {
    const prev = now.minus({ months: 1 });
    return { yearMonth: prev.toFormat('yyyy-MM'), year: null, label: 'เดือนที่แล้ว' };
  }
  if (phrase === 'ปีนี้') {
    return { yearMonth: null, year: now.year, label: 'ปีนี้' };
  }

  const namedMonth = Object.entries(THAI_MONTHS).find(([name]) => phrase.includes(name));
  if (!namedMonth) return null;

  const month = namedMonth[1];
  let year = now.year;
  if (m[2]) {
    const raw = Number(m[2]);
    // Thai text mixes Buddhist and Gregorian, in two- and four-digit forms.
    year = raw >= 2400 ? raw - 543 : raw >= 100 ? raw : raw >= 50 ? 2500 + raw - 543 : 2000 + raw;
  } else if (month > now.month) {
    year = now.year - 1;
  }

  const dt = DateTime.fromObject({ year, month }, { zone: now.zone });
  return { yearMonth: dt.toFormat('yyyy-MM'), year: null, label: dt.toFormat('MMMM yyyy', { locale: 'th' }) };
}

export interface CategoryTotal {
  categoryName: string;
  totalSatang: number;
  count: number;
  label: string;
}

/** "ค่าไฟเดือนที่แล้ว" — one category over one period. */
export async function queryCategoryTotal(
  prisma: PrismaClient,
  familyId: string,
  categoryName: string,
  ref: MonthRef,
  zone: string,
): Promise<CategoryTotal | null> {
  const range = rangeOf(ref, zone);
  if (!range) return null;

  const rows = await prisma.transaction.findMany({
    where: {
      familyId,
      direction: 'OUT',
      occurredAt: { gte: range.start.toJSDate(), lte: range.end.toJSDate() },
      category: { name: categoryName },
    },
    select: { amount: true },
  });

  return {
    categoryName,
    totalSatang: rows.reduce((sum, r) => sum + r.amount, 0),
    count: rows.length,
    label: ref.label,
  };
}

/** Every category name this family has ever used for spending. */
export async function knownCategories(
  prisma: PrismaClient,
  familyId: string,
): Promise<string[]> {
  const rows = await prisma.category.findMany({
    where: { familyId, kind: 'OUT' },
    select: { name: true },
  });
  return rows.map((r) => r.name);
}

export interface MonthComparison {
  thisMonth: number;
  lastMonth: number;
  /** Positive means this month is spending more. */
  deltaSatang: number;
  topMovers: Array<{ name: string; deltaSatang: number }>;
}

/** "เทียบกับเดือนที่แล้ว" — the whole month, plus which categories moved most. */
export async function compareWithLastMonth(
  prisma: PrismaClient,
  familyId: string,
  now: DateTime,
  zone: string,
): Promise<MonthComparison | null> {
  const thisRef = now.toFormat('yyyy-MM');
  const lastRef = now.minus({ months: 1 }).toFormat('yyyy-MM');

  const [current, previous] = await Promise.all([
    computeExpenseSummary(prisma, familyId, thisRef, zone),
    computeExpenseSummary(prisma, familyId, lastRef, zone),
  ]);
  if (!current || !previous) return null;

  const byName = new Map<string, number>();
  for (const c of current.byCategory) byName.set(c.name, c.amountSatang);
  for (const p of previous.byCategory) {
    byName.set(p.name, (byName.get(p.name) ?? 0) - p.amountSatang);
  }

  const topMovers = [...byName.entries()]
    .map(([name, deltaSatang]) => ({ name, deltaSatang }))
    .filter((m) => m.deltaSatang !== 0)
    .sort((a, b) => Math.abs(b.deltaSatang) - Math.abs(a.deltaSatang))
    .slice(0, 3);

  return {
    thisMonth: current.totalSatang,
    lastMonth: previous.totalSatang,
    deltaSatang: current.totalSatang - previous.totalSatang,
    topMovers,
  };
}

function rangeOf(ref: MonthRef, zone: string): { start: DateTime; end: DateTime } | null {
  if (ref.year !== null) {
    const start = DateTime.fromObject({ year: ref.year, month: 1, day: 1 }, { zone });
    return { start, end: start.endOf('year') };
  }
  if (!ref.yearMonth) return null;

  const start = DateTime.fromFormat(ref.yearMonth, 'yyyy-MM', { zone });
  if (!start.isValid) return null;
  return { start, end: start.endOf('month') };
}

export { rangeOf };
