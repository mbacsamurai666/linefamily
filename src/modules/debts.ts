import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

/**
 * Net balance per member for shared expenses — "สรุปยอดหักลบ" from the plan.
 *
 * This is a net position, not a pairwise ledger: if A fronts money split with
 * B, and separately B fronts money split with A, the two debts net against
 * each other into a single number per person rather than "A owes B ¥X and B
 * owes A ¥Y". That is enough to answer "who's ahead, who's behind" without
 * the complexity of a full settle-up matrix, which nobody asked for.
 */

export interface MemberBalance {
  memberId: string;
  displayName: string;
  /** Positive: owed money by the rest of the family. Negative: owes them. */
  balanceSatang: number;
}

export async function computeNetBalances(
  prisma: PrismaClient,
  familyId: string,
  yearMonth: string,
  zone: string,
): Promise<MemberBalance[]> {
  const start = DateTime.fromFormat(yearMonth, 'yyyy-MM', { zone });
  if (!start.isValid) return [];
  const end = start.endOf('month');

  const transactions = await prisma.transaction.findMany({
    where: {
      familyId,
      direction: 'OUT',
      occurredAt: { gte: start.toJSDate(), lte: end.toJSDate() },
      paidById: { not: null },
      splits: { some: {} },
    },
    select: {
      paidById: true,
      splits: { select: { memberId: true, share: true } },
    },
  });

  const balance = new Map<string, number>();
  const bump = (memberId: string, delta: number) =>
    balance.set(memberId, (balance.get(memberId) ?? 0) + delta);

  for (const tx of transactions) {
    const payerId = tx.paidById as string;
    for (const split of tx.splits) {
      if (split.memberId === payerId) continue; // the payer's own share is not a debt
      bump(payerId, split.share); // owed to the payer
      bump(split.memberId, -split.share); // owed by this member
    }
  }

  const memberIds = [...balance.keys()];
  if (memberIds.length === 0) return [];

  const members = await prisma.member.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(members.map((m) => [m.id, m.displayName]));

  return memberIds
    .map((memberId) => ({
      memberId,
      displayName: nameById.get(memberId) ?? memberId,
      balanceSatang: balance.get(memberId) as number,
    }))
    .filter((b) => b.balanceSatang !== 0)
    .sort((a, b) => b.balanceSatang - a.balanceSatang);
}
