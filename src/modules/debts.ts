import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

/**
 * Net balance per member for shared expenses — "สรุปยอดหักลบ" from the plan.
 *
 * This is a net position, not a pairwise ledger: if A fronts money split with
 * B, and separately B fronts money split with A, the two debts net against
 * each other into a single number per person rather than "A owes B ¥X and B
 * owes A ¥Y". settleUp() below then turns those net positions into the
 * transfers that clear them, which is the question that follows.
 */

export interface MemberBalance {
  memberId: string;
  displayName: string;
  /** Positive: owed money by the rest of the family. Negative: owes them. */
  balanceSatang: number;
}

export interface Transfer {
  from: string;
  to: string;
  amountSatang: number;
}

/**
 * "Who pays whom" to bring every balance to zero.
 *
 * The question people actually ask after a net balance is not the history of
 * who fronted what, it is "so who do I transfer to?". Matching the largest
 * debtor against the largest creditor, repeatedly, settles everyone in at most
 * one transfer fewer than the number of people involved — never a chain of
 * A→B→C where A→C would do.
 *
 * Balances must sum to zero, which computeNetBalances guarantees since every
 * split is credited to one member and debited from another.
 */
export function settleUp(balances: MemberBalance[]): Transfer[] {
  const creditors = balances
    .filter((b) => b.balanceSatang > 0)
    .map((b) => ({ name: b.displayName, left: b.balanceSatang }))
    .sort((a, b) => b.left - a.left);
  const debtors = balances
    .filter((b) => b.balanceSatang < 0)
    .map((b) => ({ name: b.displayName, left: -b.balanceSatang }))
    .sort((a, b) => b.left - a.left);

  const transfers: Transfer[] = [];
  let c = 0;
  let d = 0;
  while (c < creditors.length && d < debtors.length) {
    const creditor = creditors[c]!;
    const debtor = debtors[d]!;
    const amount = Math.min(creditor.left, debtor.left);

    transfers.push({ from: debtor.name, to: creditor.name, amountSatang: amount });
    creditor.left -= amount;
    debtor.left -= amount;
    if (creditor.left === 0) c++;
    if (debtor.left === 0) d++;
  }
  return transfers;
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
