import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import {
  billOccurrences,
  dateOnly,
  isLumpy,
  splitEvenly,
  timesPerYear,
  type BillShape,
} from './billOccurrences.js';

/**
 * The family's money, laid out in time: every due date of every recurring
 * item, whether it has been paid, and what that adds up to.
 *
 * Three amounts are kept apart throughout, because adding them together is
 * how a plan starts lying:
 *   planned  — what the bills say is due (Bill, laid out by billOccurrences)
 *   actual   — what was really paid or received (Transaction)
 *   reserved — what has been put aside for the lumpy ones (ReserveEntry)
 * A premium paid out of its pot is one expense, not an expense plus a saving.
 */

/**
 * UNTRACKED is a past due date from before the bill was entered: the family
 * did pay it, somehow, but nothing here knows — so it is neither late nor paid.
 */
export type PaymentStatus = 'PAID' | 'UNPAID' | 'OVERDUE' | 'UNTRACKED';

export interface MoneyItem {
  billId: string;
  name: string;
  category: string | null;
  direction: 'IN' | 'OUT';
  /** "YYYY-MM-DD" in the family's zone. */
  dueOn: string;
  /** Planned satang; null when neither an amount nor an estimate is set. */
  amountSatang: number | null;
  estimated: boolean;
  /** Paid in one go less often than monthly — saved up for. */
  lumpy: boolean;
  /**
   * Comes out of its reserve pot rather than the month's money. True for a
   * premium or a school term; for a one-off only while it is still ahead —
   * one already due this month, or late, has had no pot and is paid from now.
   */
  fromPot: boolean;
  status: PaymentStatus;
  /** What was actually paid for this due date, when it was. */
  paidSatang: number | null;
  paidOn: string | null;
  paymentId: string | null;
  frequencyLabel: string;
  /** This item's share of the monthly reserve, when it is saved up for. */
  reservePerMonthSatang: number | null;
}

type BillRow = BillShape & {
  familyId: string;
  createdAt: Date;
  name: string;
  direction: 'IN' | 'OUT';
  categoryId: string | null;
  active: boolean;
  note: string | null;
};

/** "ทุกเดือน" / "ทุก 6 เดือน" / "ทุกปี" / "ทุกสัปดาห์" / "ครั้งเดียว" — what the card says. */
export function frequencyLabel(bill: BillShape): string {
  switch (bill.frequency) {
    case 'ONCE':
      return 'ครั้งเดียว';
    case 'DAILY':
      return bill.interval > 1 ? `ทุก ${bill.interval} วัน` : 'ทุกวัน';
    case 'WEEKLY':
      return bill.interval > 1 ? `ทุก ${bill.interval} สัปดาห์` : 'ทุกสัปดาห์';
    case 'MONTHLY':
      return bill.everyMonths === 1 ? 'รายเดือน' : bill.everyMonths === 12 ? 'รายปี' : `ทุก ${bill.everyMonths} เดือน`;
  }
}

/**
 * What to put aside each month so a lumpy bill is covered when it comes: a
 * year's worth of it over twelve months; a one-off over the months left.
 */
export function reservePerMonth(bill: BillShape, nextAmount: number | null, monthsLeft: number): number | null {
  if (!isLumpy(bill) || nextAmount === null) return null;
  if (bill.frequency === 'ONCE') return Math.ceil(nextAmount / Math.max(1, monthsLeft));
  return Math.round((nextAmount * timesPerYear(bill)) / 12);
}

export async function loadBills(prisma: PrismaClient, familyId: string): Promise<BillRow[]> {
  return (await prisma.bill.findMany({
    where: { familyId, active: true },
    include: { amounts: { select: { effectiveFrom: true, amount: true } } },
    orderBy: [{ dueDay: 'asc' }, { name: 'asc' }],
  })) as BillRow[];
}

async function categoryNames(prisma: PrismaClient, familyId: string): Promise<Map<string, string>> {
  const rows = await prisma.category.findMany({ where: { familyId }, select: { id: true, name: true } });
  return new Map(rows.map((c) => [c.id, c.name]));
}

/**
 * Every recurring money item due between two days, each with its payment
 * status. The calendar, the plan and the dashboard all read from this.
 */
export async function moneyItems(
  prisma: PrismaClient,
  familyId: string,
  from: DateTime,
  to: DateTime,
  zone: string,
  now: DateTime,
  preloaded?: { bills: BillRow[]; categories: Map<string, string> },
): Promise<MoneyItem[]> {
  const bills = preloaded?.bills ?? (await loadBills(prisma, familyId));
  if (bills.length === 0) return [];
  const categories = preloaded?.categories ?? (await categoryNames(prisma, familyId));

  const first = from.setZone(zone).startOf('day');
  const last = to.setZone(zone).endOf('day');
  const today = now.setZone(zone).startOf('day');

  // A payment made a little before or after its month still belongs to it.
  const payments = await prisma.transaction.findMany({
    where: {
      familyId,
      billId: { in: bills.map((b) => b.id) },
      OR: [
        { billDueOn: { gte: first.minus({ days: 1 }).toJSDate(), lte: last.plus({ days: 1 }).toJSDate() } },
        {
          billDueOn: null,
          occurredAt: { gte: first.minus({ months: 1 }).toJSDate(), lte: last.plus({ months: 1 }).toJSDate() },
        },
      ],
    },
    select: { id: true, billId: true, billDueOn: true, amount: true, occurredAt: true },
    orderBy: { occurredAt: 'asc' },
  });
  const used = new Set<string>();

  const items: MoneyItem[] = [];
  for (const bill of bills) {
    // Late means late since the family started tracking it here — its own
    // start date if it has one, else the day it was entered.
    const trackedFrom = bill.startsOn
      ? dateOnly(bill.startsOn, zone)
      : DateTime.min(DateTime.fromJSDate(bill.createdAt, { zone }).startOf('day'), today);
    const occurrences = billOccurrences(bill, first, last, zone);
    for (const occ of occurrences) {
      const key = occ.dueOn.toISODate() as string;
      // Exact due date first; a payment from before due dates were recorded
      // settles the monthly bill of the month it was made in.
      const payment =
        payments.find((p) => !used.has(p.id) && p.billId === bill.id && p.billDueOn && dateOnly(p.billDueOn, zone).toISODate() === key) ??
        (bill.frequency === 'MONTHLY'
          ? payments.find(
              (p) =>
                !used.has(p.id) &&
                p.billId === bill.id &&
                p.billDueOn === null &&
                DateTime.fromJSDate(p.occurredAt, { zone }).hasSame(occ.dueOn, 'month'),
            )
          : undefined);
      if (payment) used.add(payment.id);

      const monthsLeft = Math.max(1, Math.ceil(occ.dueOn.diff(today, 'months').months));
      const fromPot = isLumpy(bill) && (bill.frequency !== 'ONCE' || occ.dueOn > today.endOf('month'));
      items.push({
        billId: bill.id,
        name: bill.name,
        category: bill.categoryId ? (categories.get(bill.categoryId) ?? null) : null,
        direction: bill.direction,
        dueOn: key,
        amountSatang: occ.amount,
        estimated: occ.estimated,
        lumpy: isLumpy(bill),
        fromPot,
        status: payment
          ? 'PAID'
          : occ.dueOn >= today
            ? 'UNPAID'
            : occ.dueOn >= trackedFrom
              ? 'OVERDUE'
              : 'UNTRACKED',
        paidSatang: payment?.amount ?? null,
        paidOn: payment ? (DateTime.fromJSDate(payment.occurredAt, { zone }).toISODate() as string) : null,
        paymentId: payment?.id ?? null,
        frequencyLabel: frequencyLabel(bill),
        // Only something still being saved for asks for a monthly amount.
        reservePerMonthSatang: bill.direction === 'OUT' && fromPot ? reservePerMonth(bill, occ.amount, monthsLeft) : null,
      });
    }
  }

  return items.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.name.localeCompare(b.name));
}

// ----------------------------------------------------------------- summaries

export interface MonthTotals {
  /** "YYYY-MM". */
  month: string;
  /** Planned money out and in. */
  expenseSatang: number;
  incomeSatang: number;
  /** Of the expense, what comes out of reserve pots rather than the month's money. */
  lumpySatang: number;
  paidSatang: number;
  unpaidSatang: number;
  overdueSatang: number;
}

function totalsFor(month: string, items: MoneyItem[]): MonthTotals {
  const out = items.filter((i) => i.direction === 'OUT');
  const sum = (list: MoneyItem[]) => list.reduce((s, i) => s + (i.amountSatang ?? 0), 0);
  return {
    month,
    expenseSatang: sum(out),
    incomeSatang: sum(items.filter((i) => i.direction === 'IN')),
    lumpySatang: sum(out.filter((i) => i.fromPot)),
    paidSatang: out.filter((i) => i.status === 'PAID').reduce((s, i) => s + (i.paidSatang ?? i.amountSatang ?? 0), 0),
    unpaidSatang: sum(out.filter((i) => i.status === 'UNPAID')),
    overdueSatang: sum(out.filter((i) => i.status === 'OVERDUE')),
  };
}

/** Group items into calendar months, each month present even when empty. */
export function byMonth(items: MoneyItem[], from: DateTime, months: number): MonthTotals[] {
  const out: MonthTotals[] = [];
  for (let i = 0; i < months; i++) {
    const key = from.plus({ months: i }).toFormat('yyyy-MM');
    out.push(totalsFor(key, items.filter((it) => it.dueOn.startsWith(key))));
  }
  return out;
}

export interface Fund {
  billId: string;
  name: string;
  category: string | null;
  frequencyLabel: string;
  /** The next time this bill falls due, and what it will be. */
  nextDueOn: string;
  targetSatang: number;
  savedSatang: number;
  shortSatang: number;
  /** Put aside this much every month and it is covered, year after year. */
  perMonthSatang: number;
  monthsLeft: number;
  /** What it takes from now on to be ready by the due date. */
  catchUpPerMonthSatang: number;
  /** Behind the steady pace: less saved than a monthly habit would have by now. */
  behindSatang: number;
}

/**
 * One pot per lumpy bill. The target is the next payment; the balance is the
 * sum of what was put in and taken out — nothing about a pot is stored twice.
 */
export async function computeFunds(
  prisma: PrismaClient,
  familyId: string,
  zone: string,
  now: DateTime,
  preloaded?: { bills: BillRow[]; categories: Map<string, string> },
): Promise<Fund[]> {
  const bills = (preloaded?.bills ?? (await loadBills(prisma, familyId))).filter(
    (b) => b.direction === 'OUT' && isLumpy(b),
  );
  if (bills.length === 0) return [];
  const categories = preloaded?.categories ?? (await categoryNames(prisma, familyId));

  const balances = await prisma.reserveEntry.groupBy({
    by: ['billId'],
    where: { familyId, billId: { in: bills.map((b) => b.id) } },
    _sum: { amount: true },
  });
  const saved = new Map(balances.map((b) => [b.billId, b._sum.amount ?? 0]));
  const today = now.setZone(zone).startOf('day');

  const funds: Fund[] = [];
  for (const bill of bills) {
    // Two years is past any yearly cycle; a one-off further out than that is not a pot yet.
    const next = billOccurrences(bill, today, today.plus({ years: 2 }), zone)[0];
    if (!next || next.amount === null) continue;

    const monthsLeft = Math.max(1, Math.ceil(next.dueOn.diff(today, 'months').months));
    const perMonth = reservePerMonth(bill, next.amount, monthsLeft) ?? 0;
    const balance = saved.get(bill.id) ?? 0;
    const short = Math.max(0, next.amount - balance);
    // Saving `perMonth` every month, this much would be in the pot by now.
    const expected = Math.max(0, next.amount - perMonth * monthsLeft);

    funds.push({
      billId: bill.id,
      name: bill.name,
      category: bill.categoryId ? (categories.get(bill.categoryId) ?? null) : null,
      frequencyLabel: frequencyLabel(bill),
      nextDueOn: next.dueOn.toISODate() as string,
      targetSatang: next.amount,
      savedSatang: balance,
      shortSatang: short,
      perMonthSatang: perMonth,
      monthsLeft,
      catchUpPerMonthSatang: Math.ceil(short / monthsLeft),
      behindSatang: Math.max(0, expected - balance),
    });
  }
  return funds.sort((a, b) => a.nextDueOn.localeCompare(b.nextDueOn));
}

export interface FundTotals {
  requiredSatang: number;
  reservedSatang: number;
  remainingSatang: number;
  monthlyRequiredSatang: number;
}

export function fundTotals(funds: Fund[]): FundTotals {
  const required = funds.reduce((s, f) => s + f.targetSatang, 0);
  const reserved = funds.reduce((s, f) => s + Math.min(f.savedSatang, f.targetSatang), 0);
  return {
    requiredSatang: required,
    reservedSatang: reserved,
    remainingSatang: required - reserved,
    monthlyRequiredSatang: funds.reduce((s, f) => s + f.perMonthSatang, 0),
  };
}

export interface MonthSummary extends MonthTotals {
  /** Monthly costs that are not saved up for: running costs of the house. */
  runningSatang: number;
  /** What goes into the pots this month, for the lumpy bills still ahead. */
  reserveSatang: number;
  /** Income, less running costs, less the reserve. Lumpy bills due now come out of their pots. */
  leftSatang: number;
  /** What really moved this month, from the payments recorded. */
  actualIncomeSatang: number;
  actualExpenseSatang: number;
  items: MoneyItem[];
}

/** One month as the calendar shows it under the board. */
export async function computeMonthSummary(
  prisma: PrismaClient,
  familyId: string,
  month: DateTime,
  zone: string,
  now: DateTime,
): Promise<MonthSummary> {
  const start = month.setZone(zone).startOf('month');
  const end = start.endOf('month');
  const [bills, categories] = await Promise.all([loadBills(prisma, familyId), categoryNames(prisma, familyId)]);
  const preloaded = { bills, categories };

  const [items, funds, actual] = await Promise.all([
    moneyItems(prisma, familyId, start, end, zone, now, preloaded),
    computeFunds(prisma, familyId, zone, now, preloaded),
    prisma.transaction.groupBy({
      by: ['direction'],
      where: { familyId, occurredAt: { gte: start.toJSDate(), lte: end.toJSDate() } },
      _sum: { amount: true },
    }),
  ]);

  const totals = totalsFor(start.toFormat('yyyy-MM'), items);
  const running = totals.expenseSatang - totals.lumpySatang;
  const reserve = fundTotals(funds).monthlyRequiredSatang;

  return {
    ...totals,
    runningSatang: running,
    reserveSatang: reserve,
    leftSatang: totals.incomeSatang - running - reserve,
    actualIncomeSatang: actual.find((a) => a.direction === 'IN')?._sum.amount ?? 0,
    actualExpenseSatang: actual.find((a) => a.direction === 'OUT')?._sum.amount ?? 0,
    items,
  };
}

export interface Alert {
  level: 'warn' | 'info';
  text: string;
}

const THAI_MONTH_NAMES = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];
const baht = (satang: number) => (satang / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 });

/**
 * What the family should hear about before it happens: bills close by or
 * late, a heavy month coming, a pot falling behind.
 */
export function buildAlerts(
  items: MoneyItem[],
  months: MonthTotals[],
  funds: Fund[],
  now: DateTime,
  zone: string,
): Alert[] {
  const today = now.setZone(zone).startOf('day');
  const alerts: Alert[] = [];

  for (const item of items.filter((i) => i.direction === 'OUT' && i.status === 'OVERDUE')) {
    alerts.push({
      level: 'warn',
      text: `เลยกำหนดแล้ว: ${item.name}${item.amountSatang !== null ? ` ${baht(item.amountSatang)} บาท` : ''}`,
    });
  }

  for (const item of items.filter((i) => i.direction === 'OUT' && i.status === 'UNPAID')) {
    const days = Math.round(DateTime.fromISO(item.dueOn, { zone }).diff(today, 'days').days);
    if (days < 0 || days > 15) continue;
    alerts.push({
      level: days <= 3 ? 'warn' : 'info',
      text: `${days === 0 ? 'วันนี้' : `อีก ${days} วัน`} ${item.name} ครบกำหนด${
        item.amountSatang !== null ? ` ${baht(item.amountSatang)} บาท` : ''
      }`,
    });
  }

  const next = months[1];
  const average = months.reduce((s, m) => s + m.expenseSatang, 0) / Math.max(1, months.length);
  if (next && next.expenseSatang > 0) {
    alerts.push({
      level: next.expenseSatang > average * 1.3 ? 'warn' : 'info',
      text: `เดือนหน้ามีค่าใช้จ่าย ${baht(next.expenseSatang)} บาท`,
    });
  }

  // A heavy month further out — seen now, while there is time to save for it.
  for (const m of months.slice(2, 7)) {
    if (average > 0 && m.expenseSatang > average * 1.5) {
      const lumpy = items
        .filter((i) => i.dueOn.startsWith(m.month) && i.lumpy && i.direction === 'OUT')
        .sort((a, b) => (b.amountSatang ?? 0) - (a.amountSatang ?? 0))[0];
      const name = THAI_MONTH_NAMES[Number(m.month.slice(5, 7)) - 1];
      alerts.push({
        level: 'info',
        text: `เดือน${name}มีค่าใช้จ่าย ${baht(m.expenseSatang)} บาท${lumpy ? ` (${lumpy.name} ${baht(lumpy.amountSatang ?? 0)})` : ''}`,
      });
    }
  }

  for (const fund of funds) {
    if (fund.behindSatang > 0) {
      alerts.push({
        level: fund.monthsLeft <= 2 ? 'warn' : 'info',
        text: `กอง${fund.name}ยังขาด ${baht(fund.shortSatang)} บาท (ควรเก็บเพิ่มเดือนละ ${baht(fund.catchUpPerMonthSatang)})`,
      });
    }
  }

  return alerts;
}

export interface FamilyFinance {
  /** Planned income, averaged per month over the next twelve. */
  monthlyIncomeSatang: number;
  /** Monthly running costs — not saved up for — averaged the same way. */
  monthlyRunningSatang: number;
  /** Everything planned to go out over the next twelve months. */
  next12MonthsSatang: number;
  thisMonth: MonthTotals;
  nextMonth: MonthTotals;
  /** Put aside monthly for the lumpy bills. */
  monthlyReserveSatang: number;
  /** Income less running costs less the reserve, per month. */
  monthlyLeftSatang: number;
  months: MonthTotals[];
  highest: MonthTotals | null;
  lowest: MonthTotals | null;
  upcoming: MoneyItem[];
  funds: Fund[];
  fundTotals: FundTotals;
  alerts: Alert[];
}

/** The dashboard's money card: the next twelve months from this one. */
export async function computeFamilyFinance(
  prisma: PrismaClient,
  familyId: string,
  zone: string,
  now: DateTime,
): Promise<FamilyFinance> {
  const start = now.setZone(zone).startOf('month');
  const end = start.plus({ months: 11 }).endOf('month');
  const [bills, categories] = await Promise.all([loadBills(prisma, familyId), categoryNames(prisma, familyId)]);
  const preloaded = { bills, categories };

  const [items, funds] = await Promise.all([
    // A little behind as well, so anything left unpaid still shows as late.
    moneyItems(prisma, familyId, start.minus({ months: 1 }), end, zone, now, preloaded),
    computeFunds(prisma, familyId, zone, now, preloaded),
  ]);
  const ahead = items.filter((i) => i.dueOn >= (start.toISODate() as string));
  const months = byMonth(ahead, start, 12);
  const out = months.reduce((s, m) => s + m.expenseSatang, 0);
  const lumpy = months.reduce((s, m) => s + m.lumpySatang, 0);
  const income = months.reduce((s, m) => s + m.incomeSatang, 0);
  const totals = fundTotals(funds);
  const monthlyIncome = Math.round(income / 12);
  const monthlyRunning = Math.round((out - lumpy) / 12);
  const withSpend = months.filter((m) => m.expenseSatang > 0);
  const today = now.setZone(zone).startOf('day').toISODate() as string;
  const in30 = now.setZone(zone).plus({ days: 30 }).toISODate() as string;

  return {
    monthlyIncomeSatang: monthlyIncome,
    monthlyRunningSatang: monthlyRunning,
    next12MonthsSatang: out,
    thisMonth: months[0] as MonthTotals,
    nextMonth: months[1] as MonthTotals,
    monthlyReserveSatang: totals.monthlyRequiredSatang,
    monthlyLeftSatang: monthlyIncome - monthlyRunning - totals.monthlyRequiredSatang,
    months,
    highest: withSpend.length ? withSpend.reduce((a, b) => (b.expenseSatang > a.expenseSatang ? b : a)) : null,
    lowest: withSpend.length ? withSpend.reduce((a, b) => (b.expenseSatang < a.expenseSatang ? b : a)) : null,
    upcoming: items.filter(
      (i) => i.direction === 'OUT' && i.status !== 'PAID' && i.dueOn <= in30 && (i.dueOn >= today || i.status === 'OVERDUE'),
    ),
    funds,
    fundTotals: totals,
    alerts: buildAlerts(items, months, funds, now, zone),
  };
}

