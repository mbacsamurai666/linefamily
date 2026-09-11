import type { PrismaClient } from '@prisma/client';

/**
 * Loans given out, assets owned, and deposit accounts — three simple logs,
 * each a current snapshot rather than a full ledger (see the plan). This
 * module is their shared read side, the same way expenseSummary.ts and
 * debts.ts are for money and shared costs.
 */

export interface NetWorth {
  loansOutstandingSatang: number;
  assetsValueSatang: number;
  depositsSatang: number;
  totalSatang: number;
}

export async function computeNetWorth(prisma: PrismaClient, familyId: string): Promise<NetWorth> {
  const [loans, assets, deposits] = await Promise.all([
    prisma.loan.findMany({
      where: { familyId, active: true },
      select: { principalSatang: true, repaidSatang: true },
    }),
    prisma.asset.findMany({ where: { familyId, active: true }, select: { valueSatang: true } }),
    prisma.deposit.findMany({ where: { familyId, active: true }, select: { balanceSatang: true } }),
  ]);

  const loansOutstandingSatang = loans.reduce(
    (sum, l) => sum + (l.principalSatang - l.repaidSatang),
    0,
  );
  const assetsValueSatang = assets.reduce((sum, a) => sum + a.valueSatang, 0);
  const depositsSatang = deposits.reduce((sum, d) => sum + d.balanceSatang, 0);

  return {
    loansOutstandingSatang,
    assetsValueSatang,
    depositsSatang,
    totalSatang: loansOutstandingSatang + assetsValueSatang + depositsSatang,
  };
}

export interface LoanRow {
  id: string;
  borrowerName: string;
  principalSatang: number;
  repaidSatang: number;
  dueAt: string | null;
  note: string | null;
}

export async function listLoans(prisma: PrismaClient, familyId: string): Promise<LoanRow[]> {
  const rows = await prisma.loan.findMany({
    where: { familyId, active: true },
    orderBy: { lentAt: 'desc' },
  });
  return rows.map((l) => ({
    id: l.id,
    borrowerName: l.borrowerName,
    principalSatang: l.principalSatang,
    repaidSatang: l.repaidSatang,
    dueAt: l.dueAt ? l.dueAt.toISOString() : null,
    note: l.note,
  }));
}

export interface AssetRow {
  id: string;
  name: string;
  category: string;
  valueSatang: number;
  note: string | null;
}

export async function listAssets(prisma: PrismaClient, familyId: string): Promise<AssetRow[]> {
  const rows = await prisma.asset.findMany({
    where: { familyId, active: true },
    orderBy: { valueSatang: 'desc' },
  });
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    category: a.category,
    valueSatang: a.valueSatang,
    note: a.note,
  }));
}

export interface DepositRow {
  id: string;
  name: string;
  balanceSatang: number;
  note: string | null;
}

export async function listDeposits(prisma: PrismaClient, familyId: string): Promise<DepositRow[]> {
  const rows = await prisma.deposit.findMany({
    where: { familyId, active: true },
    orderBy: { balanceSatang: 'desc' },
  });
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    balanceSatang: d.balanceSatang,
    note: d.note,
  }));
}
