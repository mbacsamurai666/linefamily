import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

/**
 * Read side for the Dashboard tab: upcoming items bucketed by how soon they
 * are, and this month's income vs. expense. Kept separate from
 * expenseSummary.ts (OUT-only, feeds the month-end digest) so a change here
 * can never drift that digest's numbers.
 */

export interface UpcomingItem {
  id: string;
  kind: string;
  dueAt: string;
  text: string;
}

export interface Upcoming {
  today: UpcomingItem[];
  next3d: UpcomingItem[];
  next7d: UpcomingItem[];
}

export async function computeUpcoming(
  prisma: PrismaClient,
  familyId: string,
  now: DateTime,
  zone: string,
): Promise<Upcoming> {
  const local = now.setZone(zone);
  const startOfToday = local.startOf('day');
  const endOfToday = local.endOf('day');
  const in3d = startOfToday.plus({ days: 3 });
  const in7d = startOfToday.plus({ days: 7 });

  const jobs = await prisma.notificationJob.findMany({
    where: {
      familyId,
      status: 'PENDING',
      dueAt: { gte: startOfToday.toJSDate(), lte: in7d.toJSDate() },
    },
    orderBy: { dueAt: 'asc' },
    take: 200,
  });

  const upcoming: Upcoming = { today: [], next3d: [], next7d: [] };
  for (const j of jobs) {
    const item: UpcomingItem = {
      id: j.id,
      kind: j.kind,
      dueAt: j.dueAt.toISOString(),
      text: (j.payload as { text?: string }).text ?? '',
    };
    const dueAt = DateTime.fromJSDate(j.dueAt);
    if (dueAt <= endOfToday) upcoming.today.push(item);
    else if (dueAt <= in3d) upcoming.next3d.push(item);
    else upcoming.next7d.push(item);
  }

  return upcoming;
}

export interface TaskCounts {
  todo: number;
  doing: number;
  /** Finished since local midnight — the "เสร็จวันนี้" figure on the board. */
  doneToday: number;
}

export async function computeTaskCounts(
  prisma: PrismaClient,
  familyId: string,
  now: DateTime,
  zone: string,
): Promise<TaskCounts> {
  const startOfToday = now.setZone(zone).startOf('day').toJSDate();

  const [todo, doing, doneToday] = await Promise.all([
    prisma.task.count({ where: { familyId, status: 'TODO' } }),
    prisma.task.count({ where: { familyId, status: 'DOING' } }),
    prisma.task.count({ where: { familyId, status: 'DONE', doneAt: { gte: startOfToday } } }),
  ]);

  return { todo, doing, doneToday };
}

export interface MoneyOverview {
  month: string;
  incomeSatang: number;
  expenseSatang: number;
  netSatang: number;
}

export async function computeMoneyOverview(
  prisma: PrismaClient,
  familyId: string,
  month: string,
  zone: string,
): Promise<MoneyOverview | null> {
  const start = DateTime.fromFormat(month, 'yyyy-MM', { zone });
  if (!start.isValid) return null;
  const end = start.endOf('month');

  const rows = await prisma.transaction.groupBy({
    by: ['direction'],
    where: { familyId, occurredAt: { gte: start.toJSDate(), lte: end.toJSDate() } },
    _sum: { amount: true },
  });

  const incomeSatang = rows.find((r) => r.direction === 'IN')?._sum.amount ?? 0;
  const expenseSatang = rows.find((r) => r.direction === 'OUT')?._sum.amount ?? 0;

  return { month, incomeSatang, expenseSatang, netSatang: incomeSatang - expenseSatang };
}
