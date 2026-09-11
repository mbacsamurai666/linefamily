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
import {
  generateBirthdayJobs,
  generateEventJobs,
  generateMedicationJobs,
  markBillPaid,
} from '../../src/reminders/generate.js';

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

describe('repeating appointments', () => {
  it('schedules several occurrences from one RRULE', async () => {
    await persistDraft(
      {
        kind: 'event',
        title: 'กายภาพบำบัดแม่',
        startAt: NOW.plus({ days: 3 }).set({ hour: 9 }),
        allDay: false,
        category: 'MEDICAL',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      },
      ctx(),
    );

    const event = await db.prisma.event.findFirstOrThrow();
    expect(event.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');

    const jobs = await db.prisma.notificationJob.findMany({
      where: { kind: 'EVENT', refId: event.id, status: 'PENDING' },
      orderBy: { dueAt: 'asc' },
    });

    // Four occurrences, each with its own set of lead-up reminders — many more
    // than the three a one-off would produce.
    expect(jobs.length).toBeGreaterThan(3);

    const mondays = new Set(
      jobs.map((j) => (j.payload as { text: string }).text.match(/\d+ [ก-๛.]+/)?.[0]),
    );
    expect(mondays.size).toBeGreaterThan(1);
    expect((jobs[0]?.payload as { text: string }).text).toContain('ทุกวันจันทร์');
  });

  it('reminds on the right weekday for an appointment before 07:00', async () => {
    // 06:00 Bangkok is 23:00 UTC on Sunday. rrule reads BYDAY on the UTC
    // calendar, so this used to announce "every Monday" for every Tuesday.
    await persistDraft(
      {
        kind: 'event',
        title: 'ตักบาตร',
        startAt: NOW.plus({ days: 3 }).set({ hour: 6, minute: 0 }),
        allDay: false,
        category: 'OTHER',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      },
      ctx(),
    );
    const event = await db.prisma.event.findFirstOrThrow();

    const texts = (
      await db.prisma.notificationJob.findMany({
        where: { kind: 'EVENT', refId: event.id, status: 'PENDING' },
      })
    ).map((j) => (j.payload as { text: string }).text);

    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).toMatch(/ จ\. \d+ .+ 06:00/);
    }
  });

  it('clearing the repeat drops it back to a single occurrence', async () => {
    await persistDraft(
      {
        kind: 'event',
        title: 'ประชุม',
        // Far enough out that all three default offsets are still ahead.
        startAt: NOW.plus({ days: 10 }),
        allDay: false,
        category: 'WORK',
        rrule: 'FREQ=WEEKLY',
      },
      ctx(),
    );
    const event = await db.prisma.event.findFirstOrThrow();
    const repeating = await pendingJobs('EVENT', event.id);

    await updateEvent(ctx(), event.id, { rrule: null });

    const once = await pendingJobs('EVENT', event.id);
    expect(once).toBeLessThan(repeating);
    expect(once).toBe(3); // the default 7-day / 1-day / 2-hour offsets
  });

  it('survives a rule it cannot parse instead of losing the appointment', async () => {
    const event = await db.prisma.event.create({
      data: {
        familyId,
        title: 'พัง',
        startAt: NOW.plus({ days: 10 }).toJSDate(),
        rrule: 'ไม่ใช่ RRULE',
      },
    });

    await generateEventJobs(db.prisma, event.id, NOW);
    expect(await pendingJobs('EVENT', event.id)).toBe(3);
  });
});

describe('birthdays', () => {
  it('schedules the next one, a day before and on the day', async () => {
    await db.prisma.member.update({
      where: { id: memberId },
      data: { birthDate: DateTime.fromISO('1990-12-05', { zone: 'utc' }).toJSDate() },
    });

    await generateBirthdayJobs(db.prisma, memberId, NOW);

    const jobs = await db.prisma.notificationJob.findMany({
      where: { kind: 'BIRTHDAY', refId: memberId, status: 'PENDING' },
      orderBy: { dueAt: 'asc' },
    });
    expect(jobs).toHaveLength(2);
    expect(DateTime.fromJSDate(jobs[1]!.dueAt).setZone(ZONE).toFormat('MM-dd')).toBe('12-05');
    expect((jobs[1]?.payload as { text: string }).text).toContain('ครบ 36 ปี');
  });

  it('rolls to next year once this year\'s has passed', async () => {
    // NOW is 4 Sep 2026, so a January birthday belongs to 2027.
    await db.prisma.member.update({
      where: { id: memberId },
      data: { birthDate: DateTime.fromISO('1985-01-20', { zone: 'utc' }).toJSDate() },
    });

    await generateBirthdayJobs(db.prisma, memberId, NOW);

    const onTheDay = await db.prisma.notificationJob.findFirstOrThrow({
      where: { kind: 'BIRTHDAY', status: 'PENDING' },
      orderBy: { dueAt: 'desc' },
    });
    expect(DateTime.fromJSDate(onTheDay.dueAt).setZone(ZONE).toFormat('yyyy-MM-dd')).toBe(
      '2027-01-20',
    );
  });

  it('clearing the birth date retires the reminder', async () => {
    await db.prisma.member.update({
      where: { id: memberId },
      data: { birthDate: DateTime.fromISO('1990-12-05', { zone: 'utc' }).toJSDate() },
    });
    await generateBirthdayJobs(db.prisma, memberId, NOW);

    await db.prisma.member.update({ where: { id: memberId }, data: { birthDate: null } });
    await generateBirthdayJobs(db.prisma, memberId, NOW);

    expect(await pendingJobs('BIRTHDAY', memberId)).toBe(0);
  });
});

describe('paying a bill', () => {
  it('books the expense and clears this cycle\'s reminders, keeping the bill', async () => {
    await persistDraft({ kind: 'bill', name: 'ค่าไฟ', amount: 80000, dueDay: 25 }, ctx());
    const bill = await db.prisma.bill.findFirstOrThrow();
    const before = await pendingJobs('BILL', bill.id);
    expect(before).toBeGreaterThan(0);

    const result = await markBillPaid(db.prisma, bill.id, NOW);
    expect(result?.amountSatang).toBe(80000);

    const tx = await db.prisma.transaction.findFirstOrThrow();
    expect(tx).toMatchObject({ amount: 80000, direction: 'OUT', billId: bill.id });

    // Next month's reminders survive; this cycle's do not.
    const after = await pendingJobs('BILL', bill.id);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
    expect(await db.prisma.bill.count({ where: { active: true } })).toBe(1);
  });

  it('records nothing when the bill has no set amount', async () => {
    await persistDraft({ kind: 'bill', name: 'ค่าน้ำ', dueDay: 20 }, ctx());
    const bill = await db.prisma.bill.findFirstOrThrow();

    const result = await markBillPaid(db.prisma, bill.id, NOW);
    expect(result?.amountSatang).toBeNull();
    expect(await db.prisma.transaction.count()).toBe(0);
  });

  it('honours autoCreateTx being switched off', async () => {
    const bill = await db.prisma.bill.create({
      data: { familyId, name: 'ค่าเน็ต', amount: 59900, dueDay: 15, autoCreateTx: false },
    });

    await markBillPaid(db.prisma, bill.id, NOW);
    expect(await db.prisma.transaction.count()).toBe(0);
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
