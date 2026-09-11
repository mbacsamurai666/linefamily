import type { PrismaClient } from '@prisma/client';
import type { DateTime } from 'luxon';
import type { messagingApi } from '@line/bot-sdk';
import { renderDigestImage } from '../line/digestImage.js';
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

export class PrismaFamilyStore implements FamilyStore {
  constructor(private readonly prisma: PrismaClient) {}

  async listActive(): Promise<FamilyClockInfo[]> {
    const rows = await this.prisma.family.findMany({
      select: { id: true, timezone: true },
    });
    return rows.map((r) => ({ familyId: r.id, timezone: r.timezone }));
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

    const messages: messagingApi.Message[] = [buildDigest(jobs, slot, this.liffUrl)];

    // The picture is the nice part, not the load-bearing part: if drawing or
    // storing it fails, the card still goes out on time.
    const imageUrl = await this.storeDigestImage(familyId, jobs, slot).catch((err) => {
      this.log?.('digest image failed', { err: String(err) });
      return null;
    });
    if (imageUrl) {
      messages.push({ type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl });
    }

    await this.api.pushMessage({ to, messages });
    return messages.length;
  }

  private async storeDigestImage(
    familyId: string,
    jobs: ReminderJob[],
    slot: DateTime,
  ): Promise<string | null> {
    if (!this.baseUrl) return null;

    const png = await renderDigestImage({ jobs, slot });
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
    await this.api.pushMessage({
      to,
      messages: [{ type: 'text', text: `⚠️ ${job.payload.text}` }],
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
