import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

/**
 * What the household is committed to paying, month by month across a year.
 *
 * The family's heavy costs are not the daily ones — they are the yearly and
 * per-term ones that arrive together: car insurance, tuition, the student
 * loan, the condo fee. Two questions matter, and they have different answers:
 * what falls due in each month (so March's double hit is visible in January),
 * and what to put aside every month so those months are already paid for.
 *
 * Built from the family's bills, which is where a recurring cost already
 * lives — a bill now carries how often it comes round (see Bill.everyMonths).
 */

export interface PlannedItem {
  billId: string;
  name: string;
  category: string | null;
  /** Satang. An estimate when the amount varies; see `estimated`. */
  amountSatang: number;
  /** The amount is a guess the family typed, not a fixed charge. */
  estimated: boolean;
  /** Day of the month it falls due, clamped to the month's length. */
  day: number;
  /** Paid already — only ever true for a month that has been and gone. */
  paid: boolean;
}

export interface PlannedMonth {
  /** 1-12. */
  month: number;
  dueSatang: number;
  paidSatang: number;
  items: PlannedItem[];
}

export interface ExpensePlan {
  year: number;
  months: PlannedMonth[];
  totalSatang: number;
  /** The year's total spread evenly — what to put aside each month. */
  perMonthSatang: number;
  byCategory: Array<{ category: string; totalSatang: number }>;
  /** Bills with neither a fixed amount nor an estimate: the plan is short by these. */
  missingAmount: string[];
}

/** Whether a cycle lands in this month: every month, or every Nth from its own. */
export function fallsDue(month: number, everyMonths: number, dueMonth: number | null): boolean {
  if (everyMonths <= 1) return true;
  const anchor = ((dueMonth ?? 1) - 1) % everyMonths;
  return (month - 1) % everyMonths === anchor;
}

export async function computeExpensePlan(
  prisma: PrismaClient,
  familyId: string,
  year: number,
  zone: string,
  /** Unused for now; kept so a future "what is left this year" can lean on it. */
  now: DateTime = DateTime.now().setZone(zone),
): Promise<ExpensePlan> {
  const [bills, categories, paidRows] = await Promise.all([
    prisma.bill.findMany({ where: { familyId, active: true }, orderBy: { dueDay: 'asc' } }),
    // Bill keeps only the id; the name is what a plan reads by.
    prisma.category.findMany({ where: { familyId }, select: { id: true, name: true } }),
    // A bill marked paid records a transaction against it; that is how a month
    // already dealt with is told from one still ahead.
    prisma.transaction.findMany({
      where: {
        familyId,
        billId: { not: null },
        occurredAt: {
          gte: DateTime.fromObject({ year, month: 1, day: 1 }, { zone }).toJSDate(),
          lte: DateTime.fromObject({ year, month: 12, day: 31 }, { zone }).endOf('day').toJSDate(),
        },
      },
      select: { billId: true, amount: true, occurredAt: true },
    }),
  ]);

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const paid = new Map<string, number>();
  for (const row of paidRows) {
    const month = DateTime.fromJSDate(row.occurredAt, { zone }).month;
    paid.set(`${row.billId}:${month}`, (paid.get(`${row.billId}:${month}`) ?? 0) + row.amount);
  }

  const months: PlannedMonth[] = [];
  const byCategory = new Map<string, number>();
  const missingAmount: string[] = [];

  for (let month = 1; month <= 12; month++) {
    const items: PlannedItem[] = [];
    let dueSatang = 0;
    let paidSatang = 0;

    for (const bill of bills) {
      if (!fallsDue(month, bill.everyMonths, bill.dueMonth)) continue;

      const amount = bill.amount ?? bill.estimateAmount;
      if (amount === null || amount === undefined) {
        if (!missingAmount.includes(bill.name)) missingAmount.push(bill.name);
        continue;
      }

      const daysInMonth = DateTime.fromObject({ year, month }, { zone }).daysInMonth ?? 28;
      const paidHere = paid.get(`${bill.id}:${month}`);
      items.push({
        billId: bill.id,
        name: bill.name,
        category: bill.categoryId ? (categoryName.get(bill.categoryId) ?? null) : null,
        amountSatang: amount,
        estimated: bill.amount === null,
        day: Math.min(bill.dueDay, daysInMonth),
        paid: paidHere !== undefined,
      });

      dueSatang += amount;
      paidSatang += paidHere ?? 0;
      const key = (bill.categoryId ? categoryName.get(bill.categoryId) : null) ?? 'อื่นๆ';
      byCategory.set(key, (byCategory.get(key) ?? 0) + amount);
    }

    items.sort((a, b) => a.day - b.day);
    months.push({ month, dueSatang, paidSatang, items });
  }

  const totalSatang = months.reduce((sum, m) => sum + m.dueSatang, 0);

  return {
    year,
    months,
    totalSatang,
    perMonthSatang: Math.round(totalSatang / 12),
    byCategory: [...byCategory.entries()]
      .map(([category, total]) => ({ category, totalSatang: total }))
      .sort((a, b) => b.totalSatang - a.totalSatang),
    missingAmount,
  };
}
