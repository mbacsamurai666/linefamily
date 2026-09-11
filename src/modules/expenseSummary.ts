import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

/**
 * Shared by the LIFF /expenses/summary endpoint and the month-end digest —
 * one aggregation, two callers, so a fix to one never drifts from the other.
 */

export interface CategoryTotal {
  name: string;
  amountSatang: number;
}

export interface ExpenseSummary {
  month: string;
  totalSatang: number;
  byCategory: CategoryTotal[];
}

export async function computeExpenseSummary(
  prisma: PrismaClient,
  familyId: string,
  month: string,
  zone: string,
): Promise<ExpenseSummary | null> {
  const start = DateTime.fromFormat(month, 'yyyy-MM', { zone });
  if (!start.isValid) return null;
  const end = start.endOf('month');

  const rows = await prisma.transaction.findMany({
    where: {
      familyId,
      direction: 'OUT',
      occurredAt: { gte: start.toJSDate(), lte: end.toJSDate() },
    },
    select: { amount: true, category: { select: { name: true } } },
  });

  const byCategory = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    total += row.amount;
    const name = row.category?.name ?? 'ไม่มีหมวด';
    byCategory.set(name, (byCategory.get(name) ?? 0) + row.amount);
  }

  return {
    month,
    totalSatang: total,
    byCategory: [...byCategory.entries()]
      .map(([name, amountSatang]) => ({ name, amountSatang }))
      .sort((a, b) => b.amountSatang - a.amountSatang),
  };
}
