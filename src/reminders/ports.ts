import type { DateTime } from 'luxon';

/**
 * Ports the reminder engine talks to. Prisma and the LINE SDK sit behind these
 * so the engine can be run against a fake clock for a whole simulated month —
 * which is the only practical way to prove the push budget holds.
 */

export type JobKind =
  | 'EVENT'
  | 'BILL'
  | 'DOCUMENT'
  | 'MEDICATION'
  | 'CHORE'
  | 'BUDGET_ALERT'
  | 'BIRTHDAY'
  | 'MONTH_SUMMARY'
  | 'LOAN_DUE'
  | 'TASK';

export type JobLane = 'DIGEST' | 'URGENT';

export interface ReminderJob {
  id: string;
  familyId: string;
  kind: JobKind;
  refId: string;
  dueAt: Date;
  lane: JobLane;
  /** Pre-rendered line for the digest, plus anything the card builder needs. */
  payload: { text: string; [k: string]: unknown };
}

export interface JobStore {
  /** PENDING jobs in `lane` whose dueAt has arrived, oldest first. */
  claimDue(now: Date, lane: JobLane, limit: number): Promise<ReminderJob[]>;
  markSent(ids: string[], at: Date): Promise<void>;
  markSkipped(ids: string[]): Promise<void>;
  /** Move an urgent job into the digest when the budget is too low to push. */
  demoteToDigest(ids: string[]): Promise<void>;
}

export interface BudgetStore {
  /** Pushes still available this month for a family. */
  remaining(familyId: string, yearMonth: string): Promise<number>;
  /** Records `count` pushes as used. */
  consume(familyId: string, yearMonth: string, count: number): Promise<void>;
}

export interface Notifier {
  /**
   * One push carrying every job in the batch. Returns how many LINE messages
   * it actually contained — LINE bills per message object, not per push, and
   * the digest carries a picture alongside its card.
   */
  sendDigest(familyId: string, jobs: ReminderJob[], slot: DateTime): Promise<number>;
  sendUrgent(familyId: string, job: ReminderJob): Promise<void>;
}

export interface FamilyClockInfo {
  familyId: string;
  timezone: string;
}

export interface FamilyStore {
  listActive(): Promise<FamilyClockInfo[]>;
}

export interface Clock {
  now(): DateTime;
}
