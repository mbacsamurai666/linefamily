import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createTestDb, type TestDb } from './harness.js';
import { persistDraft } from '../../src/modules/persist.js';
import { computeNetBalances } from '../../src/modules/debts.js';
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
  markChoreDone,
  markMedicationTaken,
} from '../../src/reminders/generate.js';
import { computeNetWorth } from '../../src/modules/loanAssetDeposit.js';
import { computeMoneyOverview, computeUpcoming } from '../../src/modules/dashboard.js';

const ZONE = 'Asia/Bangkok';
const NOW = DateTime.fromISO('2026-09-04T10:00', { zone: ZONE });

let db: TestDb;
let familyId: string;
let memberId: string;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.reset();
  const family = await db.prisma.family.create({
    data: { lineGroupId: 'G_test', timezone: ZONE },
  });
  familyId = family.id;
  const member = await db.prisma.member.create({
    data: { familyId, lineUserId: 'U_test', displayName: 'แม่' },
  });
  memberId = member.id;
});

function ctx() {
  return { prisma: db.prisma, familyId, memberId, now: NOW };
}

describe('persistDraft — events', () => {
  it('writes the event and emits its reminder jobs', async () => {
    const startAt = NOW.plus({ days: 10 });

    const { summary } = await persistDraft(
      {
        kind: 'event',
        title: 'พาแม่ไปหาหมอ',
        startAt,
        allDay: false,
        category: 'MEDICAL',
        location: 'ศิริราช',
      },
      ctx(),
    );
    expect(summary).toContain('พาแม่ไปหาหมอ');

    const event = await db.prisma.event.findFirstOrThrow();
    expect(event.title).toBe('พาแม่ไปหาหมอ');
    expect(event.category).toBe('MEDICAL');
    expect(event.ownerId).toBe(memberId);
    // The schema default has to survive a create that never mentions it.
    expect(event.reminderOffsets).toEqual([10080, 1440, 120]);

    const jobs = await db.prisma.notificationJob.findMany({ orderBy: { dueAt: 'asc' } });
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.kind === 'EVENT' && j.status === 'PENDING')).toBe(true);

    const offsets = jobs.map((j) =>
      Math.round(startAt.diff(DateTime.fromJSDate(j.dueAt), 'minutes').minutes),
    );
    expect(offsets).toEqual([10080, 1440, 120]);
  });

  it('drops reminder times that have already passed', async () => {
    // One hour out: the 7-day and 1-day reminders are already in the past.
    await persistDraft(
      {
        kind: 'event',
        title: 'ด่วน',
        startAt: NOW.plus({ hours: 1 }),
        allDay: false,
        category: 'OTHER',
      },
      ctx(),
    );

    const jobs = await db.prisma.notificationJob.findMany();
    expect(jobs).toHaveLength(0);
  });

  it('regenerating jobs is idempotent, not duplicating', async () => {
    await persistDraft(
      {
        kind: 'event',
        title: 'ประชุม',
        startAt: NOW.plus({ days: 10 }),
        allDay: false,
        category: 'WORK',
      },
      ctx(),
    );
    const event = await db.prisma.event.findFirstOrThrow();

    await generateEventJobs(db.prisma, event.id, NOW);
    await generateEventJobs(db.prisma, event.id, NOW);

    const pending = await db.prisma.notificationJob.findMany({ where: { status: 'PENDING' } });
    expect(pending).toHaveLength(3);
  });

  it('does not resurrect a reminder that already went out', async () => {
    await persistDraft(
      {
        kind: 'event',
        title: 'นัดเดิม',
        startAt: NOW.plus({ days: 10 }),
        allDay: false,
        category: 'OTHER',
      },
      ctx(),
    );
    const event = await db.prisma.event.findFirstOrThrow();

    const first = await db.prisma.notificationJob.findFirstOrThrow({ orderBy: { dueAt: 'asc' } });
    await db.prisma.notificationJob.update({
      where: { id: first.id },
      data: { status: 'SENT', sentAt: NOW.toJSDate() },
    });

    // An edit regenerates; the delivered reminder must stay delivered.
    await generateEventJobs(db.prisma, event.id, NOW);

    const after = await db.prisma.notificationJob.findUniqueOrThrow({ where: { id: first.id } });
    expect(after.status).toBe('SENT');
  });

  it('attributes a school event to the named child and names them in the reminder text', async () => {
    const child = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_child', displayName: 'น้องพร' },
    });

    await persistDraft(
      {
        kind: 'event',
        title: 'สอบปลายภาค',
        startAt: NOW.plus({ days: 3 }),
        allDay: false,
        category: 'SCHOOL',
        attendeeName: 'น้องพร',
      },
      ctx(),
    );

    const event = await db.prisma.event.findFirstOrThrow();
    // ownerId still tracks who reported it (แม่, via ctx()) — attendee is separate.
    expect(event.ownerId).toBe(memberId);

    const attendance = await db.prisma.eventAttendee.findFirstOrThrow({
      where: { eventId: event.id },
    });
    expect(attendance.memberId).toBe(child.id);

    const job = await db.prisma.notificationJob.findFirstOrThrow({ orderBy: { dueAt: 'desc' } });
    const text = (job.payload as { text: string }).text;
    expect(text).toContain('น้องพร');
    expect(text).not.toContain('แม่'); // the child, not the reporting parent, is what matters here
  });

  it('drops an attendee name that does not match any family member, without failing the save', async () => {
    const { summary } = await persistDraft(
      {
        kind: 'event',
        title: 'สอบปลายภาค',
        startAt: NOW.plus({ days: 3 }),
        allDay: false,
        category: 'SCHOOL',
        attendeeName: 'คนไม่มีตัวตน',
      },
      ctx(),
    );
    expect(summary).toContain('สอบปลายภาค');
    expect(await db.prisma.eventAttendee.count()).toBe(0);

    // Falls back to the owner (who reported it) when there is no attendee.
    const job = await db.prisma.notificationJob.findFirstOrThrow({ orderBy: { dueAt: 'desc' } });
    expect((job.payload as { text: string }).text).toContain('แม่');
  });
});

describe('persistDraft — expenses', () => {
  it('creates the category on first use and reuses it after', async () => {
    for (const amount of [25000, 18000]) {
      await persistDraft(
        {
          kind: 'expense',
          amount,
          direction: 'OUT',
          categoryName: 'ข้าว',
          occurredAt: NOW,
        },
        ctx(),
      );
    }

    const categories = await db.prisma.category.findMany();
    expect(categories).toHaveLength(1);
    expect(categories[0]?.name).toBe('ข้าว');

    const txs = await db.prisma.transaction.findMany();
    expect(txs).toHaveLength(2);
    expect(txs.every((t) => t.categoryId === categories[0]?.id)).toBe(true);
    expect(txs.every((t) => t.paidById === memberId)).toBe(true);
  });

  it('keeps IN and OUT categories of the same name separate', async () => {
    await persistDraft(
      { kind: 'expense', amount: 100, direction: 'OUT', categoryName: 'ของ', occurredAt: NOW },
      ctx(),
    );
    await persistDraft(
      { kind: 'expense', amount: 100, direction: 'IN', categoryName: 'ของ', occurredAt: NOW },
      ctx(),
    );

    expect(await db.prisma.category.count()).toBe(2);
  });

  it('stores money as satang with no rounding drift', async () => {
    await persistDraft(
      { kind: 'expense', amount: 6250, direction: 'OUT', occurredAt: NOW },
      ctx(),
    );
    const tx = await db.prisma.transaction.findFirstOrThrow();
    expect(tx.amount).toBe(6250);
    expect(Number.isInteger(tx.amount)).toBe(true);
  });
});

describe('persistDraft — shopping', () => {
  it('adds every item unbought', async () => {
    await persistDraft({ kind: 'shopping', items: [{ name: 'นม' }, { name: 'ไข่' }, { name: 'ขนมปัง' }] }, ctx());

    const items = await db.prisma.shoppingItem.findMany();
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.boughtAt === null && i.addedById === memberId)).toBe(true);
  });
});

describe('persistDraft — bills', () => {
  it('creates a recurring bill and its reminder jobs', async () => {
    const { summary } = await persistDraft(
      { kind: 'bill', name: 'ค่าไฟ', amount: 80000, dueDay: 5 },
      ctx(),
    );
    expect(summary).toContain('ค่าไฟ');

    const bill = await db.prisma.bill.findFirstOrThrow();
    expect(bill).toMatchObject({ name: 'ค่าไฟ', amount: 80000, dueDay: 5, active: true });

    const jobs = await db.prisma.notificationJob.findMany({ where: { kind: 'BILL' } });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.refId === bill.id)).toBe(true);
  });

  it('allows a bill with no fixed amount', async () => {
    await persistDraft({ kind: 'bill', name: 'ค่าน้ำ', dueDay: 20 }, ctx());
    const bill = await db.prisma.bill.findFirstOrThrow();
    expect(bill.amount).toBeNull();
  });
});

describe('persistDraft — documents', () => {
  it('creates a document owned by the person who reported it, and its expiry reminders', async () => {
    const expiresAt = NOW.plus({ days: 90 });

    const { summary } = await persistDraft(
      { kind: 'document', name: 'ใบขับขี่', type: 'DRIVER_LICENSE', expiresAt },
      ctx(),
    );
    expect(summary).toContain('ใบขับขี่');

    const document = await db.prisma.document.findFirstOrThrow();
    expect(document.type).toBe('DRIVER_LICENSE');
    expect(document.ownerId).toBe(memberId);

    // The default offsets are 60 / 30 / 7 days, all still ahead of a 90-day
    // expiry, so all three reminders should exist.
    const jobs = await db.prisma.notificationJob.findMany({
      where: { kind: 'DOCUMENT' },
      orderBy: { dueAt: 'asc' },
    });
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.refId === document.id)).toBe(true);
  });
});


describe('job generators for Phase 3/4 modules', () => {
  it('generates bill reminders across upcoming months, clamped to month length', async () => {
    const bill = await db.prisma.bill.create({
      data: { familyId, name: 'ค่าไฟ', amount: 125000, dueDay: 31 },
    });

    await generateBillJobs(db.prisma, bill.id, NOW, 3);

    const jobs = await db.prisma.notificationJob.findMany({ orderBy: { dueAt: 'asc' } });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.kind === 'BILL')).toBe(true);

    // September has 30 days: a "31st" bill must not roll into October.
    const septemberDue = jobs
      .map((j) => DateTime.fromJSDate(j.dueAt).setZone(ZONE))
      .filter((d) => d.month === 9);
    expect(septemberDue.every((d) => d.day <= 30)).toBe(true);
  });

  it('generates document expiry reminders at 60/30/7 days', async () => {
    const doc = await db.prisma.document.create({
      data: {
        familyId,
        name: 'ใบขับขี่',
        type: 'DRIVER_LICENSE',
        expiresAt: NOW.plus({ days: 90 }).toJSDate(),
        ownerId: memberId,
      },
    });

    await generateDocumentJobs(db.prisma, doc.id, NOW);

    const jobs = await db.prisma.notificationJob.findMany({ orderBy: { dueAt: 'asc' } });
    expect(jobs).toHaveLength(3);
    expect(jobs[0]?.payload).toMatchObject({ text: expect.stringContaining('ใบขับขี่') as never });
  });

  it('generates a loan due-date reminder and skips it entirely with no due date', async () => {
    const loan = await db.prisma.loan.create({
      data: { familyId, borrowerName: 'พี่เอ', principalSatang: 500000, lentAt: NOW.toJSDate() },
    });
    await generateLoanJobs(db.prisma, loan.id, NOW);
    expect(await db.prisma.notificationJob.count({ where: { kind: 'LOAN_DUE' } })).toBe(0);

    await db.prisma.loan.update({ where: { id: loan.id }, data: { dueAt: NOW.plus({ days: 10 }).toJSDate() } });
    await generateLoanJobs(db.prisma, loan.id, NOW);
    const jobs = await db.prisma.notificationJob.findMany({ where: { kind: 'LOAN_DUE' } });
    expect(jobs).toHaveLength(1);
    expect((jobs[0]?.payload as { text: string }).text).toContain('5,000 บาท');
  });

  it('puts the medication escalation on the urgent lane, and the dose on the digest', async () => {
    const med = await db.prisma.medication.create({
      data: { memberId, name: 'ยาความดัน', times: ['08:00', '20:00'], escalateAfterMin: 45 },
    });

    await generateMedicationJobs(db.prisma, med.id, NOW, 1);

    const jobs = await db.prisma.notificationJob.findMany({ orderBy: { dueAt: 'asc' } });
    // Only 20:00 is still ahead of 10:00 today, so one dose plus its escalation.
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.lane)).toEqual(['DIGEST', 'URGENT']);

    const gap = DateTime.fromJSDate(jobs[1]!.dueAt).diff(
      DateTime.fromJSDate(jobs[0]!.dueAt),
      'minutes',
    ).minutes;
    expect(Math.round(gap)).toBe(45);
  });
});

describe('persistDraft — medication', () => {
  it('creates the medication under the person who typed it, with jobs and a MedLog per dose', async () => {
    const { summary } = await persistDraft(
      { kind: 'med', name: 'ยาความดัน', dosage: '1 เม็ด', times: ['08:00', '20:00'] },
      ctx(),
    );
    expect(summary).toContain('ยาความดัน');

    const med = await db.prisma.medication.findFirstOrThrow();
    expect(med.memberId).toBe(memberId);
    expect(med.times).toEqual(['08:00', '20:00']);

    // persistDraft uses the default 2-day lookahead: 20:00 today plus both
    // doses tomorrow = 3 scheduled doses, each with a dose job + escalation.
    const jobs = await db.prisma.notificationJob.findMany({ where: { kind: 'MEDICATION' } });
    const doseJobs = jobs.filter((j) => j.lane === 'DIGEST');
    const escalationJobs = jobs.filter((j) => j.lane === 'URGENT');
    expect(doseJobs).toHaveLength(3);
    expect(escalationJobs).toHaveLength(3);
    // Every scheduled dose gets exactly one MedLog row to mark taken against.
    expect(await db.prisma.medLog.count()).toBe(doseJobs.length);
  });

  it('refuses to record medication with no identified sender rather than guessing whose it is', async () => {
    await expect(
      persistDraft(
        { kind: 'med', name: 'ยาแก้แพ้', times: ['09:00'] },
        { prisma: db.prisma, familyId, memberId: null, now: NOW },
      ),
    ).rejects.toThrow(/ไม่ทราบว่าเป็นยาของใคร/);
  });
});

describe('markMedicationTaken', () => {
  it('marks the dose taken and cancels its escalation, so it never fires', async () => {
    const med = await db.prisma.medication.create({
      data: { memberId, name: 'ยาความดัน', times: ['20:00'], escalateAfterMin: 45 },
    });
    await generateMedicationJobs(db.prisma, med.id, NOW, 1);

    const result = await markMedicationTaken(db.prisma, memberId, NOW.plus({ hours: 10, minutes: 5 }));
    expect(result?.medicationName).toBe('ยาความดัน');

    const log = await db.prisma.medLog.findFirstOrThrow();
    expect(log.takenAt).not.toBeNull();

    const escalation = await db.prisma.notificationJob.findFirstOrThrow({
      where: { kind: 'MEDICATION', lane: 'URGENT' },
    });
    expect(escalation.status).toBe('CANCELLED');

    // The dose reminder itself is untouched — only the escalation is affected.
    const dose = await db.prisma.notificationJob.findFirstOrThrow({
      where: { kind: 'MEDICATION', lane: 'DIGEST' },
    });
    expect(dose.status).toBe('PENDING');
  });

  it('returns null and leaves the escalation standing when nothing is pending', async () => {
    const result = await markMedicationTaken(db.prisma, memberId, NOW);
    expect(result).toBeNull();
  });

  it('does not reach back past a several-hour window to an earlier dose', async () => {
    const med = await db.prisma.medication.create({
      data: { memberId, name: 'ยาเช้า', times: ['08:00'], escalateAfterMin: 30 },
    });
    // Seed a MedLog far enough in the past that it is not "the dose right now".
    await db.prisma.medLog.create({
      data: { medicationId: med.id, scheduledAt: NOW.minus({ days: 1 }).toJSDate() },
    });

    const result = await markMedicationTaken(db.prisma, memberId, NOW);
    expect(result).toBeNull();
  });
});

describe('persistDraft — chores', () => {
  it('resolves rotation names to member ids and generates the first occurrences', async () => {
    const father = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_father', displayName: 'พ่อ' },
    });

    const { summary } = await persistDraft(
      { kind: 'chore', name: 'ล้างจาน', cadence: 'DAILY', rotationNames: ['แม่', 'พ่อ'] },
      ctx(),
    );
    expect(summary).toContain('ล้างจาน');

    const chore = await db.prisma.chore.findFirstOrThrow();
    expect(chore.rotationMemberIds).toEqual([memberId, father.id]);
    expect(chore.rotationCursor).toBe(0);
    expect(DateTime.fromJSDate(chore.nextDueAt).toFormat("yyyy-MM-dd'T'HH:mm")).toBe(
      firstChoreDueAt(NOW, 'DAILY').toFormat("yyyy-MM-dd'T'HH:mm"),
    );

    const jobs = await db.prisma.notificationJob.findMany({ where: { kind: 'CHORE' } });
    expect(jobs).toHaveLength(4); // default occurrencesAhead
    expect(jobs[0]?.payload).toMatchObject({ text: expect.stringContaining('แม่') as never });
  });

  it('drops names that do not match a family member, without failing the whole thing', async () => {
    const { summary } = await persistDraft(
      { kind: 'chore', name: 'ทิ้งขยะ', cadence: 'WEEKLY', rotationNames: ['แม่', 'คนแปลกหน้า'] },
      ctx(),
    );
    expect(summary).toContain('หาไม่เจอ 1 ชื่อ');

    const chore = await db.prisma.chore.findFirstOrThrow();
    expect(chore.rotationMemberIds).toEqual([memberId]);
  });

  it('allows a chore with no rotation at all', async () => {
    await persistDraft({ kind: 'chore', name: 'รดน้ำต้นไม้', cadence: 'DAILY', rotationNames: [] }, ctx());
    const chore = await db.prisma.chore.findFirstOrThrow();
    expect(chore.rotationMemberIds).toEqual([]);
    const jobs = await db.prisma.notificationJob.findMany({ where: { kind: 'CHORE' } });
    expect(jobs.every((j) => !String((j.payload as { text: string }).text).includes('ตาของ'))).toBe(
      true,
    );
  });
});

describe('markChoreDone', () => {
  it('retires the pending occurrence, advances rotation, and shifts the schedule forward', async () => {
    const father = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_father2', displayName: 'พ่อ' },
    });
    const chore = await db.prisma.chore.create({
      data: {
        familyId,
        name: 'ล้างจาน',
        cadence: 'DAILY',
        rotationMemberIds: [memberId, father.id],
        nextDueAt: firstChoreDueAt(NOW, 'DAILY').toJSDate(),
      },
    });
    await generateChoreJobs(db.prisma, chore.id, NOW);
    const before = await db.prisma.notificationJob.findMany({
      where: { kind: 'CHORE', status: 'PENDING' },
      orderBy: { dueAt: 'asc' },
    });
    expect(before).toHaveLength(4);
    const firstDueAt = before[0]!.dueAt;

    const result = await markChoreDone(db.prisma, chore.id, NOW.plus({ hours: 2 }));
    expect(result).toEqual({ name: 'ล้างจาน', nextAssignee: 'พ่อ' });

    const after = await db.prisma.chore.findUniqueOrThrow({ where: { id: chore.id } });
    expect(after.rotationCursor).toBe(1);
    // The schedule moved forward by exactly one cadence step (one day).
    expect(
      DateTime.fromJSDate(after.nextDueAt).diff(DateTime.fromJSDate(firstDueAt), 'days').days,
    ).toBe(1);

    // The completed occurrence must not reappear — regeneration starts from
    // the new nextDueAt, one step past what was just finished.
    const stillPendingOnOldSlot = await db.prisma.notificationJob.findFirst({
      where: { kind: 'CHORE', dueAt: firstDueAt, status: 'PENDING' },
    });
    expect(stillPendingOnOldSlot).toBeNull();
  });

  it('returns null for a chore that does not exist', async () => {
    expect(await markChoreDone(db.prisma, 'does-not-exist', NOW)).toBeNull();
  });
});

describe('persistDraft — expense splitting (TxSplit)', () => {
  it('splits satang-exact, with the payer absorbing the rounding remainder', async () => {
    const other = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_split1', displayName: 'พี่เอ' },
    });

    const { summary } = await persistDraft(
      {
        kind: 'expense',
        amount: 10000, // 100.00 baht across 2 people -> 50/50
        direction: 'OUT',
        occurredAt: NOW,
        splitWithNames: ['พี่เอ', 'พี่บี'], // "พี่บี" does not exist — must be dropped, not fail
      },
      ctx(),
    );
    expect(summary).toContain('หารกับ พี่เอ');

    const splits = await db.prisma.txSplit.findMany({ orderBy: { share: 'desc' } });
    expect(splits).toHaveLength(2);
    const total = splits.reduce((sum, s) => sum + s.share, 0);
    expect(total).toBe(10000);

    const payerShare = splits.find((s) => s.memberId === memberId);
    const otherShare = splits.find((s) => s.memberId === other.id);
    expect(payerShare?.share).toBe(5000);
    expect(otherShare?.share).toBe(5000);
  });

  it('records the transaction unsplit when every named person is unmatched', async () => {
    const { summary } = await persistDraft(
      {
        kind: 'expense',
        amount: 1000,
        direction: 'OUT',
        occurredAt: NOW,
        splitWithNames: ['คนไม่มีตัวตน'],
      },
      ctx(),
    );
    expect(summary).not.toContain('หารกับ');
    expect(await db.prisma.txSplit.count()).toBe(0);
    expect(await db.prisma.transaction.count()).toBe(1);
  });

  it('does not split when nobody is identified as the payer', async () => {
    await persistDraft(
      { kind: 'expense', amount: 1000, direction: 'OUT', occurredAt: NOW, splitWithNames: ['พี่เอ'] },
      { prisma: db.prisma, familyId, memberId: null, now: NOW },
    );
    expect(await db.prisma.txSplit.count()).toBe(0);
  });
});

describe('checkBudgetAlert', () => {
  async function categoryId(name: string): Promise<string> {
    const c = await db.prisma.category.upsert({
      where: { familyId_name_kind: { familyId, name, kind: 'OUT' } },
      create: { familyId, name, kind: 'OUT' },
      update: {},
    });
    return c.id;
  }

  it('does nothing when no budget has ever been set for the category', async () => {
    const catId = await categoryId('ไฟ');
    expect(await checkBudgetAlert(db.prisma, familyId, catId, NOW)).toBeNull();
    expect(await db.prisma.notificationJob.count({ where: { kind: 'BUDGET_ALERT' } })).toBe(0);
  });

  it('alerts once at 80% and again at 100%, not twice for the same threshold', async () => {
    const catId = await categoryId('ไฟ');
    const yearMonth = NOW.toFormat('yyyy-MM');
    await db.prisma.budget.create({
      data: { familyId, categoryId: catId, yearMonth, limitAmount: 100000 }, // 1000 baht
    });

    // 500 baht spent (50%) — below the 80% threshold.
    await persistDraft(
      { kind: 'expense', amount: 50000, direction: 'OUT', categoryName: 'ไฟ', occurredAt: NOW },
      ctx(),
    );
    expect(await db.prisma.notificationJob.count({ where: { kind: 'BUDGET_ALERT' } })).toBe(0);

    // +350 baht = 850/1000 = 85% — crosses 80%.
    await persistDraft(
      { kind: 'expense', amount: 35000, direction: 'OUT', categoryName: 'ไฟ', occurredAt: NOW },
      ctx(),
    );
    let alerts = await db.prisma.notificationJob.findMany({ where: { kind: 'BUDGET_ALERT' } });
    expect(alerts).toHaveLength(1);

    // +50 baht = 900/1000 = 90% — still under 100%, must not re-alert at 80%.
    await persistDraft(
      { kind: 'expense', amount: 5000, direction: 'OUT', categoryName: 'ไฟ', occurredAt: NOW },
      ctx(),
    );
    alerts = await db.prisma.notificationJob.findMany({ where: { kind: 'BUDGET_ALERT' } });
    expect(alerts).toHaveLength(1);

    // +200 baht = 1100/1000 = 110% — crosses 100%, a second (different) alert.
    await persistDraft(
      { kind: 'expense', amount: 20000, direction: 'OUT', categoryName: 'ไฟ', occurredAt: NOW },
      ctx(),
    );
    alerts = await db.prisma.notificationJob.findMany({
      where: { kind: 'BUDGET_ALERT' },
      orderBy: { createdAt: 'asc' },
    });
    expect(alerts).toHaveLength(2);
    expect((alerts[1]?.payload as { text: string }).text).toContain('เกินแล้ว');

    const budget = await db.prisma.budget.findUniqueOrThrow({
      where: { familyId_categoryId_yearMonth: { familyId, categoryId: catId, yearMonth } },
    });
    expect(budget.alertedPercent).toBe(100);
  });

  it('carries the limit forward from the most recent prior month', async () => {
    const catId = await categoryId('น้ำ');
    await db.prisma.budget.create({
      data: { familyId, categoryId: catId, yearMonth: '2026-07', limitAmount: 40000 },
    });

    await checkBudgetAlert(db.prisma, familyId, catId, NOW); // NOW is 2026-09

    const carried = await db.prisma.budget.findUnique({
      where: {
        familyId_categoryId_yearMonth: { familyId, categoryId: catId, yearMonth: '2026-09' },
      },
    });
    expect(carried?.limitAmount).toBe(40000);
  });
});

describe('generateMonthSummaryJob', () => {
  it('does nothing for a month with no spending', async () => {
    await generateMonthSummaryJob(db.prisma, familyId, NOW);
    expect(await db.prisma.notificationJob.count({ where: { kind: 'MONTH_SUMMARY' } })).toBe(0);
  });

  it('schedules one job at 21:00 on the last day of the month, refreshed on each call', async () => {
    await persistDraft(
      { kind: 'expense', amount: 25000, direction: 'OUT', categoryName: 'ข้าว', occurredAt: NOW },
      ctx(),
    );

    const jobs = await db.prisma.notificationJob.findMany({ where: { kind: 'MONTH_SUMMARY' } });
    expect(jobs).toHaveLength(1);
    const dueAt = DateTime.fromJSDate(jobs[0]!.dueAt);
    expect(dueAt.day).toBe(NOW.daysInMonth);
    expect(dueAt.hour).toBe(21);
    expect((jobs[0]?.payload as { text: string }).text).toContain('250');

    // A second expense refreshes the same job (same dueAt slot) with the new total.
    await persistDraft(
      { kind: 'expense', amount: 10000, direction: 'OUT', categoryName: 'ข้าว', occurredAt: NOW },
      ctx(),
    );
    const after = await db.prisma.notificationJob.findMany({ where: { kind: 'MONTH_SUMMARY' } });
    expect(after).toHaveLength(1);
    expect((after[0]?.payload as { text: string }).text).toContain('350');
  });

  it('does not schedule a summary once the month has already ended', async () => {
    const lastMoment = NOW.endOf('month').plus({ minutes: 1 });
    await generateMonthSummaryJob(db.prisma, familyId, lastMoment);
    expect(await db.prisma.notificationJob.count({ where: { kind: 'MONTH_SUMMARY' } })).toBe(0);
  });
});

describe('computeNetBalances', () => {
  it('nets a single shared expense correctly', async () => {
    const other = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_debt1', displayName: 'พี่เอ' },
    });

    await persistDraft(
      {
        kind: 'expense',
        amount: 10000,
        direction: 'OUT',
        occurredAt: NOW,
        splitWithNames: ['พี่เอ'],
      },
      ctx(),
    );

    const balances = await computeNetBalances(
      db.prisma,
      familyId,
      NOW.toFormat('yyyy-MM'),
      'Asia/Bangkok',
    );
    expect(balances).toEqual([
      { memberId, displayName: 'แม่', balanceSatang: 5000 },
      { memberId: other.id, displayName: 'พี่เอ', balanceSatang: -5000 },
    ]);
  });

  it('nets opposing debts between the same two people into one balance', async () => {
    const other = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_debt2', displayName: 'พี่เอ' },
    });

    // แม่ (memberId) fronts 200, split 100/100.
    await persistDraft(
      { kind: 'expense', amount: 20000, direction: 'OUT', occurredAt: NOW, splitWithNames: ['พี่เอ'] },
      ctx(),
    );
    // พี่เอ fronts 60, split 30/30 — partially offsets the first debt.
    await persistDraft(
      { kind: 'expense', amount: 6000, direction: 'OUT', occurredAt: NOW, splitWithNames: ['แม่'] },
      { prisma: db.prisma, familyId, memberId: other.id, now: NOW },
    );

    const balances = await computeNetBalances(
      db.prisma,
      familyId,
      NOW.toFormat('yyyy-MM'),
      'Asia/Bangkok',
    );
    // แม่ is owed 100 from the first split, owes 30 from the second: net +70.
    const mom = balances.find((b) => b.memberId === memberId);
    const bro = balances.find((b) => b.memberId === other.id);
    expect(mom?.balanceSatang).toBe(7000);
    expect(bro?.balanceSatang).toBe(-7000);
  });

  it('omits members who are exactly settled', async () => {
    const other = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_debt3', displayName: 'พี่เอ' },
    });
    await persistDraft(
      { kind: 'expense', amount: 10000, direction: 'OUT', occurredAt: NOW, splitWithNames: ['พี่เอ'] },
      ctx(),
    );
    await persistDraft(
      { kind: 'expense', amount: 10000, direction: 'OUT', occurredAt: NOW, splitWithNames: ['แม่'] },
      { prisma: db.prisma, familyId, memberId: other.id, now: NOW },
    );

    const balances = await computeNetBalances(
      db.prisma,
      familyId,
      NOW.toFormat('yyyy-MM'),
      'Asia/Bangkok',
    );
    expect(balances).toEqual([]);
  });

  it('is empty for a month with no split expenses', async () => {
    await persistDraft({ kind: 'expense', amount: 100, direction: 'OUT', occurredAt: NOW }, ctx());
    expect(
      await computeNetBalances(db.prisma, familyId, NOW.toFormat('yyyy-MM'), 'Asia/Bangkok'),
    ).toEqual([]);
  });
});

describe('persistDraft — loans', () => {
  it('creates a loan with no reminder job when there is no due date', async () => {
    const { summary } = await persistDraft(
      { kind: 'loan', borrowerName: 'พี่เอ', principalSatang: 500000 },
      ctx(),
    );
    expect(summary).toContain('พี่เอ');

    const loan = await db.prisma.loan.findFirstOrThrow();
    expect(loan).toMatchObject({ borrowerName: 'พี่เอ', principalSatang: 500000, repaidSatang: 0 });
    expect(loan.dueAt).toBeNull();
    expect(await db.prisma.notificationJob.count({ where: { kind: 'LOAN_DUE' } })).toBe(0);
  });

  it('emits a due-date reminder when dueAt is set', async () => {
    await persistDraft(
      {
        kind: 'loan',
        borrowerName: 'พี่เอ',
        principalSatang: 500000,
        dueAt: NOW.plus({ days: 10 }),
      },
      ctx(),
    );

    const jobs = await db.prisma.notificationJob.findMany({ where: { kind: 'LOAN_DUE' } });
    expect(jobs).toHaveLength(1); // default reminderOffsets = [1440] (1 day before)
    expect((jobs[0]?.payload as { text: string }).text).toContain('พี่เอ');
  });
});

describe('persistDraft — assets and deposits', () => {
  it('creates an asset snapshot', async () => {
    const { summary } = await persistDraft(
      { kind: 'asset', name: 'บ้านสวน', category: 'PROPERTY', valueSatang: 300000000 },
      ctx(),
    );
    expect(summary).toContain('บ้านสวน');

    const asset = await db.prisma.asset.findFirstOrThrow();
    expect(asset).toMatchObject({ name: 'บ้านสวน', category: 'PROPERTY', valueSatang: 300000000 });
  });

  it('creates a deposit account snapshot', async () => {
    const { summary } = await persistDraft(
      { kind: 'deposit', name: 'ออมทรัพย์ SCB', balanceSatang: 5000000 },
      ctx(),
    );
    expect(summary).toContain('ออมทรัพย์ SCB');

    const deposit = await db.prisma.deposit.findFirstOrThrow();
    expect(deposit).toMatchObject({ name: 'ออมทรัพย์ SCB', balanceSatang: 5000000 });
  });
});

describe('computeNetWorth', () => {
  it('sums outstanding loans, asset values, and deposit balances', async () => {
    await persistDraft(
      { kind: 'loan', borrowerName: 'พี่เอ', principalSatang: 500000 },
      ctx(),
    );
    await db.prisma.loan.update({
      where: { id: (await db.prisma.loan.findFirstOrThrow()).id },
      data: { repaidSatang: 200000 },
    });
    await persistDraft(
      { kind: 'asset', name: 'บ้านสวน', category: 'PROPERTY', valueSatang: 300000000 },
      ctx(),
    );
    await persistDraft({ kind: 'deposit', name: 'ออมทรัพย์ SCB', balanceSatang: 5000000 }, ctx());

    const nw = await computeNetWorth(db.prisma, familyId);
    expect(nw).toEqual({
      loansOutstandingSatang: 300000,
      assetsValueSatang: 300000000,
      depositsSatang: 5000000,
      totalSatang: 305300000,
    });
  });

  it('is all zero with nothing recorded', async () => {
    expect(await computeNetWorth(db.prisma, familyId)).toEqual({
      loansOutstandingSatang: 0,
      assetsValueSatang: 0,
      depositsSatang: 0,
      totalSatang: 0,
    });
  });
});

describe('computeMoneyOverview', () => {
  it('separates income and expense for the month, and nets them', async () => {
    await persistDraft(
      { kind: 'expense', amount: 30000, direction: 'IN', occurredAt: NOW },
      ctx(),
    );
    await persistDraft(
      { kind: 'expense', amount: 20000, direction: 'OUT', occurredAt: NOW },
      ctx(),
    );

    const overview = await computeMoneyOverview(db.prisma, familyId, NOW.toFormat('yyyy-MM'), 'Asia/Bangkok');
    expect(overview).toEqual({
      month: NOW.toFormat('yyyy-MM'),
      incomeSatang: 30000,
      expenseSatang: 20000,
      netSatang: 10000,
    });
  });

  it('returns null for a badly formed month', async () => {
    expect(await computeMoneyOverview(db.prisma, familyId, 'not-a-month', 'Asia/Bangkok')).toBeNull();
  });
});

describe('computeUpcoming', () => {
  it('buckets pending jobs into today / next 3 days / next 7 days', async () => {
    await db.prisma.notificationJob.createMany({
      data: [
        { familyId, kind: 'EVENT', refId: 'today', dueAt: NOW.plus({ hours: 2 }).toJSDate(), payload: { text: 'วันนี้' } },
        { familyId, kind: 'EVENT', refId: 'soon', dueAt: NOW.plus({ days: 2 }).toJSDate(), payload: { text: 'อีก 2 วัน' } },
        { familyId, kind: 'EVENT', refId: 'later', dueAt: NOW.plus({ days: 5 }).toJSDate(), payload: { text: 'อีก 5 วัน' } },
        { familyId, kind: 'EVENT', refId: 'toofar', dueAt: NOW.plus({ days: 10 }).toJSDate(), payload: { text: 'ไกลไป' } },
      ],
    });

    const upcoming = await computeUpcoming(db.prisma, familyId, NOW, 'Asia/Bangkok');
    expect(upcoming.today.map((i) => i.text)).toEqual(['วันนี้']);
    expect(upcoming.next3d.map((i) => i.text)).toEqual(['อีก 2 วัน']);
    expect(upcoming.next7d.map((i) => i.text)).toEqual(['อีก 5 วัน']);
  });
});
