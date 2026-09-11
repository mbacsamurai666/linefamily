import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { CATEGORY_LABEL, type EventCategory } from '../intent/categories.js';
import { formatRelativeDay, formatThaiDateTime } from '../line/format.js';
import { computeExpenseSummary } from '../modules/expenseSummary.js';
import { formatSatang } from '../thai/number.js';
import { recurrenceLabel } from '../thai/recurrence.js';
import { expandOccurrences } from './occurrences.js';

/**
 * Job generation. Every module that owns something with a due date calls in
 * here after it writes a row; nothing else in the codebase creates jobs.
 *
 * The @@unique([kind, refId, dueAt]) constraint makes regeneration idempotent,
 * so an edit can simply cancel and re-emit without bookkeeping.
 */

async function replaceJobs(
  prisma: PrismaClient,
  kind:
    | 'EVENT'
    | 'BILL'
    | 'DOCUMENT'
    | 'MEDICATION'
    | 'CHORE'
    | 'MONTH_SUMMARY'
    | 'LOAN_DUE'
    | 'TASK'
    | 'BIRTHDAY',
  refId: string,
  jobs: Array<{ familyId: string; dueAt: Date; lane?: 'DIGEST' | 'URGENT'; text: string }>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Cancel only what has not gone out yet — a reminder already delivered
    // must stay SENT so it is never re-sent after an edit.
    await tx.notificationJob.updateMany({
      where: { kind, refId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });

    for (const job of jobs) {
      const lane = job.lane ?? 'DIGEST';
      const payload = { text: job.text };

      // Revive a slot this same call just cancelled. Scoping the update to
      // CANCELLED is what stops an edit from resurrecting — and re-sending —
      // a reminder that already went out.
      const revived = await tx.notificationJob.updateMany({
        where: { kind, refId, dueAt: job.dueAt, status: 'CANCELLED' },
        data: { status: 'PENDING', lane, payload },
      });
      if (revived.count > 0) continue;

      // Nothing to revive. Create it, unless a delivered reminder already
      // occupies this exact slot — skipDuplicates leaves that one intact.
      await tx.notificationJob.createMany({
        data: [
          {
            familyId: job.familyId,
            kind,
            refId,
            dueAt: job.dueAt,
            lane,
            payload,
          },
        ],
        skipDuplicates: true,
      });
    }
  });
}

/** Drop reminder times that are already in the past — nobody wants a backlog. */
function futureOnly(times: DateTime[], now: DateTime): DateTime[] {
  return times.filter((t) => t > now);
}

export async function generateEventJobs(
  prisma: PrismaClient,
  eventId: string,
  now: DateTime,
): Promise<void> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      owner: { select: { displayName: true } },
      attendees: { include: { member: { select: { displayName: true } } } },
    },
  });
  if (!event) return;

  const zone = (
    await prisma.family.findUnique({
      where: { id: event.familyId },
      select: { timezone: true },
    })
  )?.timezone ?? 'Asia/Bangkok';

  const label = CATEGORY_LABEL[event.category as EventCategory];
  // Who the reminder names: for a school event this is the child it's about,
  // which matters more to the reader than who happened to type it in.
  const attendeeNames = event.attendees.map((a) => a.member.displayName);
  const who = attendeeNames.length > 0 ? attendeeNames.join(', ') : event.owner?.displayName;
  const repeat = event.rrule ? ` · ${recurrenceLabel(event.rrule)}` : '';

  const jobs: Array<{ familyId: string; dueAt: Date; text: string }> = [];

  for (const startAt of eventOccurrences(event.startAt, event.rrule, zone, now, event.exdates)) {
    for (const dueAt of futureOnly(
      event.reminderOffsets.map((min) => startAt.minus({ minutes: min })),
      now,
    )) {
      jobs.push({
        familyId: event.familyId,
        dueAt: dueAt.toJSDate(),
        text: [
          `[${label}] ${event.title}`,
          formatThaiDateTime(startAt, event.allDay),
          `(${formatRelativeDay(startAt, dueAt)})`,
          who ? `— ${who}` : '',
          event.location ? `@ ${event.location}` : '',
          repeat,
        ]
          .filter(Boolean)
          .join(' '),
      });
    }
  }

  await replaceJobs(prisma, 'EVENT', eventId, jobs);
}

/** How far ahead a repeating appointment is scheduled, and how many at once. */
const REPEAT_WINDOW_DAYS = 90;
const REPEAT_MAX_OCCURRENCES = 4;

/**
 * A one-off is its own single occurrence; a repeating event is expanded from
 * its RRULE. Only a few are scheduled at a time — the rest are picked up by
 * the daily refresh (see refreshRecurring), which keeps the job table from
 * filling with reminders for months nobody has reached yet.
 */
function eventOccurrences(
  startAt: Date,
  rrule: string | null,
  zone: string,
  now: DateTime,
  exdates: Date[],
): DateTime[] {
  if (!rrule) return [DateTime.fromJSDate(startAt, { zone })];

  try {
    return expandOccurrences(
      startAt,
      rrule,
      zone,
      now,
      now.plus({ days: REPEAT_WINDOW_DAYS }),
      REPEAT_MAX_OCCURRENCES,
      exdates,
    );
  } catch {
    // A malformed rule must not take the appointment down with it.
    return [DateTime.fromJSDate(startAt, { zone })];
  }
}

export async function generateBillJobs(
  prisma: PrismaClient,
  billId: string,
  now: DateTime,
  monthsAhead = 3,
): Promise<void> {
  const bill = await prisma.bill.findUnique({ where: { id: billId } });
  if (!bill) return;
  // Switched off: retire whatever was still queued rather than leaving it to
  // fire for a bill nobody is tracking any more.
  if (!bill.active) return replaceJobs(prisma, 'BILL', billId, []);

  const zone = (
    await prisma.family.findUnique({
      where: { id: bill.familyId },
      select: { timezone: true },
    })
  )?.timezone ?? 'Asia/Bangkok';

  const jobs: Array<{ familyId: string; dueAt: Date; text: string }> = [];

  for (let i = 0; i < monthsAhead; i++) {
    const month = now.setZone(zone).plus({ months: i });
    // A bill "due on the 31st" still has to land in February.
    const day = Math.min(bill.dueDay, month.daysInMonth ?? 28);
    const due = month.set({ day, hour: 9, minute: 0, second: 0, millisecond: 0 });

    const amount = bill.amount !== null ? `${formatSatang(bill.amount)} บาท` : 'ยอดตามบิล';

    for (const dueAt of futureOnly(
      bill.reminderOffsets.map((min) => due.minus({ minutes: min })),
      now,
    )) {
      jobs.push({
        familyId: bill.familyId,
        dueAt: dueAt.toJSDate(),
        text: `[บิล] ${bill.name} ${amount} — ครบกำหนด ${due.toFormat('d MMM')} (${formatRelativeDay(due, dueAt)})`,
      });
    }
  }

  await replaceJobs(prisma, 'BILL', billId, jobs);
}

export interface BillPaidResult {
  /** Satang actually recorded as an expense, or null when the bill has no set amount. */
  amountSatang: number | null;
}

/**
 * "จ่ายบิลแล้ว" — books the expense (that is what Bill.autoCreateTx is for)
 * and retires only this cycle's reminders. The bill itself stays active, so
 * next month's reminders are untouched.
 */
export async function markBillPaid(
  prisma: PrismaClient,
  billId: string,
  now: DateTime,
): Promise<BillPaidResult | null> {
  const bill = await prisma.bill.findUnique({ where: { id: billId } });
  if (!bill) return null;

  const zone = (
    await prisma.family.findUnique({ where: { id: bill.familyId }, select: { timezone: true } })
  )?.timezone ?? 'Asia/Bangkok';

  const local = now.setZone(zone);
  let due = local.set({
    day: Math.min(bill.dueDay, local.daysInMonth ?? 28),
    hour: 9,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  // Paying after this month's date settles the cycle that is already running,
  // not the one that has not come round yet.
  if (due < local.minus({ days: 7 })) {
    const next = local.plus({ months: 1 });
    due = next.set({ day: Math.min(bill.dueDay, next.daysInMonth ?? 28), hour: 9 });
  }

  let amountSatang: number | null = null;
  if (bill.autoCreateTx && bill.amount !== null) {
    await prisma.transaction.create({
      data: {
        familyId: bill.familyId,
        amount: bill.amount,
        direction: 'OUT',
        occurredAt: now.toJSDate(),
        billId: bill.id,
        note: bill.name,
        ...(bill.categoryId !== null ? { categoryId: bill.categoryId } : {}),
      },
    });
    amountSatang = bill.amount;

    try {
      if (bill.categoryId) await checkBudgetAlert(prisma, bill.familyId, bill.categoryId, now);
      await generateMonthSummaryJob(prisma, bill.familyId, now);
    } catch {
      // Reporting must not fail a payment that was already recorded.
    }
  }

  await prisma.notificationJob.updateMany({
    where: { kind: 'BILL', refId: billId, status: 'PENDING', dueAt: { lte: due.toJSDate() } },
    data: { status: 'CANCELLED' },
  });

  return { amountSatang };
}

export async function generateDocumentJobs(
  prisma: PrismaClient,
  documentId: string,
  now: DateTime,
): Promise<void> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    include: { owner: { select: { displayName: true } } },
  });
  if (!doc) return;

  const zone = (
    await prisma.family.findUnique({
      where: { id: doc.familyId },
      select: { timezone: true },
    })
  )?.timezone ?? 'Asia/Bangkok';

  const expires = DateTime.fromJSDate(doc.expiresAt, { zone }).set({ hour: 9 });
  const owner = doc.owner?.displayName;

  const jobs = futureOnly(
    doc.reminderOffsets.map((min) => expires.minus({ minutes: min })),
    now,
  ).map((dueAt) => ({
    familyId: doc.familyId,
    dueAt: dueAt.toJSDate(),
    text: `[เอกสาร] ${doc.name}${owner ? ` ของ${owner}` : ''} หมดอายุ ${formatThaiDateTime(expires, true)} (${formatRelativeDay(expires, dueAt)})`,
  }));

  await replaceJobs(prisma, 'DOCUMENT', documentId, jobs);
}

/**
 * Birthdays repeat forever, so only the next one is ever scheduled; the daily
 * refresh rolls it to next year once it has passed. refId is the member, so a
 * corrected birth date replaces the old reminder instead of adding to it.
 */
export async function generateBirthdayJobs(
  prisma: PrismaClient,
  memberId: string,
  now: DateTime,
): Promise<void> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, familyId: true, displayName: true, birthDate: true },
  });
  if (!member) return;
  if (!member.birthDate) return replaceJobs(prisma, 'BIRTHDAY', memberId, []);

  const zone = (
    await prisma.family.findUnique({
      where: { id: member.familyId },
      select: { timezone: true },
    })
  )?.timezone ?? 'Asia/Bangkok';

  // The stored value is a date-only column, so read it in UTC and rebuild the
  // day in the family's zone rather than letting an offset shift it.
  const born = DateTime.fromJSDate(member.birthDate, { zone: 'utc' });
  const today = now.setZone(zone).startOf('day');

  let next = today.set({ month: born.month, day: born.day, hour: 8, minute: 0, second: 0, millisecond: 0 });
  if (next < now) next = next.plus({ years: 1 });

  const turning = next.year - born.year;

  await replaceJobs(prisma, 'BIRTHDAY', memberId, [
    {
      familyId: member.familyId,
      dueAt: next.minus({ days: 1 }).toJSDate(),
      text: `🎂 พรุ่งนี้วันเกิด ${member.displayName}${turning > 0 ? ` ครบ ${turning} ปี` : ''}`,
    },
    {
      familyId: member.familyId,
      dueAt: next.toJSDate(),
      text: `🎂 วันนี้วันเกิด ${member.displayName}${turning > 0 ? ` ครบ ${turning} ปี` : ''} — อย่าลืมอวยพรนะครับ`,
    },
  ]);
}

/**
 * Everything that repeats is only ever scheduled a little way ahead, so
 * something has to walk it forward. Called once a day from the server.
 */
export async function refreshRecurring(prisma: PrismaClient, now: DateTime): Promise<void> {
  const [members, events] = await Promise.all([
    prisma.member.findMany({ where: { birthDate: { not: null } }, select: { id: true } }),
    prisma.event.findMany({ where: { rrule: { not: null } }, select: { id: true } }),
  ]);

  for (const member of members) {
    await generateBirthdayJobs(prisma, member.id, now);
  }
  for (const event of events) {
    await generateEventJobs(prisma, event.id, now);
  }
}

/**
 * A board task only reminds when it has a due date and is still open —
 * finishing it (or clearing the date) retires the reminder through the same
 * empty-replaceJobs path everything else uses.
 */
export async function generateTaskJobs(
  prisma: PrismaClient,
  taskId: string,
  now: DateTime,
): Promise<void> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { assignee: { select: { displayName: true } } },
  });
  if (!task) return;
  if (!task.dueAt || task.status === 'DONE') return replaceJobs(prisma, 'TASK', taskId, []);

  const zone = (
    await prisma.family.findUnique({
      where: { id: task.familyId },
      select: { timezone: true },
    })
  )?.timezone ?? 'Asia/Bangkok';

  const dueAt = DateTime.fromJSDate(task.dueAt, { zone });
  const who = task.assignee?.displayName;

  const jobs = futureOnly(
    task.reminderOffsets.map((min) => dueAt.minus({ minutes: min })),
    now,
  ).map((jobDueAt) => ({
    familyId: task.familyId,
    dueAt: jobDueAt.toJSDate(),
    text: `[งาน] ${task.title}${who ? ` — ${who}` : ''} ครบกำหนด ${formatThaiDateTime(dueAt, true)} (${formatRelativeDay(dueAt, jobDueAt)})`,
  }));

  await replaceJobs(prisma, 'TASK', taskId, jobs);
}

/** "ปล่อยกู้ ... ครบกำหนดคืน ..." -> a reminder before the loan's due date. */
export async function generateLoanJobs(
  prisma: PrismaClient,
  loanId: string,
  now: DateTime,
): Promise<void> {
  const loan = await prisma.loan.findUnique({ where: { id: loanId } });
  if (!loan) return;
  // No due date (or settled/closed) means nothing to remind about — and an
  // edit that clears the due date has to retire the old reminder with it.
  if (!loan.active || !loan.dueAt) return replaceJobs(prisma, 'LOAN_DUE', loanId, []);

  const zone = (
    await prisma.family.findUnique({
      where: { id: loan.familyId },
      select: { timezone: true },
    })
  )?.timezone ?? 'Asia/Bangkok';

  const dueAt = DateTime.fromJSDate(loan.dueAt, { zone }).set({ hour: 9 });
  const outstanding = loan.principalSatang - loan.repaidSatang;

  const jobs = futureOnly(
    loan.reminderOffsets.map((min) => dueAt.minus({ minutes: min })),
    now,
  ).map((jobDueAt) => ({
    familyId: loan.familyId,
    dueAt: jobDueAt.toJSDate(),
    text: `[เงินกู้] ${loan.borrowerName} ครบกำหนดคืน ${formatSatang(outstanding)} บาท ${formatThaiDateTime(dueAt, true)} (${formatRelativeDay(dueAt, jobDueAt)})`,
  }));

  await replaceJobs(prisma, 'LOAN_DUE', loanId, jobs);
}

/**
 * Medication is the one kind that uses the urgent lane, and only for the
 * escalation — the dose reminder itself still rides the digest.
 *
 * Each dose also gets a MedLog row (scheduledAt keyed, so re-generating is
 * idempotent via the schema's unique constraint). That row is what a
 * "กินยาแล้ว" reply marks taken, and marking it taken is what cancels the
 * matching escalation job below — see markMedicationTaken.
 */
export async function generateMedicationJobs(
  prisma: PrismaClient,
  medicationId: string,
  now: DateTime,
  daysAhead = 2,
): Promise<void> {
  const med = await prisma.medication.findUnique({
    where: { id: medicationId },
    include: { member: { select: { displayName: true, familyId: true } } },
  });
  if (!med) return;
  if (!med.active) return replaceJobs(prisma, 'MEDICATION', medicationId, []);

  const zone = (
    await prisma.family.findUnique({
      where: { id: med.member.familyId },
      select: { timezone: true },
    })
  )?.timezone ?? 'Asia/Bangkok';

  const jobs: Array<{ familyId: string; dueAt: Date; lane?: 'DIGEST' | 'URGENT'; text: string }> =
    [];
  const doseTimes: DateTime[] = [];

  for (let d = 0; d < daysAhead; d++) {
    for (const hhmm of med.times) {
      const [h, m] = hhmm.split(':').map(Number);
      if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) continue;

      const at = now
        .setZone(zone)
        .plus({ days: d })
        .set({ hour: h, minute: m, second: 0, millisecond: 0 });
      if (at <= now) continue;

      doseTimes.push(at);

      jobs.push({
        familyId: med.member.familyId,
        dueAt: at.toJSDate(),
        text: `[ยา] ${med.member.displayName} — ${med.name}${med.dosage ? ` (${med.dosage})` : ''} เวลา ${hhmm}`,
      });

      jobs.push({
        familyId: med.member.familyId,
        dueAt: at.plus({ minutes: med.escalateAfterMin }).toJSDate(),
        lane: 'URGENT',
        text: `${med.member.displayName} ยังไม่ได้กดยืนยันกินยา ${med.name} เวลา ${hhmm}`,
      });
    }
  }

  for (const scheduledAt of doseTimes) {
    await prisma.medLog.upsert({
      where: { medicationId_scheduledAt: { medicationId, scheduledAt: scheduledAt.toJSDate() } },
      create: { medicationId, scheduledAt: scheduledAt.toJSDate() },
      update: {},
    });
  }

  await replaceJobs(prisma, 'MEDICATION', medicationId, jobs);
}

export interface MarkMedicationTakenResult {
  medicationName: string;
  scheduledAt: DateTime;
}

/**
 * "กินยาแล้ว" — marks the caller's nearest unconfirmed dose as taken and
 * cancels its escalation job, which is the only thing standing between an
 * on-time dose and a false alarm to the rest of the family.
 *
 * Only ever looks within a few hours of now: a dose from yesterday is not
 * what "กินแล้ว" typed right now refers to.
 */
export async function markMedicationTaken(
  prisma: PrismaClient,
  memberId: string,
  now: DateTime,
  nameHint?: string,
): Promise<MarkMedicationTakenResult | null> {
  const log = await prisma.medLog.findFirst({
    where: {
      takenAt: null,
      scheduledAt: { lte: now.toJSDate(), gte: now.minus({ hours: 6 }).toJSDate() },
      medication: {
        memberId,
        ...(nameHint ? { name: { contains: nameHint } } : {}),
      },
    },
    include: { medication: { select: { name: true, escalateAfterMin: true } } },
    orderBy: { scheduledAt: 'desc' },
  });
  if (!log) return null;

  const scheduledAt = DateTime.fromJSDate(log.scheduledAt);
  const escalationDueAt = scheduledAt.plus({ minutes: log.medication.escalateAfterMin });

  await prisma.$transaction([
    prisma.medLog.update({ where: { id: log.id }, data: { takenAt: now.toJSDate() } }),
    prisma.notificationJob.updateMany({
      where: {
        kind: 'MEDICATION',
        refId: log.medicationId,
        lane: 'URGENT',
        status: 'PENDING',
        dueAt: escalationDueAt.toJSDate(),
      },
      data: { status: 'CANCELLED' },
    }),
  ]);

  return { medicationName: log.medication.name, scheduledAt };
}

// ---------------------------------------------------------------- chores

const CADENCE_STEP: Record<'DAILY' | 'WEEKLY' | 'MONTHLY', { days?: number; months?: number }> = {
  DAILY: { days: 1 },
  WEEKLY: { days: 7 },
  MONTHLY: { months: 1 },
};

/** The first reminder for a brand new chore: one cadence step from now, 09:00 local. */
export function firstChoreDueAt(
  now: DateTime,
  cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY',
): DateTime {
  return now.plus(CADENCE_STEP[cadence]).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
}

/**
 * Generates the next few reminders for a chore's rotation.
 *
 * Unlike events/bills/documents, a chore's schedule is not recomputed from a
 * fixed creation date — it advances one step at a time via markChoreDone.
 * That is what lets a task finished early retire its own reminder instead of
 * firing again on schedule; recomputing from "now" every time would bring it
 * straight back.
 */
export async function generateChoreJobs(
  prisma: PrismaClient,
  choreId: string,
  now: DateTime,
  occurrencesAhead = 4,
): Promise<void> {
  const chore = await prisma.chore.findUnique({ where: { id: choreId } });
  if (!chore) return;
  if (!chore.active) return replaceJobs(prisma, 'CHORE', choreId, []);

  const zone = (
    await prisma.family.findUnique({ where: { id: chore.familyId }, select: { timezone: true } })
  )?.timezone ?? 'Asia/Bangkok';

  const rotation = chore.rotationMemberIds;
  const names =
    rotation.length > 0
      ? await prisma.member
          .findMany({ where: { id: { in: rotation } }, select: { id: true, displayName: true } })
          .then((rows) => new Map(rows.map((r) => [r.id, r.displayName])))
      : new Map<string, string>();

  const step = CADENCE_STEP[chore.cadence];
  const jobs: Array<{ familyId: string; dueAt: Date; text: string }> = [];

  let due = DateTime.fromJSDate(chore.nextDueAt, { zone });
  for (let i = 0; i < occurrencesAhead; i++) {
    if (due > now) {
      const assigneeId = rotation.length > 0 ? rotation[(chore.rotationCursor + i) % rotation.length] : undefined;
      const assignee = assigneeId ? names.get(assigneeId) : undefined;

      jobs.push({
        familyId: chore.familyId,
        dueAt: due.toJSDate(),
        text: `[งานบ้าน] ${chore.name}${assignee ? ` — ตาของ ${assignee}` : ''} (${formatRelativeDay(due, now)})`,
      });
    }
    due = due.plus(step);
  }

  await replaceJobs(prisma, 'CHORE', choreId, jobs);
}

export interface ChoreDoneResult {
  name: string;
  nextAssignee?: string;
}

/**
 * "ทำแล้ว" — retires whichever reminder for this chore is still pending,
 * rotates to the next person, and pushes the schedule forward by one step.
 */
export async function markChoreDone(
  prisma: PrismaClient,
  choreId: string,
  now: DateTime,
): Promise<ChoreDoneResult | null> {
  const chore = await prisma.chore.findUnique({ where: { id: choreId } });
  if (!chore || !chore.active) return null;

  const rotation = chore.rotationMemberIds;
  const nextCursor = rotation.length > 0 ? (chore.rotationCursor + 1) % rotation.length : 0;
  const nextDueAt = DateTime.fromJSDate(chore.nextDueAt).plus(CADENCE_STEP[chore.cadence]);

  await prisma.chore.update({
    where: { id: choreId },
    data: { rotationCursor: nextCursor, nextDueAt: nextDueAt.toJSDate() },
  });

  // Regeneration cancels every still-pending reminder for this chore and
  // recreates the window from the new (shifted) nextDueAt — the occurrence
  // just completed is superseded, not merely cancelled-and-forgotten.
  await generateChoreJobs(prisma, choreId, now);

  let nextAssignee: string | undefined;
  const nextMemberId = rotation.length > 0 ? rotation[nextCursor] : undefined;
  if (nextMemberId) {
    const member = await prisma.member.findUnique({
      where: { id: nextMemberId },
      select: { displayName: true },
    });
    nextAssignee = member?.displayName;
  }

  return { name: chore.name, ...(nextAssignee !== undefined ? { nextAssignee } : {}) };
}

// ---------------------------------------------------------------- budget

const ALERT_THRESHOLDS = [100, 80] as const; // checked highest-first

export interface BudgetAlertResult {
  categoryName: string;
  percent: number;
}

/**
 * Call after any OUT transaction with a category. Carries a budget forward
 * from the most recent month it was set in, so "ตั้งงบ" once is enough —
 * nobody has to re-type a limit every month for it to keep working.
 */
export async function checkBudgetAlert(
  prisma: PrismaClient,
  familyId: string,
  categoryId: string,
  now: DateTime,
): Promise<BudgetAlertResult | null> {
  const yearMonth = now.toFormat('yyyy-MM');

  let budget = await prisma.budget.findUnique({
    where: { familyId_categoryId_yearMonth: { familyId, categoryId, yearMonth } },
    include: { category: { select: { name: true } } },
  });

  if (!budget) {
    const previous = await prisma.budget.findFirst({
      where: { familyId, categoryId, yearMonth: { lt: yearMonth } },
      orderBy: { yearMonth: 'desc' },
      include: { category: { select: { name: true } } },
    });
    if (!previous) return null; // no budget ever set for this category

    budget = await prisma.budget.create({
      data: { familyId, categoryId, yearMonth, limitAmount: previous.limitAmount },
      include: { category: { select: { name: true } } },
    });
  }
  if (budget.limitAmount <= 0) return null;

  const summary = await computeExpenseSummary(prisma, familyId, yearMonth, 'Asia/Bangkok');
  const spent =
    summary?.byCategory.find((c) => c.name === budget!.category.name)?.amountSatang ?? 0;
  const percent = Math.floor((spent / budget.limitAmount) * 100);

  const crossed = ALERT_THRESHOLDS.find((t) => percent >= t && budget!.alertedPercent < t);
  if (!crossed) return null;

  await prisma.$transaction([
    prisma.budget.update({
      where: { familyId_categoryId_yearMonth: { familyId, categoryId, yearMonth } },
      data: { alertedPercent: crossed },
    }),
    prisma.notificationJob.create({
      data: {
        familyId,
        kind: 'BUDGET_ALERT',
        refId: `${familyId}:${categoryId}:${yearMonth}:${crossed}`,
        dueAt: now.toJSDate(),
        payload: {
          text:
            crossed >= 100
              ? `⚠️ งบ "${budget.category.name}" เดือนนี้เกินแล้ว (ใช้ไป ${formatSatang(spent)} จาก ${formatSatang(budget.limitAmount)} บาท)`
              : `งบ "${budget.category.name}" เดือนนี้ใช้ไปแล้ว ${percent}% (${formatSatang(spent)} จาก ${formatSatang(budget.limitAmount)} บาท)`,
        },
      },
    }),
  ]);

  return { categoryName: budget.category.name, percent };
}

// ---------------------------------------------------------------- month summary

/**
 * Refreshed every time an expense is recorded, so the number stays accurate
 * right up to whichever edit was last before the digest that finally sends
 * it — the same regenerate-in-place pattern every other job kind uses.
 * Nothing to send if the month has no spending yet.
 */
export async function generateMonthSummaryJob(
  prisma: PrismaClient,
  familyId: string,
  now: DateTime,
  zone = 'Asia/Bangkok',
): Promise<void> {
  const local = now.setZone(zone);
  const dueAt = local.endOf('month').set({ hour: 21, minute: 0, second: 0, millisecond: 0 });
  if (dueAt <= now) return;

  const yearMonth = local.toFormat('yyyy-MM');
  const summary = await computeExpenseSummary(prisma, familyId, yearMonth, zone);
  if (!summary || summary.totalSatang === 0) return;

  const top = summary.byCategory
    .slice(0, 3)
    .map((c) => `${c.name} ${formatSatang(c.amountSatang)}`)
    .join(', ');

  const text = `สรุปรายจ่ายเดือน ${local.toFormat('MMMM', { locale: 'th' })}: รวม ${formatSatang(summary.totalSatang)} บาท (${top})`;

  await replaceJobs(prisma, 'MONTH_SUMMARY', `${familyId}:${yearMonth}`, [
    { familyId, dueAt: dueAt.toJSDate(), text },
  ]);
}
