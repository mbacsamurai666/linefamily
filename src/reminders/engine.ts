import { DateTime } from 'luxon';
import type {
  BudgetStore,
  Clock,
  FamilyStore,
  JobStore,
  Notifier,
  ReminderJob,
} from './ports.js';

/**
 * ReminderEngine — the single consumer of NotificationJob.
 *
 * The whole design exists to survive one number: roughly 500 bot-initiated
 * messages per month on the LINE free plan. Reminding per item would burn that
 * in a week, so every non-urgent reminder is batched into two digests a day
 * (~60 pushes/month) and the rest of the budget is held in reserve for things
 * that genuinely cannot wait, like an elderly parent not confirming medication.
 */

export interface EngineOptions {
  jobs: JobStore;
  budget: BudgetStore;
  notifier: Notifier;
  families: FamilyStore;
  clock: Clock;
  morningHour: number;
  eveningHour: number;
  /** Below this many remaining pushes, urgent items fall back to the digest. */
  reserveThreshold: number;
  maxJobsPerTick?: number;
  onEvent?: (event: EngineEvent) => void;
}

export type EngineEvent =
  | { type: 'digest_sent'; familyId: string; jobCount: number; at: string }
  | { type: 'urgent_sent'; familyId: string; jobId: string }
  | { type: 'urgent_demoted'; familyId: string; jobId: string; remaining: number }
  | { type: 'budget_exhausted'; familyId: string; jobCount: number };

export function yearMonthOf(dt: DateTime): string {
  return dt.toFormat('yyyy-MM');
}

/**
 * The digest slots for a day, in the family's own timezone.
 * Exported because the job generators need to reason about the same grid.
 */
export function digestSlots(day: DateTime, morningHour: number, eveningHour: number): DateTime[] {
  const start = day.startOf('day');
  return [start.set({ hour: morningHour }), start.set({ hour: eveningHour })];
}

/** The next slot strictly after `now`, crossing midnight when needed. */
export function nextDigestSlot(now: DateTime, morningHour: number, eveningHour: number): DateTime {
  for (const slot of digestSlots(now, morningHour, eveningHour)) {
    if (slot > now) return slot;
  }
  return now.plus({ days: 1 }).startOf('day').set({ hour: morningHour });
}

/**
 * The most recent slot at or before `now`, reaching back into yesterday when
 * the day's first slot has not come round yet.
 *
 * This is the identity of the digest "round" we are currently in, and it is what
 * makes the engine restartable. Matching a one-minute window instead meant a
 * process that was asleep, deploying, or merely ticking half a second late at
 * 07:00 skipped that digest entirely and every job in it waited — which is how
 * two reminders sat PENDING for five days without anything being broken enough
 * to notice.
 */
export function currentDigestSlot(
  now: DateTime,
  morningHour: number,
  eveningHour: number,
): DateTime {
  const passed = digestSlots(now, morningHour, eveningHour).filter((slot) => slot <= now);
  const last = passed[passed.length - 1];
  if (last) return last;
  return now.minus({ days: 1 }).startOf('day').set({ hour: eveningHour });
}

export class ReminderEngine {
  /**
   * familyId -> the slot whose digest this process has already dealt with.
   * In memory on purpose: after a restart every family looks unhandled, so the
   * first tick checks for anything the downtime swallowed. That check costs one
   * query and sends nothing when the queue is clean, and jobs it does send are
   * marked SENT, so a crash-looping container cannot push the same digest twice.
   */
  private readonly handledSlot = new Map<string, string>();

  constructor(private readonly opts: EngineOptions) {}

  /**
   * One pass. Intended to run every 60 seconds; safe to run more often, since
   * jobs are claimed and marked rather than re-read.
   */
  async tick(): Promise<void> {
    const now = this.opts.clock.now();
    await this.runUrgentLane(now);

    for (const family of await this.opts.families.listActive()) {
      const localNow = now.setZone(family.timezone);
      const slot = currentDigestSlot(localNow, this.opts.morningHour, this.opts.eveningHour);
      const key = slot.toISO() ?? '';

      const seen = this.handledSlot.get(family.familyId);
      if (seen === key) continue;

      /**
       * On time means this very tick is the one that crossed the slot — the
       * engine was already running, or it booted right on top of it. Those
       * rounds look ahead to the next slot, which is what lets the morning
       * digest announce the whole day.
       *
       * Anything else is a round this process missed while it was not running,
       * and it sweeps up only what is already overdue. Reaching forward there
       * would spend a push on things that were not late yet — including urgent
       * items the budget guard had just demoted, whose entire point is to wait
       * and travel with company.
       */
      const onTime = seen !== undefined || localNow < slot.plus({ minutes: 2 });
      const horizon = onTime
        ? nextDigestSlot(localNow, this.opts.morningHour, this.opts.eveningHour)
        : slot;

      await this.runDigestFor(family.familyId, localNow, horizon);
      // Marked whether or not anything went out: an empty queue is a handled
      // round, and re-asking every 60 seconds until the next slot is waste.
      this.handledSlot.set(family.familyId, key);
    }
  }

  /**
   * Urgent items go out immediately, but only while the reserve holds. Once it
   * runs low they are demoted into the digest rather than dropped — late is a
   * far better failure than silent.
   */
  private async runUrgentLane(now: DateTime): Promise<void> {
    const due = await this.opts.jobs.claimDue(
      now.toJSDate(),
      'URGENT',
      this.opts.maxJobsPerTick ?? 100,
    );
    if (due.length === 0) return;

    const ym = yearMonthOf(now);
    const byFamily = groupBy(due, (j) => j.familyId);

    for (const [familyId, jobs] of byFamily) {
      let remaining = await this.opts.budget.remaining(familyId, ym);

      const sent: string[] = [];
      const demoted: string[] = [];

      for (const job of jobs) {
        if (remaining <= this.opts.reserveThreshold) {
          demoted.push(job.id);
          this.opts.onEvent?.({ type: 'urgent_demoted', familyId, jobId: job.id, remaining });
          continue;
        }
        await this.opts.notifier.sendUrgent(familyId, job);
        remaining -= 1;
        sent.push(job.id);
        this.opts.onEvent?.({ type: 'urgent_sent', familyId, jobId: job.id });
      }

      if (sent.length > 0) {
        await this.opts.budget.consume(familyId, ym, sent.length);
        await this.opts.jobs.markSent(sent, now.toJSDate());
      }
      if (demoted.length > 0) {
        await this.opts.jobs.demoteToDigest(demoted);
      }
    }
  }

  /**
   * Collect everything that would have fired before the next slot and send it
   * as a single push. This is what turns N reminders into 1 message.
   */
  private async runDigestFor(
    familyId: string,
    localNow: DateTime,
    horizon: DateTime,
  ): Promise<void> {
    const due = await this.opts.jobs.claimDue(
      horizon.toJSDate(),
      'DIGEST',
      this.opts.maxJobsPerTick ?? 500,
    );
    const jobs = due.filter((j) => j.familyId === familyId);
    if (jobs.length === 0) return;

    const ym = yearMonthOf(localNow);
    const remaining = await this.opts.budget.remaining(familyId, ym);

    if (remaining <= 0) {
      await this.opts.jobs.markSkipped(jobs.map((j) => j.id));
      this.opts.onEvent?.({ type: 'budget_exhausted', familyId, jobCount: jobs.length });
      return;
    }

    const messages = await this.opts.notifier.sendDigest(familyId, jobs, localNow);
    await this.opts.budget.consume(familyId, ym, Math.max(1, messages));
    await this.opts.jobs.markSent(
      jobs.map((j) => j.id),
      localNow.toJSDate(),
    );

    this.opts.onEvent?.({
      type: 'digest_sent',
      familyId,
      jobCount: jobs.length,
      at: localNow.toISO() ?? '',
    });
  }
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

export type { ReminderJob };
