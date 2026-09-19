import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { formatRelativeDay } from '../line/format.js';

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

/** The "(พรุ่งนี้)" a reminder was worded with — true on the day it goes out, not on the day it is read. */
const RELATIVE_DAY = / \((?:วันนี้|พรุ่งนี้|มะรืนนี้|อีก \d+ วัน|เลยมา \d+ วัน)\)/;

export async function computeUpcoming(
  prisma: PrismaClient,
  familyId: string,
  now: DateTime,
  zone: string,
): Promise<Upcoming> {
  const local = now.setZone(zone);
  const startOfToday = local.startOf('day');
  const endOfToday = local.endOf('day');
  // Whole days, the same groups as the digest: today, the next three days,
  // then the rest of the week.
  const in3d = startOfToday.plus({ days: 3 }).endOf('day');
  const in7d = startOfToday.plus({ days: 7 }).endOf('day');

  const jobs = await prisma.notificationJob.findMany({
    where: {
      familyId,
      status: 'PENDING',
      dueAt: { gte: startOfToday.toJSDate(), lte: in7d.toJSDate() },
    },
    orderBy: { dueAt: 'asc' },
    take: 200,
  });

  const items: Array<{ item: UpcomingItem; at: DateTime }> = [];
  // One line per thing, not per reminder: an appointment reminded a day and
  // two hours ahead is two jobs, and reading it twice looked like the bot had
  // duplicated it. A repeating appointment still lists each occurrence.
  const seen = new Set<string>();
  for (const j of jobs) {
    const payload = j.payload as { text?: string; at?: string };
    const text = payload.text ?? '';
    // Jobs queued before `at` existed fall back to the reminder's own time.
    const at = payload.at ? DateTime.fromISO(payload.at, { zone }) : DateTime.fromJSDate(j.dueAt, { zone });
    const itemKey = `${j.kind}:${j.refId}:${payload.at ?? text.replace(RELATIVE_DAY, '')}`;
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    if (at < startOfToday || at > in7d) continue;

    items.push({
      at,
      item: {
        id: j.id,
        kind: j.kind,
        dueAt: at.toUTC().toISO() ?? j.dueAt.toISOString(),
        text: payload.at ? text.replace(RELATIVE_DAY, ` (${formatRelativeDay(at, local)})`) : text.replace(RELATIVE_DAY, ''),
      },
    });
  }

  const upcoming: Upcoming = { today: [], next3d: [], next7d: [] };
  for (const { item, at } of items.sort((a, b) => a.at.toMillis() - b.at.toMillis())) {
    if (at <= endOfToday) upcoming.today.push(item);
    else if (at <= in3d) upcoming.next3d.push(item);
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
