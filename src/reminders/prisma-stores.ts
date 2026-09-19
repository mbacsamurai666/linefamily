import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import type { messagingApi } from '@line/bot-sdk';
import { buildDigestQuickReply, buildUrgentQuickReply, type DigestNames } from '../line/digestActions.js';
import { renderDigestImage, type UpcomingLine } from '../line/digestImage.js';
import { formatThaiDate } from '../line/format.js';
import { listCalendar } from '../modules/calendar.js';
import { buildDigest } from '../line/flex/digest.js';
import type {
  BudgetStore,
  FamilyClockInfo,
  FamilyStore,
  JobLane,
  JobStore,
  Notifier,
  ReminderJob,
} from './ports.js';

/** Prisma-backed implementations of the reminder ports. */

export class PrismaJobStore implements JobStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claimDue(now: Date, lane: JobLane, limit: number): Promise<ReminderJob[]> {
    const rows = await this.prisma.notificationJob.findMany({
      where: { status: 'PENDING', lane, dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: limit,
    });

    return rows.map((r) => ({
      id: r.id,
      familyId: r.familyId,
      kind: r.kind,
      refId: r.refId,
      dueAt: r.dueAt,
      lane: r.lane,
      payload: (r.payload ?? { text: '' }) as ReminderJob['payload'],
    }));
  }

  async markSent(ids: string[], at: Date): Promise<void> {
    await this.prisma.notificationJob.updateMany({
      // Guarding on PENDING makes a concurrent second worker a no-op rather
      // than a double send.
      where: { id: { in: ids }, status: 'PENDING' },
      data: { status: 'SENT', sentAt: at },
    });
  }

  async markSkipped(ids: string[]): Promise<void> {
    await this.prisma.notificationJob.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: { status: 'SKIPPED' },
    });
  }

  async demoteToDigest(ids: string[]): Promise<void> {
    await this.prisma.notificationJob.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: { lane: 'DIGEST' },
    });
  }
}

export class PrismaBudgetStore implements BudgetStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly monthlyQuota: number,
  ) {}

  async remaining(familyId: string, yearMonth: string): Promise<number> {
    const row = await this.prisma.pushBudget.findUnique({
      where: { familyId_yearMonth: { familyId, yearMonth } },
    });
    // LINE's own counter wins when we have it — our tally can drift if a push
    // fails after being counted, or if messages are sent from the OA console.
    const used = Math.max(row?.used ?? 0, row?.lineReported ?? 0);
    return this.monthlyQuota - used;
  }

  async consume(familyId: string, yearMonth: string, count: number): Promise<void> {
    await this.prisma.pushBudget.upsert({
      where: { familyId_yearMonth: { familyId, yearMonth } },
      create: { familyId, yearMonth, used: count },
      update: { used: { increment: count } },
    });
  }
}

/** A family row's digest settings, in the shape the engine schedules by. */
export function familyClock(r: {
  id: string;
  timezone: string;
  digestMorningAt: number;
  digestEveningAt: number;
  digestMorningOn: boolean;
  digestEveningOn: boolean;
  digestEveryMorning: boolean;
  digestEveryEvening: boolean;
  digestDays: number[];
}): FamilyClockInfo {
  const slots = [
    ...(r.digestMorningOn ? [r.digestMorningAt] : []),
    ...(r.digestEveningOn ? [r.digestEveningAt] : []),
  ];
  return {
    familyId: r.id,
    timezone: r.timezone,
    slots,
    quietDaySlots: [
      ...(r.digestMorningOn && r.digestEveryMorning ? [r.digestMorningAt] : []),
      ...(r.digestEveningOn && r.digestEveryEvening ? [r.digestEveningAt] : []),
    ],
    days: r.digestDays,
  };
}

export class PrismaFamilyStore implements FamilyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listActive(): Promise<FamilyClockInfo[]> {
    const rows = await this.prisma.family.findMany({
      select: {
        id: true,
        timezone: true,
        digestMorningAt: true,
        digestEveningAt: true,
        digestMorningOn: true,
        digestEveningOn: true,
        digestEveryMorning: true,
        digestEveryEvening: true,
        digestDays: true,
      },
    });
    return rows.map((r) => familyClock(r));
  }
}

export class LineNotifier implements Notifier {
  constructor(
    private readonly api: messagingApi.MessagingApiClient,
    private readonly prisma: PrismaClient,
    private readonly liffUrl?: string,
    /**
     * Where this server answers from, so LINE can fetch the digest picture.
     * Without it the digest is the card alone, exactly as before.
     */
    private readonly baseUrl?: string,
    private readonly log?: (msg: string, meta?: Record<string, unknown>) => void,
  ) {}

  private async groupIdOf(familyId: string): Promise<string | null> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      select: { lineGroupId: true },
    });
    return family?.lineGroupId ?? null;
  }

  async sendDigest(familyId: string, jobs: ReminderJob[], slot: DateTime): Promise<number> {
    const to = await this.groupIdOf(familyId);
    if (!to) return 0;

    // A quiet day's digest has nothing due to list, so it looks a week ahead.
    const upcoming = jobs.length === 0 ? await this.weekAhead(familyId, slot) : [];
    const messages: messagingApi.Message[] = [buildDigest(jobs, slot, this.liffUrl, upcoming)];

    // The picture is the nice part, not the load-bearing part: if drawing or
    // storing it fails, the card still goes out on time.
    const imageUrl = await this.storeDigestImage(familyId, jobs, slot, upcoming).catch((err) => {
      this.log?.('digest image failed', { err: String(err) });
      return null;
    });
    if (imageUrl) {
      messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
    }

    // Quick replies show under the newest message only, so they ride on the
    // last one — whichever that turned out to be.
    const quickReply = buildDigestQuickReply(jobs, await this.namesFor(jobs), this.liffUrl);
    if (quickReply) messages[messages.length - 1] = { ...messages[messages.length - 1]!, quickReply };

    await this.api.pushMessage({ to, messages });
    return messages.length;
  }

  /** What the bills, tasks and chores in this batch are called, for the buttons. */
  private async namesFor(jobs: ReminderJob[]): Promise<DigestNames> {
    const ids = (kind: ReminderJob['kind']) =>
      [...new Set(jobs.filter((j) => j.kind === kind).map((j) => j.refId))];
    const billIds = ids('BILL');
    const taskIds = ids('TASK');
    const choreIds = ids('CHORE');

    const [bills, tasks, chores] = await Promise.all([
      billIds.length ? this.prisma.bill.findMany({ where: { id: { in: billIds } }, select: { id: true, name: true } }) : [],
      taskIds.length ? this.prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } }) : [],
      choreIds.length ? this.prisma.chore.findMany({ where: { id: { in: choreIds } }, select: { id: true, name: true } }) : [],
    ]);

    return {
      bills: new Map(bills.map((b) => [b.id, b.name])),
      tasks: new Map(tasks.map((t) => [t.id, t.title])),
      chores: new Map(chores.map((c) => [c.id, c.name])),
    };
  }

  /** Appointments in the next seven days, worded for the digest. */
  private async weekAhead(familyId: string, slot: DateTime): Promise<UpcomingLine[]> {
    const zone = slot.zoneName ?? 'Asia/Bangkok';
    const { items } = await listCalendar(
      this.prisma,
      familyId,
      slot.startOf('day'),
      slot.plus({ days: 7 }).endOf('day'),
      zone,
    );
    return items
      .map((ev) => ({ ev, start: DateTime.fromISO(ev.startAt, { zone }) }))
      // An all-day appointment today starts at midnight, before any digest —
      // but it is still today's, and the most useful line on the card.
      .filter(({ ev, start }) => start >= slot || (ev.allDay && start.hasSame(slot, 'day')))
      .map(({ ev, start }) => ({
        // "พ. 16 ก.ย." — the two-digit year adds nothing a week out.
        when: `${formatThaiDate(start).replace(/ \d{2}$/, '')}${ev.allDay ? '' : ` ${start.toFormat('HH:mm')}`}`,
        title: ev.title,
      }));
  }

  private async storeDigestImage(
    familyId: string,
    jobs: ReminderJob[],
    slot: DateTime,
    upcoming: UpcomingLine[] = [],
  ): Promise<string | null> {
    if (!this.baseUrl) return null;

    const png = await renderDigestImage({ jobs, slot, upcoming });
    const row = await this.prisma.digestImage.create({
      data: { familyId, png: new Uint8Array(png) },
      select: { id: true },
    });

    // Nobody scrolls a family group back a month, and these are the only rows
    // in the database measured in hundreds of kilobytes.
    await this.prisma.digestImage.deleteMany({
      where: { createdAt: { lt: slot.minus({ days: 30 }).toJSDate() } },
    });

    return `${this.baseUrl.replace(/\/+$/, '')}/digest/${row.id}/board.png`;
  }

  async sendUrgent(familyId: string, job: ReminderJob): Promise<void> {
    const to = await this.groupIdOf(familyId);
    if (!to) return;
    const quickReply = buildUrgentQuickReply(job);
    await this.api.pushMessage({
      to,
      messages: [{ type: 'text', text: `⚠️ ${job.payload.text}`, ...(quickReply ? { quickReply } : {}) }],
    });
  }
}

/**
 * Reconcile our tally against what LINE actually counted. Drift is expected —
 * messages sent from the OA console never pass through this process — and an
 * undetected drift is exactly how the quota runs out unannounced.
 */
export async function reconcilePushBudget(
  prisma: PrismaClient,
  api: messagingApi.MessagingApiClient,
  yearMonth: string,
): Promise<void> {
  const consumption = await api.getMessageQuotaConsumption();
  const totalUsage = Number(consumption.totalUsage ?? 0);

  const families = await prisma.family.findMany({ select: { id: true } });
  if (families.length === 0) return;

  // The LINE quota is per official account, not per family. With one family
  // per account this is exact; with several it is a shared ceiling, so the
  // reported total is recorded against each and the lowest remaining wins.
  for (const family of families) {
    await prisma.pushBudget.upsert({
      where: { familyId_yearMonth: { familyId: family.id, yearMonth } },
      create: {
        familyId: family.id,
        yearMonth,
        used: 0,
        lineReported: totalUsage,
        reconciledAt: new Date(),
      },
      update: { lineReported: totalUsage, reconciledAt: new Date() },
    });
  }
}
