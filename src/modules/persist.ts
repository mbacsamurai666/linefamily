import type { PrismaClient } from '@prisma/client';
import type { DateTime } from 'luxon';
import type { Draft } from '../intent/types.js';
import {
  checkBudgetAlert,
  firstChoreDueAt,
  generateBillJobs,
  generateChoreJobs,
  generateDocumentJobs,
  generateEventJobs,
  generateLoanJobs,
  generateMedicationJobs,
  generateMonthSummaryJob,
  generateTaskJobs,
} from '../reminders/generate.js';
import { familyLeadTimes } from './leadTimes.js';

/**
 * The only place a confirmed Draft becomes a database row.
 *
 * Every path in here runs after an explicit tap on ยืนยัน — parsers never
 * reach the database on their own, whether they are rule-based or the LLM.
 */

export interface PersistContext {
  prisma: PrismaClient;
  familyId: string;
  memberId: string | null;
  now: DateTime;
}

export interface PersistResult {
  summary: string;
  /**
   * Set when the row just saved can still take a photo — the caller offers to
   * keep one, and files whatever arrives next against this id.
   */
  photoTarget?: { documentId: string; documentName: string };
}

export async function persistDraft(draft: Draft, ctx: PersistContext): Promise<PersistResult> {
  switch (draft.kind) {
    case 'event':
      return persistEvent(draft, ctx);
    case 'events':
      return persistEventBatch(draft, ctx);
    case 'expense':
      return persistExpense(draft, ctx);
    case 'shopping':
      return persistShopping(draft, ctx);
    case 'bill':
      return persistBill(draft, ctx);
    case 'document':
      return persistDocument(draft, ctx);
    case 'med':
      return persistMed(draft, ctx);
    case 'chore':
      return persistChore(draft, ctx);
    case 'loan':
      return persistLoan(draft, ctx);
    case 'asset':
      return persistAsset(draft, ctx);
    case 'deposit':
      return persistDeposit(draft, ctx);
    case 'task':
      return persistTask(draft, ctx);
  }
}

async function persistEvent(
  draft: Extract<Draft, { kind: 'event' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  const event = await ctx.prisma.event.create({
    data: {
      familyId: ctx.familyId,
      title: draft.title,
      category: draft.category,
      startAt: draft.startAt.toJSDate(),
      ...(draft.endAt !== undefined ? { endAt: draft.endAt.toJSDate() } : {}),
      allDay: draft.allDay,
      reminderOffsets: (await familyLeadTimes(ctx.prisma, ctx.familyId)).event,
      ...(draft.location !== undefined ? { location: draft.location } : {}),
      ...(draft.note !== undefined ? { note: draft.note } : {}),
      ...(draft.rrule !== undefined ? { rrule: draft.rrule } : {}),
      ...(ctx.memberId !== null ? { ownerId: ctx.memberId } : {}),
    },
  });

  // Who the event is *about* (a child at school, say) is tracked separately
  // from ownerId (who reported it) via EventAttendee — a name that does not
  // match a family member is dropped rather than failing the whole save.
  if (draft.attendeeName) {
    const attendee = await ctx.prisma.member.findFirst({
      where: { familyId: ctx.familyId, displayName: draft.attendeeName },
      select: { id: true },
    });
    if (attendee) {
      await ctx.prisma.eventAttendee.create({
        data: { eventId: event.id, memberId: attendee.id },
      });
    }
  }

  await generateEventJobs(ctx.prisma, event.id, ctx.now);

  return { summary: `บันทึกนัด "${draft.title}" แล้ว` };
}

/**
 * A notice read off a photo, saved in one tap. Something already on the
 * calendar under the same name and day is left alone — the same notice sent
 * twice must not put every exam in twice.
 */
async function persistEventBatch(
  draft: Extract<Draft, { kind: 'events' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  let saved = 0;
  let existing = 0;
  for (const ev of draft.events) {
    const twin = await ctx.prisma.event.findFirst({
      where: { familyId: ctx.familyId, title: ev.title, startAt: ev.startAt.toJSDate() },
      select: { id: true },
    });
    if (twin) {
      existing += 1;
      continue;
    }
    await persistEvent(ev, ctx);
    saved += 1;
  }
  const note = existing > 0 ? ` (อีก ${existing} นัดมีอยู่แล้ว)` : '';
  return { summary: `ลงปฏิทิน ${saved} นัดแล้ว${note}` };
}

async function persistExpense(
  draft: Extract<Draft, { kind: 'expense' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  // Categories are created on first use so nobody has to set them up first.
  let categoryId: string | undefined;
  if (draft.categoryName) {
    const category = await ctx.prisma.category.upsert({
      where: {
        familyId_name_kind: {
          familyId: ctx.familyId,
          name: draft.categoryName,
          kind: draft.direction,
        },
      },
      create: { familyId: ctx.familyId, name: draft.categoryName, kind: draft.direction },
      update: {},
    });
    categoryId = category.id;
  }

  const transaction = await ctx.prisma.transaction.create({
    data: {
      familyId: ctx.familyId,
      amount: draft.amount,
      direction: draft.direction,
      occurredAt: draft.occurredAt.toJSDate(),
      ...(categoryId !== undefined ? { categoryId } : {}),
      ...(draft.note !== undefined ? { note: draft.note } : {}),
      ...(draft.receiptFileId !== undefined ? { receiptFileId: draft.receiptFileId } : {}),
      ...(ctx.memberId !== null ? { paidById: ctx.memberId } : {}),
    },
  });

  let splitNote = '';
  if (draft.splitWithNames && draft.splitWithNames.length > 0 && ctx.memberId !== null) {
    splitNote = await createTxSplits(ctx, transaction.id, draft.amount, draft.splitWithNames);
  }

  // Secondary effects: recording the expense must succeed and be reported
  // correctly even if the budget check or the month summary refresh fails.
  if (draft.direction === 'OUT') {
    try {
      if (categoryId !== undefined) {
        await checkBudgetAlert(ctx.prisma, ctx.familyId, categoryId, ctx.now);
      }
      await generateMonthSummaryJob(ctx.prisma, ctx.familyId, ctx.now);
    } catch {
      // A missed budget alert or a stale month summary is not worth failing
      // an otherwise-successful expense entry over.
    }
  }

  return { summary: `บันทึกรายการเงินแล้ว${splitNote}` };
}

/**
 * Splits a transaction between the payer and named members, satang-exact —
 * the payer absorbs the rounding remainder so the shares always sum to the
 * full amount. Names that do not match a family member are silently
 * dropped; if that leaves nobody to split with, the transaction is simply
 * recorded unsplit rather than the whole save failing over a typo.
 */
async function createTxSplits(
  ctx: PersistContext,
  transactionId: string,
  amount: number,
  names: string[],
): Promise<string> {
  const found = await ctx.prisma.member.findMany({
    where: { familyId: ctx.familyId, displayName: { in: names } },
    select: { id: true, displayName: true },
  });

  const otherIds = [...new Set(found.map((m) => m.id))].filter((id) => id !== ctx.memberId);
  if (otherIds.length === 0) return '';

  const participantIds = [ctx.memberId as string, ...otherIds];
  const share = Math.floor(amount / participantIds.length);
  const remainder = amount - share * participantIds.length;

  await ctx.prisma.txSplit.createMany({
    data: participantIds.map((memberId, i) => ({
      transactionId,
      memberId,
      // The payer (index 0) absorbs the remainder so shares sum exactly.
      share: i === 0 ? share + remainder : share,
    })),
  });

  return ` (หารกับ ${found.map((m) => m.displayName).join(', ')})`;
}

async function persistBill(
  draft: Extract<Draft, { kind: 'bill' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  const bill = await ctx.prisma.bill.create({
    data: {
      familyId: ctx.familyId,
      name: draft.name,
      dueDay: draft.dueDay,
      reminderOffsets: (await familyLeadTimes(ctx.prisma, ctx.familyId)).bill,
      ...(draft.amount !== undefined ? { amount: draft.amount } : {}),
    },
  });

  await generateBillJobs(ctx.prisma, bill.id, ctx.now);

  return { summary: `ตั้งบิล "${draft.name}" ทุกวันที่ ${draft.dueDay} แล้ว` };
}

async function persistDocument(
  draft: Extract<Draft, { kind: 'document' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  const document = await ctx.prisma.document.create({
    data: {
      familyId: ctx.familyId,
      name: draft.name,
      type: draft.type,
      expiresAt: draft.expiresAt.toJSDate(),
      reminderOffsets: (await familyLeadTimes(ctx.prisma, ctx.familyId)).document,
      ...(ctx.memberId !== null ? { ownerId: ctx.memberId } : {}),
    },
  });

  await generateDocumentJobs(ctx.prisma, document.id, ctx.now);

  return {
    summary: `บันทึกเอกสาร "${draft.name}" แล้ว`,
    photoTarget: { documentId: document.id, documentName: document.name },
  };
}

async function persistMed(
  draft: Extract<Draft, { kind: 'med' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  if (ctx.memberId === null) {
    // Medication belongs to whoever reported it — there is no "for whom?"
    // step in the chat flow, so an unidentified sender has to be rejected
    // rather than silently attributed to nobody.
    throw new Error('ไม่ทราบว่าเป็นยาของใคร กรุณาพิมพ์ในกลุ่มด้วยบัญชี LINE ของตัวเอง');
  }

  const med = await ctx.prisma.medication.create({
    data: {
      memberId: ctx.memberId,
      name: draft.name,
      times: draft.times,
      ...(draft.dosage !== undefined ? { dosage: draft.dosage } : {}),
    },
  });

  await generateMedicationJobs(ctx.prisma, med.id, ctx.now);

  return { summary: `ตั้งเตือนยา "${draft.name}" แล้ว` };
}

/**
 * A chore rotation is typed as display names; this resolves them to member
 * ids, keeping the order the family listed them in, and reports the names it
 * could not place.
 */
export async function resolveRotation(
  prisma: PrismaClient,
  familyId: string,
  names: string[],
): Promise<{ memberIds: string[]; unresolved: string[] }> {
  if (names.length === 0) return { memberIds: [], unresolved: [] };

  const found = await prisma.member.findMany({
    where: { familyId, displayName: { in: names } },
    select: { id: true, displayName: true },
  });
  const idByName = new Map(found.map((m) => [m.displayName, m.id]));

  return {
    memberIds: names.map((n) => idByName.get(n)).filter((id): id is string => id !== undefined),
    unresolved: names.filter((n) => !idByName.has(n)),
  };
}

async function persistChore(
  draft: Extract<Draft, { kind: 'chore' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  const { memberIds: rotationMemberIds } = await resolveRotation(
    ctx.prisma,
    ctx.familyId,
    draft.rotationNames,
  );

  const chore = await ctx.prisma.chore.create({
    data: {
      familyId: ctx.familyId,
      name: draft.name,
      cadence: draft.cadence,
      rotationMemberIds,
      nextDueAt: firstChoreDueAt(ctx.now, draft.cadence).toJSDate(),
    },
  });

  await generateChoreJobs(ctx.prisma, chore.id, ctx.now);

  const unresolved = draft.rotationNames.length - rotationMemberIds.length;
  const note = unresolved > 0 ? ` (หาไม่เจอ ${unresolved} ชื่อ ข้ามไปก่อน)` : '';

  return { summary: `ตั้งเวร "${draft.name}" แล้ว${note}` };
}

async function persistLoan(
  draft: Extract<Draft, { kind: 'loan' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  const loan = await ctx.prisma.loan.create({
    data: {
      familyId: ctx.familyId,
      borrowerName: draft.borrowerName,
      principalSatang: draft.principalSatang,
      lentAt: ctx.now.toJSDate(),
      ...(draft.dueAt !== undefined ? { dueAt: draft.dueAt.toJSDate() } : {}),
      ...(draft.note !== undefined ? { note: draft.note } : {}),
    },
  });

  if (loan.dueAt) {
    await generateLoanJobs(ctx.prisma, loan.id, ctx.now);
  }

  return { summary: `บันทึกเงินให้ "${draft.borrowerName}" ยืมแล้ว` };
}

async function persistAsset(
  draft: Extract<Draft, { kind: 'asset' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  await ctx.prisma.asset.create({
    data: {
      familyId: ctx.familyId,
      name: draft.name,
      category: draft.category,
      valueSatang: draft.valueSatang,
      ...(draft.acquiredAt !== undefined ? { acquiredAt: draft.acquiredAt.toJSDate() } : {}),
      ...(draft.note !== undefined ? { note: draft.note } : {}),
    },
  });

  return { summary: `บันทึกทรัพย์สิน "${draft.name}" แล้ว` };
}

async function persistDeposit(
  draft: Extract<Draft, { kind: 'deposit' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  await ctx.prisma.deposit.create({
    data: {
      familyId: ctx.familyId,
      name: draft.name,
      balanceSatang: draft.balanceSatang,
      ...(draft.note !== undefined ? { note: draft.note } : {}),
    },
  });

  return { summary: `บันทึกบัญชีเงินฝาก "${draft.name}" แล้ว` };
}

async function persistTask(
  draft: Extract<Draft, { kind: 'task' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  // A name nobody in the family matches is dropped rather than failing the
  // save, the same way an event's attendee is.
  let assigneeId: string | undefined;
  if (draft.assigneeName) {
    const member = await ctx.prisma.member.findFirst({
      where: { familyId: ctx.familyId, displayName: draft.assigneeName },
      select: { id: true },
    });
    assigneeId = member?.id;
  }

  // New cards land at the top of the ต้องทำ column.
  const lowest = await ctx.prisma.task.findFirst({
    where: { familyId: ctx.familyId, status: 'TODO' },
    orderBy: { sortOrder: 'asc' },
    select: { sortOrder: true },
  });

  const task = await ctx.prisma.task.create({
    data: {
      familyId: ctx.familyId,
      title: draft.title,
      sortOrder: (lowest?.sortOrder ?? 0) - 1,
      reminderOffsets: (await familyLeadTimes(ctx.prisma, ctx.familyId)).task,
      ...(draft.dueAt !== undefined ? { dueAt: draft.dueAt.toJSDate() } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(draft.note !== undefined ? { note: draft.note } : {}),
    },
  });

  if (task.dueAt) {
    await generateTaskJobs(ctx.prisma, task.id, ctx.now);
  }

  return { summary: `เพิ่มงาน "${draft.title}" ลงบอร์ดแล้ว` };
}

async function persistShopping(
  draft: Extract<Draft, { kind: 'shopping' }>,
  ctx: PersistContext,
): Promise<PersistResult> {
  await ctx.prisma.shoppingItem.createMany({
    data: draft.items.map((item) => ({
      familyId: ctx.familyId,
      name: item.name,
      ...(item.qty !== undefined ? { qty: item.qty } : {}),
      ...(ctx.memberId !== null ? { addedById: ctx.memberId } : {}),
    })),
  });

  return { summary: `เพิ่ม ${draft.items.length} รายการลงลิสต์ซื้อของแล้ว` };
}
