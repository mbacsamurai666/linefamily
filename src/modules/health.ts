import type { PrismaClient } from '@prisma/client';
import type { DateTime } from 'luxon';

/**
 * Is the bot actually doing its job?
 *
 * The honest limit first: a process that has died cannot report that it died.
 * This is what something *outside* asks (an uptime monitor hitting /health) and
 * what a person can ask from the chat — it is not a substitute for external
 * monitoring, it is the thing that gives external monitoring something true to
 * look at.
 *
 * The signal that matters is not "are there reminders waiting" — with digest
 * batching, a reminder due at 10:00 sitting unsent until 20:00 is the design
 * working. It is reminders that have outlived *two* digest windows, which
 * means nothing is draining the queue.
 */

/** Older than this and at least two digests have come and gone. */
const STUCK_AFTER_HOURS = 26;

export interface HealthReport {
  ok: boolean;
  /** Reminders that should have gone out well before now and have not. */
  stuckJobs: number;
  /** When the engine last actually delivered something. */
  lastSentAt: string | null;
  /** Null when nothing has ever been queued — a quiet house, not a fault. */
  hoursSinceLastSend: number | null;
  pushUsed: number;
  pushQuota: number;
  pendingJobs: number;
}

export async function computeHealth(
  prisma: PrismaClient,
  now: DateTime,
  pushQuota: number,
): Promise<HealthReport> {
  const yearMonth = now.toFormat('yyyy-MM');

  const [stuckJobs, pendingJobs, lastSent, budgets] = await Promise.all([
    prisma.notificationJob.count({
      where: {
        status: 'PENDING',
        dueAt: { lt: now.minus({ hours: STUCK_AFTER_HOURS }).toJSDate() },
      },
    }),
    prisma.notificationJob.count({ where: { status: 'PENDING' } }),
    prisma.notificationJob.findFirst({
      where: { status: 'SENT', sentAt: { not: null } },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    }),
    prisma.pushBudget.findMany({ where: { yearMonth }, select: { used: true } }),
  ]);

  const sentAt = lastSent?.sentAt ?? null;

  return {
    // Reaching this line at all means the database answered.
    ok: stuckJobs === 0,
    stuckJobs,
    lastSentAt: sentAt ? sentAt.toISOString() : null,
    hoursSinceLastSend: sentAt
      ? Math.round((now.toMillis() - sentAt.getTime()) / 3_600_000)
      : null,
    pushUsed: budgets.reduce((sum, b) => sum + b.used, 0),
    pushQuota,
    pendingJobs,
  };
}
