import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createTestDb, type TestDb } from './harness.js';
import { persistDraft } from '../../src/modules/persist.js';
import {
  deleteBill,
  deleteDeposit,
  deleteEvent,
  deleteLoan,
  deleteMedication,
  deleteTask,
  deleteTransaction,
  updateAsset,
  updateBill,
  updateEvent,
  updateLoan,
  updateTask,
  updateTransaction,
} from '../../src/modules/records.js';
import { computeExpenseSummary } from '../../src/modules/expenseSummary.js';
import { computeTaskCounts } from '../../src/modules/dashboard.js';
import { generateMedicationJobs } from '../../src/reminders/generate.js';

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
    data: { lineGroupId: 'G_records', timezone: ZONE },
  });
  familyId = family.id;
  const member = await db.prisma.member.create({
    data: { familyId, lineUserId: 'U_records', displayName: 'แม่' },
  });
  memberId = member.id;
});

function ctx() {
  return { prisma: db.prisma, familyId, memberId, now: NOW };
}

/** Pending reminders for a row, which is what must not outlive it. */
function pendingJobs(kind: string, refId: string) {
  return db.prisma.notificationJob.count({ where: { kind: kind as never, refId, status: 'PENDING' } });
}

describe('deleting an appointment', () => {
  it('removes the row and retires every reminder still queued for it', async () => {
    await persistDraft(
      {
        kind: 'event',
        title: 'พาแม่ไปหาหมอ',
        startAt: NOW.plus({ days: 10 }),
        allDay: false,
        category: 'MEDICAL',
      },
      ctx(),
    );
    const event = await db.prisma.event.findFirstOrThrow();
    expect(await pendingJobs('EVENT', event.id)).toBe(3);

    expect(await deleteEvent(ctx(), event.id)).toBe(true);

    expect(await db.prisma.event.count()).toBe(0);
    expect(await pendingJobs('EVENT', event.id)).toBe(0);
  });

  it('leaves a reminder that already went out marked SENT, not cancelled', async () => {
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
    const sent = await db.prisma.notificationJob.findFirstOrThrow({ orderBy: { dueAt: 'asc' } });
    await db.prisma.notificationJob.update({
      where: { id: sent.id },
      data: { status: 'SENT', sentAt: NOW.toJSDate() },
    });

    await deleteEvent(ctx(), event.id);

    const after = await db.prisma.notificationJob.findUniqueOrThrow({ where: { id: sent.id } });
    expect(after.status).toBe('SENT');
  });

  it('refuses to touch another family\'s appointment', async () => {
    const other = await db.prisma.family.create({
      data: { lineGroupId: 'G_other_records', timezone: ZONE },
    });
    const foreign = await db.prisma.event.create({
      data: { familyId: other.id, title: 'ของบ้านอื่น', startAt: NOW.plus({ days: 2 }).toJSDate() },
    });

    expect(await deleteEvent(ctx(), foreign.id)).toBe(false);
    expect(await db.prisma.event.count({ where: { id: foreign.id } })).toBe(1);
  });
});

describe('editing an appointment', () => {
  it('moves the reminders when the time moves', async () => {
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
    const newStart = NOW.plus({ days: 12, hours: 3 });

    expect(await updateEvent(ctx(), event.id, { startAt: newStart, title: 'ประชุมใหม่' })).toBe(true);

    const updated = await db.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(updated.title).toBe('ประชุมใหม่');

    const jobs = await db.prisma.notificationJob.findMany({
      where: { kind: 'EVENT', refId: event.id, status: 'PENDING' },
      orderBy: { dueAt: 'asc' },
    });
    expect(jobs).toHaveLength(3);
    const offsets = jobs.map((j) =>
      Math.round(newStart.diff(DateTime.fromJSDate(j.dueAt), 'minutes').minutes),
    );
    expect(offsets).toEqual([10080, 1440, 120]);
  });

  it('replaces who the appointment is for, and clears it when asked', async () => {
    const child = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_child_rec', displayName: 'น้องพร' },
    });
    await persistDraft(
      {
        kind: 'event',
        title: 'สอบ',
        startAt: NOW.plus({ days: 5 }),
        allDay: false,
        category: 'SCHOOL',
      },
      ctx(),
    );
    const event = await db.prisma.event.findFirstOrThrow();

    await updateEvent(ctx(), event.id, { attendeeName: 'น้องพร' });
    const attendance = await db.prisma.eventAttendee.findFirstOrThrow();
    expect(attendance.memberId).toBe(child.id);

    await updateEvent(ctx(), event.id, { attendeeName: null });
    expect(await db.prisma.eventAttendee.count()).toBe(0);
  });
});

describe('editing and deleting money', () => {
  it('a corrected amount is what the month summary reports', async () => {
    await persistDraft(
      { kind: 'expense', amount: 25000, direction: 'OUT', categoryName: 'ข้าว', occurredAt: NOW },
      ctx(),
    );
    const tx = await db.prisma.transaction.findFirstOrThrow();

    expect(await updateTransaction(ctx(), tx.id, { amount: 12500 })).toBe(true);

    const summary = await computeExpenseSummary(db.prisma, familyId, NOW.toFormat('yyyy-MM'), ZONE);
    expect(summary?.totalSatang).toBe(12500);
  });

  it('flipping direction re-homes the category, since categories are per direction', async () => {
    await persistDraft(
      { kind: 'expense', amount: 30000, direction: 'OUT', categoryName: 'โบนัส', occurredAt: NOW },
      ctx(),
    );
    const tx = await db.prisma.transaction.findFirstOrThrow();

    await updateTransaction(ctx(), tx.id, { direction: 'IN' });

    const updated = await db.prisma.transaction.findUniqueOrThrow({
      where: { id: tx.id },
      include: { category: true },
    });
    expect(updated.direction).toBe('IN');
    expect(updated.category?.kind).toBe('IN');
    expect(updated.category?.name).toBe('โบนัส');
  });

  it('deleting a split expense takes its shares with it', async () => {
    await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_split_rec', displayName: 'พี่เอ' },
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
    const tx = await db.prisma.transaction.findFirstOrThrow();
    expect(await db.prisma.txSplit.count()).toBe(2);

    expect(await deleteTransaction(ctx(), tx.id)).toBe(true);

    expect(await db.prisma.transaction.count()).toBe(0);
    expect(await db.prisma.txSplit.count()).toBe(0);
  });
});

describe('switching a recurring thing off', () => {
  it('a deactivated bill stops reminding', async () => {
    await persistDraft({ kind: 'bill', name: 'ค่าไฟ', amount: 80000, dueDay: 25 }, ctx());
    const bill = await db.prisma.bill.findFirstOrThrow();
    expect(await pendingJobs('BILL', bill.id)).toBeGreaterThan(0);

    expect(await updateBill(ctx(), bill.id, { active: false })).toBe(true);

    expect(await pendingJobs('BILL', bill.id)).toBe(0);
  });

  it('deleting a bill retires its reminders too', async () => {
    await persistDraft({ kind: 'bill', name: 'ค่าน้ำ', dueDay: 20 }, ctx());
    const bill = await db.prisma.bill.findFirstOrThrow();

    expect(await deleteBill(ctx(), bill.id)).toBe(true);
    expect(await pendingJobs('BILL', bill.id)).toBe(0);
  });

  it('deleting a medication takes its escalations with it', async () => {
    const med = await db.prisma.medication.create({
      data: { memberId, name: 'ยาความดัน', times: ['20:00'], escalateAfterMin: 45 },
    });
    await generateMedicationJobs(db.prisma, med.id, NOW, 1);
    expect(await pendingJobs('MEDICATION', med.id)).toBe(2); // dose + escalation

    expect(await deleteMedication(ctx(), med.id)).toBe(true);

    expect(await db.prisma.medication.count()).toBe(0);
    expect(await pendingJobs('MEDICATION', med.id)).toBe(0);
  });
});

describe('the task board', () => {
  it('a new card lands in ต้องทำ and only reminds when it has a due date', async () => {
    await persistDraft({ kind: 'task', title: 'โทรหาช่าง' }, ctx());
    const plain = await db.prisma.task.findFirstOrThrow();
    expect(plain.status).toBe('TODO');
    expect(await pendingJobs('TASK', plain.id)).toBe(0);

    await persistDraft(
      { kind: 'task', title: 'ส่งเอกสารประกัน', dueAt: NOW.plus({ days: 5 }) },
      ctx(),
    );
    const dated = await db.prisma.task.findFirstOrThrow({ where: { title: 'ส่งเอกสารประกัน' } });
    expect(await pendingJobs('TASK', dated.id)).toBe(1);
  });

  it('finishing a card stamps doneAt and stops its reminder', async () => {
    await persistDraft(
      { kind: 'task', title: 'ส่งเอกสาร', dueAt: NOW.plus({ days: 5 }) },
      ctx(),
    );
    const task = await db.prisma.task.findFirstOrThrow();

    expect(await updateTask(ctx(), task.id, { status: 'DONE' })).toBe(true);

    const done = await db.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(done.status).toBe('DONE');
    expect(done.doneAt).not.toBeNull();
    expect(await pendingJobs('TASK', task.id)).toBe(0);
  });

  it('re-opening a finished card clears doneAt and brings the reminder back', async () => {
    await persistDraft({ kind: 'task', title: 'ซ่อมประตู', dueAt: NOW.plus({ days: 5 }) }, ctx());
    const task = await db.prisma.task.findFirstOrThrow();
    await updateTask(ctx(), task.id, { status: 'DONE' });

    await updateTask(ctx(), task.id, { status: 'DOING' });

    const reopened = await db.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(reopened.doneAt).toBeNull();
    expect(await pendingJobs('TASK', task.id)).toBe(1);
  });

  it('assigns to a family member by name, and drops a name that matches nobody', async () => {
    await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_dad_task', displayName: 'พ่อ' },
    });

    await persistDraft({ kind: 'task', title: 'ล้างรถ', assigneeName: 'พ่อ' }, ctx());
    const assigned = await db.prisma.task.findFirstOrThrow({ include: { assignee: true } });
    expect(assigned.assignee?.displayName).toBe('พ่อ');

    await persistDraft({ kind: 'task', title: 'รดน้ำต้นไม้', assigneeName: 'คนไม่มีตัวตน' }, ctx());
    const unassigned = await db.prisma.task.findFirstOrThrow({ where: { title: 'รดน้ำต้นไม้' } });
    expect(unassigned.assigneeId).toBeNull();
  });

  it('deleting a card retires its reminder', async () => {
    await persistDraft({ kind: 'task', title: 'จองโรงแรม', dueAt: NOW.plus({ days: 3 }) }, ctx());
    const task = await db.prisma.task.findFirstOrThrow();

    expect(await deleteTask(ctx(), task.id)).toBe(true);
    expect(await db.prisma.task.count()).toBe(0);
    expect(await pendingJobs('TASK', task.id)).toBe(0);
  });

  it('counts what is open and what got finished today', async () => {
    await persistDraft({ kind: 'task', title: 'งาน 1' }, ctx());
    await persistDraft({ kind: 'task', title: 'งาน 2' }, ctx());
    const second = await db.prisma.task.findFirstOrThrow({ where: { title: 'งาน 2' } });
    await updateTask(ctx(), second.id, { status: 'DONE' });
    const third = await persistDraft({ kind: 'task', title: 'งาน 3' }, ctx());
    expect(third.summary).toContain('งาน 3');
    const t3 = await db.prisma.task.findFirstOrThrow({ where: { title: 'งาน 3' } });
    await updateTask(ctx(), t3.id, { status: 'DOING' });

    const counts = await computeTaskCounts(db.prisma, familyId, NOW, ZONE);
    expect(counts).toEqual({ todo: 1, doing: 1, doneToday: 1 });
  });
});

describe('loans, assets and deposits', () => {
  it('clearing a loan due date retires the reminder that pointed at it', async () => {
    await persistDraft(
      {
        kind: 'loan',
        borrowerName: 'พี่เอ',
        principalSatang: 500000,
        dueAt: NOW.plus({ days: 10 }),
      },
      ctx(),
    );
    const loan = await db.prisma.loan.findFirstOrThrow();
    expect(await pendingJobs('LOAN_DUE', loan.id)).toBe(1);

    expect(await updateLoan(ctx(), loan.id, { dueAt: null })).toBe(true);

    expect(await pendingJobs('LOAN_DUE', loan.id)).toBe(0);
  });

  it('deleting a loan retires its reminder', async () => {
    await persistDraft(
      {
        kind: 'loan',
        borrowerName: 'พี่บี',
        principalSatang: 200000,
        dueAt: NOW.plus({ days: 5 }),
      },
      ctx(),
    );
    const loan = await db.prisma.loan.findFirstOrThrow();

    expect(await deleteLoan(ctx(), loan.id)).toBe(true);
    expect(await pendingJobs('LOAN_DUE', loan.id)).toBe(0);
  });

  it('corrects an asset value and a deposit disappears when deleted', async () => {
    await persistDraft(
      { kind: 'asset', name: 'บ้านสวน', category: 'PROPERTY', valueSatang: 300000000 },
      ctx(),
    );
    const asset = await db.prisma.asset.findFirstOrThrow();
    await updateAsset(ctx(), asset.id, { valueSatang: 320000000, note: 'ประเมินใหม่' });
    const updatedAsset = await db.prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(updatedAsset).toMatchObject({ valueSatang: 320000000, note: 'ประเมินใหม่' });

    await persistDraft({ kind: 'deposit', name: 'ออมทรัพย์ SCB', balanceSatang: 5000000 }, ctx());
    const deposit = await db.prisma.deposit.findFirstOrThrow();
    expect(await deleteDeposit(ctx(), deposit.id)).toBe(true);
    expect(await db.prisma.deposit.count()).toBe(0);
  });

  it('returns false for an id that is not this family\'s', async () => {
    expect(await updateAsset(ctx(), 'does-not-exist', { valueSatang: 1 })).toBe(false);
    expect(await deleteLoan(ctx(), 'does-not-exist')).toBe(false);
  });
});
