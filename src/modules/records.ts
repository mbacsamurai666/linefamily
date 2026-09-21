import type { PrismaClient } from '@prisma/client';
import type { DateTime } from 'luxon';
import type { AssetCategory } from '../intent/assetTypes.js';
import type { EventCategory } from '../intent/categories.js';
import type { DocumentType } from '../intent/documentTypes.js';
import { expandOccurrences } from '../reminders/occurrences.js';
import {
  checkBudgetAlert,
  generateBillJobs,
  generateChoreJobs,
  generateDocumentJobs,
  generateEventJobs,
  generateLoanJobs,
  generateMedicationJobs,
  generateMonthSummaryJob,
  generateTaskJobs,
} from '../reminders/generate.js';

/**
 * Editing and deleting what persist.ts wrote.
 *
 * Two rules hold everywhere in here:
 *
 *  1. Every lookup is scoped by familyId, so one family can never reach
 *     another's rows even with a guessed id.
 *  2. A row that owned reminders must retire them on the way out.
 *     NotificationJob.refId is a plain string, not a foreign key, so nothing
 *     cascades — a deleted appointment whose jobs were left PENDING would
 *     still be announced in tomorrow's digest.
 *
 * Edits don't need that cleanup by hand: the generators re-emit through
 * replaceJobs, which cancels the stale times and creates the new ones.
 */

export interface RecordContext {
  prisma: PrismaClient;
  familyId: string;
  now: DateTime;
}

type ReminderKind = 'EVENT' | 'BILL' | 'DOCUMENT' | 'MEDICATION' | 'CHORE' | 'LOAN_DUE' | 'TASK';

async function cancelJobs(
  prisma: PrismaClient,
  kind: ReminderKind,
  refId: string,
): Promise<void> {
  await prisma.notificationJob.updateMany({
    where: { kind, refId, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  });
}

/** Secondary effects that must never fail the edit that triggered them. */
async function refreshMoneySideEffects(
  ctx: RecordContext,
  categoryId: string | null,
): Promise<void> {
  try {
    if (categoryId) await checkBudgetAlert(ctx.prisma, ctx.familyId, categoryId, ctx.now);
    await generateMonthSummaryJob(ctx.prisma, ctx.familyId, ctx.now);
  } catch {
    // A stale budget alert or month summary is not worth failing an edit over.
  }
}

// ---------------------------------------------------------------- events

export interface EventPatch {
  title?: string;
  startAt?: DateTime;
  /** Null makes it a single day again. */
  endAt?: DateTime | null;
  allDay?: boolean;
  category?: EventCategory;
  location?: string | null;
  note?: string | null;
  /** Null clears it; a name that matches no member is dropped, as on create. */
  attendeeName?: string | null;
  /** Null (or empty) turns a repeating appointment back into a one-off. */
  rrule?: string | null;
}

export async function updateEvent(
  ctx: RecordContext,
  id: string,
  patch: EventPatch,
): Promise<boolean> {
  const existing = await ctx.prisma.event.findFirst({
    where: { id, familyId: ctx.familyId },
    select: { id: true, startAt: true, endAt: true, exdates: true },
  });
  if (!existing) return false;

  // Moving the whole series carries its exceptions with it: "skip the 21st"
  // should still skip the 21st after the appointment moves from 9:00 to 10:00.
  const shiftMs =
    patch.startAt !== undefined ? patch.startAt.toMillis() - existing.startAt.getTime() : 0;

  await ctx.prisma.event.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.startAt !== undefined ? { startAt: patch.startAt.toJSDate() } : {}),
      // A trip moved a week later ends a week later, unless the edit says otherwise.
      ...(patch.endAt !== undefined
        ? { endAt: patch.endAt ? patch.endAt.toJSDate() : null }
        : shiftMs !== 0 && existing.endAt
          ? { endAt: new Date(existing.endAt.getTime() + shiftMs) }
          : {}),
      ...(shiftMs !== 0 && existing.exdates.length > 0
        ? { exdates: existing.exdates.map((d) => new Date(d.getTime() + shiftMs)) }
        : {}),
      ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.location !== undefined ? { location: patch.location } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.rrule !== undefined ? { rrule: patch.rrule || null } : {}),
    },
  });

  // Who the event is about lives in a join table, so it is replaced wholesale
  // rather than patched.
  if (patch.attendeeName !== undefined) {
    await ctx.prisma.eventAttendee.deleteMany({ where: { eventId: id } });
    if (patch.attendeeName) {
      const member = await ctx.prisma.member.findFirst({
        where: { familyId: ctx.familyId, displayName: patch.attendeeName },
        select: { id: true },
      });
      if (member) {
        await ctx.prisma.eventAttendee.create({ data: { eventId: id, memberId: member.id } });
      }
    }
  }

  await generateEventJobs(ctx.prisma, id, ctx.now);
  return true;
}

/**
 * A repeating appointment of this family, and proof that `occurrence` really
 * is one of its dates — so a stale screen or a guessed timestamp cannot add a
 * meaningless exception.
 */
async function findOccurrence(ctx: RecordContext, id: string, occurrence: DateTime) {
  const event = await ctx.prisma.event.findFirst({
    where: { id, familyId: ctx.familyId, rrule: { not: null } },
    include: { attendees: { select: { memberId: true } } },
  });
  if (!event?.rrule) return null;

  const zone = ctx.now.zoneName ?? 'Asia/Bangkok';
  let matches: DateTime[];
  try {
    matches = expandOccurrences(
      event.startAt,
      event.rrule,
      zone,
      occurrence.minus({ minutes: 1 }),
      occurrence.plus({ minutes: 1 }),
      1,
      event.exdates,
    );
  } catch {
    return null;
  }
  if (!matches.some((m) => m.toMillis() === occurrence.toMillis())) return null;

  return event;
}

/** "ข้ามครั้งนี้" — one date of a repeating appointment stops happening. */
export async function skipOccurrence(
  ctx: RecordContext,
  id: string,
  occurrence: DateTime,
): Promise<boolean> {
  const event = await findOccurrence(ctx, id, occurrence);
  if (!event) return false;

  await ctx.prisma.event.update({
    where: { id },
    data: { exdates: { push: occurrence.toJSDate() } },
  });
  await generateEventJobs(ctx.prisma, id, ctx.now);
  return true;
}

/**
 * "แก้เฉพาะครั้งนี้" — one date of a repeating appointment becomes its own
 * one-off, which can then be moved or renamed without touching the rest.
 *
 * The series gets an exception for that date and a copy takes its place, so
 * everything the family already knows about the appointment — who it is for,
 * where, the reminders — comes along unless the patch says otherwise.
 * Returns the new one-off's id.
 */
export async function detachOccurrence(
  ctx: RecordContext,
  id: string,
  occurrence: DateTime,
  patch: EventPatch,
): Promise<string | null> {
  const series = await findOccurrence(ctx, id, occurrence);
  if (!series) return null;

  const durationMs = series.endAt ? series.endAt.getTime() - series.startAt.getTime() : null;

  const single = await ctx.prisma.$transaction(async (tx) => {
    await tx.event.update({
      where: { id },
      data: { exdates: { push: occurrence.toJSDate() } },
    });
    return tx.event.create({
      data: {
        familyId: series.familyId,
        title: series.title,
        category: series.category,
        startAt: occurrence.toJSDate(),
        endAt: durationMs === null ? null : new Date(occurrence.toMillis() + durationMs),
        allDay: series.allDay,
        location: series.location,
        ownerId: series.ownerId,
        note: series.note,
        reminderOffsets: series.reminderOffsets,
        attendees: { create: series.attendees.map((a) => ({ memberId: a.memberId })) },
      },
    });
  });

  // The copy is a one-off by definition, whatever the form sent.
  const { rrule: _ignored, ...rest } = patch;
  await updateEvent(ctx, single.id, rest);
  await generateEventJobs(ctx.prisma, id, ctx.now);
  return single.id;
}

export async function deleteEvent(ctx: RecordContext, id: string): Promise<boolean> {
  const deleted = await ctx.prisma.event.deleteMany({ where: { id, familyId: ctx.familyId } });
  if (deleted.count === 0) return false;

  await cancelJobs(ctx.prisma, 'EVENT', id);
  return true;
}

// ---------------------------------------------------------------- transactions

export interface TransactionPatch {
  /** Satang. */
  amount?: number;
  direction?: 'IN' | 'OUT';
  categoryName?: string | null;
  note?: string | null;
  occurredAt?: DateTime;
}

export async function updateTransaction(
  ctx: RecordContext,
  id: string,
  patch: TransactionPatch,
): Promise<boolean> {
  const existing = await ctx.prisma.transaction.findFirst({
    where: { id, familyId: ctx.familyId },
    include: { category: { select: { name: true } } },
  });
  if (!existing) return false;

  const direction = patch.direction ?? existing.direction;

  // Categories are keyed by (name, kind), so a direction flip has to re-home
  // the category too — otherwise an OUT category ends up on an IN row.
  const categoryName =
    patch.categoryName !== undefined ? patch.categoryName : (existing.category?.name ?? null);

  let categoryId: string | null = existing.categoryId;
  if (patch.categoryName !== undefined || direction !== existing.direction) {
    categoryId = categoryName
      ? (
          await ctx.prisma.category.upsert({
            where: {
              familyId_name_kind: { familyId: ctx.familyId, name: categoryName, kind: direction },
            },
            create: { familyId: ctx.familyId, name: categoryName, kind: direction },
            update: {},
          })
        ).id
      : null;
  }

  await ctx.prisma.transaction.update({
    where: { id },
    data: {
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.direction !== undefined ? { direction } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.occurredAt !== undefined ? { occurredAt: patch.occurredAt.toJSDate() } : {}),
      categoryId,
    },
  });

  await refreshMoneySideEffects(ctx, direction === 'OUT' ? categoryId : null);
  return true;
}

export async function deleteTransaction(ctx: RecordContext, id: string): Promise<boolean> {
  // TxSplit rows cascade with the transaction, so a shared cost disappears
  // from the net-balance summary along with it.
  const deleted = await ctx.prisma.transaction.deleteMany({
    where: { id, familyId: ctx.familyId },
  });
  if (deleted.count === 0) return false;

  await refreshMoneySideEffects(ctx, null);
  return true;
}

// ---------------------------------------------------------------- bills

export interface BillPatch {
  name?: string;
  /** Satang; null for a bill whose amount varies month to month. */
  amount?: number | null;
  dueDay?: number;
  active?: boolean;
}

export async function updateBill(
  ctx: RecordContext,
  id: string,
  patch: BillPatch,
): Promise<boolean> {
  const existing = await ctx.prisma.bill.findFirst({
    where: { id, familyId: ctx.familyId },
    select: { id: true },
  });
  if (!existing) return false;

  await ctx.prisma.bill.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.dueDay !== undefined ? { dueDay: patch.dueDay } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
  });

  await generateBillJobs(ctx.prisma, id, ctx.now);
  return true;
}

export async function deleteBill(ctx: RecordContext, id: string): Promise<boolean> {
  // Transaction.billId is SetNull, so payments already recorded survive.
  const deleted = await ctx.prisma.bill.deleteMany({ where: { id, familyId: ctx.familyId } });
  if (deleted.count === 0) return false;

  await cancelJobs(ctx.prisma, 'BILL', id);
  return true;
}

// ---------------------------------------------------------------- documents

export interface DocumentPatch {
  name?: string;
  type?: DocumentType;
  expiresAt?: DateTime;
}

export async function updateDocument(
  ctx: RecordContext,
  id: string,
  patch: DocumentPatch,
): Promise<boolean> {
  const existing = await ctx.prisma.document.findFirst({
    where: { id, familyId: ctx.familyId },
    select: { id: true },
  });
  if (!existing) return false;

  await ctx.prisma.document.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt.toJSDate() } : {}),
    },
  });

  await generateDocumentJobs(ctx.prisma, id, ctx.now);
  return true;
}

export async function deleteDocument(ctx: RecordContext, id: string): Promise<boolean> {
  const deleted = await ctx.prisma.document.deleteMany({ where: { id, familyId: ctx.familyId } });
  if (deleted.count === 0) return false;

  await cancelJobs(ctx.prisma, 'DOCUMENT', id);
  return true;
}

// ---------------------------------------------------------------- medication

export interface MedicationPatch {
  name?: string;
  dosage?: string | null;
  /** Local times of day, "HH:mm". */
  times?: string[];
  active?: boolean;
}

/** Medication hangs off a Member, so family scoping goes through that. */
export async function updateMedication(
  ctx: RecordContext,
  id: string,
  patch: MedicationPatch,
): Promise<boolean> {
  const existing = await ctx.prisma.medication.findFirst({
    where: { id, member: { familyId: ctx.familyId } },
    select: { id: true },
  });
  if (!existing) return false;

  await ctx.prisma.medication.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.dosage !== undefined ? { dosage: patch.dosage } : {}),
      ...(patch.times !== undefined ? { times: patch.times } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
  });

  await generateMedicationJobs(ctx.prisma, id, ctx.now);
  return true;
}

export async function deleteMedication(ctx: RecordContext, id: string): Promise<boolean> {
  const deleted = await ctx.prisma.medication.deleteMany({
    where: { id, member: { familyId: ctx.familyId } },
  });
  if (deleted.count === 0) return false;

  // MedLog cascades; the URGENT escalation jobs do not, so retire them here.
  await cancelJobs(ctx.prisma, 'MEDICATION', id);
  return true;
}

// ---------------------------------------------------------------- chores

export interface ChorePatch {
  name?: string;
  cadence?: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  active?: boolean;
  /**
   * The new rotation, already resolved, in order. The first person in it is
   * up next: the edit form lists the rotation starting from whoever's turn it
   * is, so saving it unchanged leaves the turn where it was.
   */
  rotationMemberIds?: string[];
}

export async function updateChore(
  ctx: RecordContext,
  id: string,
  patch: ChorePatch,
): Promise<boolean> {
  const existing = await ctx.prisma.chore.findFirst({
    where: { id, familyId: ctx.familyId },
    select: { id: true },
  });
  if (!existing) return false;

  await ctx.prisma.chore.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.rotationMemberIds !== undefined
        ? { rotationMemberIds: patch.rotationMemberIds, rotationCursor: 0 }
        : {}),
    },
  });

  await generateChoreJobs(ctx.prisma, id, ctx.now);
  return true;
}

export async function deleteChore(ctx: RecordContext, id: string): Promise<boolean> {
  const deleted = await ctx.prisma.chore.deleteMany({ where: { id, familyId: ctx.familyId } });
  if (deleted.count === 0) return false;

  await cancelJobs(ctx.prisma, 'CHORE', id);
  return true;
}

// ---------------------------------------------------------------- loans

export interface LoanPatch {
  borrowerName?: string;
  /** Satang. */
  principalSatang?: number;
  repaidSatang?: number;
  dueAt?: DateTime | null;
  note?: string | null;
  active?: boolean;
}

export async function updateLoan(
  ctx: RecordContext,
  id: string,
  patch: LoanPatch,
): Promise<boolean> {
  const existing = await ctx.prisma.loan.findFirst({
    where: { id, familyId: ctx.familyId },
    select: { id: true },
  });
  if (!existing) return false;

  await ctx.prisma.loan.update({
    where: { id },
    data: {
      ...(patch.borrowerName !== undefined ? { borrowerName: patch.borrowerName } : {}),
      ...(patch.principalSatang !== undefined ? { principalSatang: patch.principalSatang } : {}),
      ...(patch.repaidSatang !== undefined ? { repaidSatang: patch.repaidSatang } : {}),
      ...(patch.dueAt !== undefined
        ? { dueAt: patch.dueAt === null ? null : patch.dueAt.toJSDate() }
        : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
    },
  });

  // Clearing the due date retires the reminder — generateLoanJobs handles that.
  await generateLoanJobs(ctx.prisma, id, ctx.now);
  return true;
}

export async function deleteLoan(ctx: RecordContext, id: string): Promise<boolean> {
  const deleted = await ctx.prisma.loan.deleteMany({ where: { id, familyId: ctx.familyId } });
  if (deleted.count === 0) return false;

  await cancelJobs(ctx.prisma, 'LOAN_DUE', id);
  return true;
}

// ---------------------------------------------------------------- assets & deposits

export interface AssetPatch {
  name?: string;
  category?: AssetCategory;
  /** Satang. */
  valueSatang?: number;
  acquiredAt?: DateTime | null;
  note?: string | null;
}

export async function updateAsset(
  ctx: RecordContext,
  id: string,
  patch: AssetPatch,
): Promise<boolean> {
  const updated = await ctx.prisma.asset.updateMany({
    where: { id, familyId: ctx.familyId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.valueSatang !== undefined ? { valueSatang: patch.valueSatang } : {}),
      ...(patch.acquiredAt !== undefined
        ? { acquiredAt: patch.acquiredAt === null ? null : patch.acquiredAt.toJSDate() }
        : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
    },
  });
  return updated.count > 0;
}

export async function deleteAsset(ctx: RecordContext, id: string): Promise<boolean> {
  const deleted = await ctx.prisma.asset.deleteMany({ where: { id, familyId: ctx.familyId } });
  return deleted.count > 0;
}

export interface DepositPatch {
  name?: string;
  /** Satang. */
  balanceSatang?: number;
  note?: string | null;
}

export async function updateDeposit(
  ctx: RecordContext,
  id: string,
  patch: DepositPatch,
): Promise<boolean> {
  const updated = await ctx.prisma.deposit.updateMany({
    where: { id, familyId: ctx.familyId },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.balanceSatang !== undefined ? { balanceSatang: patch.balanceSatang } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
    },
  });
  return updated.count > 0;
}

export async function deleteDeposit(ctx: RecordContext, id: string): Promise<boolean> {
  const deleted = await ctx.prisma.deposit.deleteMany({ where: { id, familyId: ctx.familyId } });
  return deleted.count > 0;
}

// ---------------------------------------------------------------- tasks

export interface TaskPatch {
  title?: string;
  status?: 'TODO' | 'DOING' | 'DONE';
  assigneeName?: string | null;
  dueAt?: DateTime | null;
  note?: string | null;
  sortOrder?: number;
}

export async function updateTask(
  ctx: RecordContext,
  id: string,
  patch: TaskPatch,
): Promise<boolean> {
  const existing = await ctx.prisma.task.findFirst({
    where: { id, familyId: ctx.familyId },
    select: { id: true, status: true },
  });
  if (!existing) return false;

  let assigneeId: string | null | undefined;
  if (patch.assigneeName !== undefined) {
    assigneeId = null;
    if (patch.assigneeName) {
      const member = await ctx.prisma.member.findFirst({
        where: { familyId: ctx.familyId, displayName: patch.assigneeName },
        select: { id: true },
      });
      assigneeId = member?.id ?? null;
    }
  }

  await ctx.prisma.task.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(patch.dueAt !== undefined
        ? { dueAt: patch.dueAt === null ? null : patch.dueAt.toJSDate() }
        : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      // Finishing stamps the time; re-opening clears it, so "done today"
      // counts stay honest when a card comes back.
      ...(patch.status === 'DONE'
        ? { doneAt: ctx.now.toJSDate() }
        : patch.status !== undefined
          ? { doneAt: null }
          : {}),
    },
  });

  // A finished card stops reminding — generateTaskJobs handles that.
  await generateTaskJobs(ctx.prisma, id, ctx.now);
  return true;
}

export async function deleteTask(ctx: RecordContext, id: string): Promise<boolean> {
  const deleted = await ctx.prisma.task.deleteMany({ where: { id, familyId: ctx.familyId } });
  if (deleted.count === 0) return false;

  await cancelJobs(ctx.prisma, 'TASK', id);
  return true;
}

// ---------------------------------------------------------------- shopping

export async function deleteShoppingItem(ctx: RecordContext, id: string): Promise<boolean> {
  const deleted = await ctx.prisma.shoppingItem.deleteMany({
    where: { id, familyId: ctx.familyId },
  });
  return deleted.count > 0;
}
