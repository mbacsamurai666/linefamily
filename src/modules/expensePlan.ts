import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { computeFunds, fundTotals, loadBills, moneyItems, type MoneyItem, type PaymentStatus } from './money.js';

/**
 * A calendar year of the family's committed money, month by month.
 *
 * The family's heavy costs are not the daily ones — they are the yearly and
 * per-term ones that arrive together: car insurance, tuition, the student
 * loan. Two questions matter and they have different answers: what falls due
 * in each month (so March's double hit is visible in January), and what to
 * put aside every month so those months are already paid for.
 *
 * Laid out from the same occurrences as the calendar (see money.ts), so the
 * plan and the calendar can never disagree about a date or an amount.
 */

export interface PlannedItem {
  billId: string;
  name: string;
  category: string | null;
  direction: 'IN' | 'OUT';
  /** Satang. An estimate when the amount varies; see `estimated`. */
  amountSatang: number;
  estimated: boolean;
  /** Day of the month it falls due, clamped to the month's length. */
  day: number;
  status: PaymentStatus;
  /** Settled already. Kept alongside `status` for callers that only ask that. */
  paid: boolean;
  lumpy: boolean;
}

export interface PlannedMonth {
  /** 1-12. */
  month: number;
  /** Planned money out. */
  dueSatang: number;
  /** Planned money in. */
  incomeSatang: number;
  paidSatang: number;
  items: PlannedItem[];
}

export interface ExpensePlan {
  year: number;
  months: PlannedMonth[];
  /** Everything planned to go out in the year. */
  totalSatang: number;
  incomeSatang: number;
  /** The year's spending spread evenly — the average month. */
  perMonthSatang: number;
  /** What to put aside every month for the bills paid in one go. */
  reserveSatang: number;
  /** The year's lumpy bills, twelfths of which make the reserve. */
  lumpySatang: number;
  highestMonth: number | null;
  lowestMonth: number | null;
  byCategory: Array<{ category: string; totalSatang: number }>;
  /** Bills with neither a fixed amount nor an estimate: the plan is short by these. */
  missingAmount: string[];
}

/** Whether a month-based cycle lands in this month of the year. Kept for older callers. */
export function fallsDue(month: number, everyMonths: number, dueMonth: number | null): boolean {
  if (everyMonths <= 1) return true;
  const anchor = ((dueMonth ?? 1) - 1) % everyMonths;
  return (month - 1) % everyMonths === anchor;
}

const toPlanned = (i: MoneyItem): PlannedItem => ({
  billId: i.billId,
  name: i.name,
  category: i.category,
  direction: i.direction,
  amountSatang: i.amountSatang ?? 0,
  estimated: i.estimated,
  day: Number(i.dueOn.slice(8, 10)),
  status: i.status,
  paid: i.status === 'PAID',
  lumpy: i.lumpy,
});

export async function computeExpensePlan(
  prisma: PrismaClient,
  familyId: string,
  year: number,
  zone: string,
  now: DateTime = DateTime.now().setZone(zone),
): Promise<ExpensePlan> {
  const start = DateTime.fromObject({ year, month: 1, day: 1 }, { zone });
  const [bills, categories] = await Promise.all([
    loadBills(prisma, familyId),
    prisma.category.findMany({ where: { familyId }, select: { id: true, name: true } }),
  ]);
  const preloaded = { bills, categories: new Map(categories.map((c) => [c.id, c.name])) };

  const [items, funds] = await Promise.all([
    moneyItems(prisma, familyId, start, start.endOf('year'), zone, now, preloaded),
    computeFunds(prisma, familyId, zone, now, preloaded),
  ]);

  const missingAmount = [...new Set(items.filter((i) => i.amountSatang === null).map((i) => i.name))];
  const counted = items.filter((i) => i.amountSatang !== null);

  const months: PlannedMonth[] = [];
  const byCategory = new Map<string, number>();
  for (let month = 1; month <= 12; month++) {
    const key = start.set({ month }).toFormat('yyyy-MM');
    const inMonth = counted.filter((i) => i.dueOn.startsWith(key));
    const out = inMonth.filter((i) => i.direction === 'OUT');
    for (const i of out) {
      const cat = i.category ?? 'อื่นๆ';
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + (i.amountSatang ?? 0));
    }
    months.push({
      month,
      dueSatang: out.reduce((s, i) => s + (i.amountSatang ?? 0), 0),
      incomeSatang: inMonth.filter((i) => i.direction === 'IN').reduce((s, i) => s + (i.amountSatang ?? 0), 0),
      paidSatang: out.filter((i) => i.status === 'PAID').reduce((s, i) => s + (i.paidSatang ?? i.amountSatang ?? 0), 0),
      items: inMonth.map(toPlanned),
    });
  }

  const totalSatang = months.reduce((s, m) => s + m.dueSatang, 0);
  const lumpySatang = counted
    .filter((i) => i.direction === 'OUT' && i.lumpy)
    .reduce((s, i) => s + (i.amountSatang ?? 0), 0);
  const withSpend = months.filter((m) => m.dueSatang > 0);

  return {
    year,
    months,
    totalSatang,
    incomeSatang: months.reduce((s, m) => s + m.incomeSatang, 0),
    perMonthSatang: Math.round(totalSatang / 12),
    reserveSatang: fundTotals(funds).monthlyRequiredSatang,
    lumpySatang,
    highestMonth: withSpend.length ? withSpend.reduce((a, b) => (b.dueSatang > a.dueSatang ? b : a)).month : null,
    lowestMonth: withSpend.length ? withSpend.reduce((a, b) => (b.dueSatang < a.dueSatang ? b : a)).month : null,
    byCategory: [...byCategory.entries()]
      .map(([category, total]) => ({ category, totalSatang: total }))
      .sort((a, b) => b.totalSatang - a.totalSatang),
    missingAmount,
  };
}
