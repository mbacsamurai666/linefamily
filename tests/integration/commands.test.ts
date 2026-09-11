import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createTestDb, type TestDb } from './harness.js';
import { tryDirectCommand } from '../../src/modules/commands.js';
import { persistDraft } from '../../src/modules/persist.js';
import { firstChoreDueAt, generateChoreJobs, generateMedicationJobs } from '../../src/reminders/generate.js';

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
  const family = await db.prisma.family.create({ data: { lineGroupId: 'G_cmd', timezone: ZONE } });
  familyId = family.id;
  const member = await db.prisma.member.create({
    data: { familyId, lineUserId: 'U_cmd', displayName: 'แม่' },
  });
  memberId = member.id;
});

function ctx(now = NOW) {
  return { prisma: db.prisma, familyId, memberId, now };
}

describe('tryDirectCommand — non-commands', () => {
  it('returns null for ordinary chat, leaving it for the intent parser', async () => {
    expect(await tryDirectCommand('สวัสดีครับ', ctx())).toBeNull();
    expect(await tryDirectCommand('ค่าข้าว 250', ctx())).toBeNull();
  });
});

describe('tryDirectCommand — กินยาแล้ว', () => {
  it('marks the nearest pending dose taken and cancels its escalation', async () => {
    const med = await db.prisma.medication.create({
      data: { memberId, name: 'ยาความดัน', times: ['20:00'], escalateAfterMin: 45 },
    });
    await generateMedicationJobs(db.prisma, med.id, NOW, 1);

    const result = await tryDirectCommand('กินยาแล้ว', ctx(NOW.plus({ hours: 10, minutes: 5 })));
    expect(result?.reply).toContain('ยาความดัน');

    const escalation = await db.prisma.notificationJob.findFirstOrThrow({
      where: { kind: 'MEDICATION', lane: 'URGENT' },
    });
    expect(escalation.status).toBe('CANCELLED');
  });

  it('replies clearly when nothing is pending, rather than staying silent', async () => {
    const result = await tryDirectCommand('กินแล้ว', ctx());
    expect(result?.reply).toContain('ไม่พบรายการยา');
  });

  it('requires an identified sender', async () => {
    const result = await tryDirectCommand('กินยาแล้ว', {
      prisma: db.prisma,
      familyId,
      memberId: null,
      now: NOW,
    });
    expect(result?.reply).toContain('บัญชี LINE');
  });
});

describe('tryDirectCommand — ทำแล้ว', () => {
  it('finishes the single active chore when no name is given', async () => {
    const chore = await db.prisma.chore.create({
      data: {
        familyId,
        name: 'ล้างจาน',
        cadence: 'DAILY',
        rotationMemberIds: [],
        nextDueAt: firstChoreDueAt(NOW, 'DAILY').toJSDate(),
      },
    });
    await generateChoreJobs(db.prisma, chore.id, NOW);

    const result = await tryDirectCommand('ทำแล้ว', ctx());
    expect(result?.reply).toContain('ล้างจาน');

    const after = await db.prisma.chore.findUniqueOrThrow({ where: { id: chore.id } });
    expect(after.nextDueAt.getTime()).toBeGreaterThan(chore.nextDueAt.getTime());
  });

  it('asks for a name when several chores are active', async () => {
    for (const name of ['ล้างจาน', 'ทิ้งขยะ']) {
      await db.prisma.chore.create({
        data: {
          familyId,
          name,
          cadence: 'DAILY',
          rotationMemberIds: [],
          nextDueAt: firstChoreDueAt(NOW, 'DAILY').toJSDate(),
        },
      });
    }

    const result = await tryDirectCommand('ทำแล้ว', ctx());
    expect(result?.reply).toContain('มีหลายเวร');
  });

  it('finishes the named chore by partial match', async () => {
    await db.prisma.chore.create({
      data: {
        familyId,
        name: 'ล้างจานหลังอาหารเย็น',
        cadence: 'DAILY',
        rotationMemberIds: [],
        nextDueAt: firstChoreDueAt(NOW, 'DAILY').toJSDate(),
      },
    });

    const result = await tryDirectCommand('ทำแล้ว ล้างจาน', ctx());
    expect(result?.reply).toContain('ล้างจานหลังอาหารเย็น');
  });

  it('says so when nothing is set up yet', async () => {
    const result = await tryDirectCommand('ทำแล้ว', ctx());
    expect(result?.reply).toContain('ยังไม่มีเวร');
  });
});

describe('tryDirectCommand — emergency info', () => {
  it('lists every member, including those with nothing set', async () => {
    await db.prisma.member.update({
      where: { id: memberId },
      data: { bloodType: 'O', allergies: 'เพนิซิลลิน' },
    });
    await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_kid', displayName: 'ลูก' },
    });

    const result = await tryDirectCommand('ข้อมูลฉุกเฉิน', ctx());
    expect(result?.reply).toContain('แม่');
    expect(result?.reply).toContain('O');
    expect(result?.reply).toContain('เพนิซิลลิน');
    expect(result?.reply).toContain('ลูก');
  });

  it('lets the caller set their own blood type, allergies, and conditions', async () => {
    await tryDirectCommand('กรุ๊ปเลือดฉัน AB', ctx());
    await tryDirectCommand('แพ้ยา Penicillin', ctx());
    await tryDirectCommand('โรคประจำตัว เบาหวาน', ctx());

    const member = await db.prisma.member.findUniqueOrThrow({ where: { id: memberId } });
    expect(member.bloodType).toBe('AB');
    expect(member.allergies).toBe('Penicillin');
    expect(member.conditions).toBe('เบาหวาน');
  });

  it('never lets one member overwrite the emergency info of another', async () => {
    const other = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_other', displayName: 'พี่' },
    });

    await tryDirectCommand('กรุ๊ปเลือดฉัน O', ctx());

    const untouched = await db.prisma.member.findUniqueOrThrow({ where: { id: other.id } });
    expect(untouched.bloodType).toBeNull();
  });
});

describe('tryDirectCommand — ตั้งงบ', () => {
  it('creates the category and this month\'s budget row', async () => {
    const result = await tryDirectCommand('ตั้งงบ ค่าไฟ 1000 บาท', ctx());
    expect(result?.reply).toContain('ค่าไฟ');
    expect(result?.reply).toContain('1,000');

    const category = await db.prisma.category.findFirstOrThrow({ where: { name: 'ค่าไฟ' } });
    const budget = await db.prisma.budget.findUniqueOrThrow({
      where: {
        familyId_categoryId_yearMonth: {
          familyId,
          categoryId: category.id,
          yearMonth: NOW.toFormat('yyyy-MM'),
        },
      },
    });
    expect(budget.limitAmount).toBe(100000);
  });

  it('updates an existing budget and resets the alert flag so a raised limit can alert again', async () => {
    const category = await db.prisma.category.upsert({
      where: { familyId_name_kind: { familyId, name: 'ค่าไฟ', kind: 'OUT' } },
      create: { familyId, name: 'ค่าไฟ', kind: 'OUT' },
      update: {},
    });
    await db.prisma.budget.create({
      data: {
        familyId,
        categoryId: category.id,
        yearMonth: NOW.toFormat('yyyy-MM'),
        limitAmount: 50000,
        alertedPercent: 100,
      },
    });

    await tryDirectCommand('ตั้งงบ ค่าไฟ 2000 บาท', ctx());

    const budget = await db.prisma.budget.findUniqueOrThrow({
      where: {
        familyId_categoryId_yearMonth: {
          familyId,
          categoryId: category.id,
          yearMonth: NOW.toFormat('yyyy-MM'),
        },
      },
    });
    expect(budget.limitAmount).toBe(200000);
    expect(budget.alertedPercent).toBe(0);
  });

  it('rejects a zero amount rather than silently setting an unusable budget', async () => {
    const result = await tryDirectCommand('ตั้งงบ ค่าไฟ 0 บาท', ctx());
    expect(result?.reply).toContain('ตั้งงบ ค่าไฟ 1000 บาท');
    expect(await db.prisma.budget.count()).toBe(0);
  });

  it('is not recognised as a command at all when there is no numeric amount', async () => {
    // No digit anywhere means it does not match the ตั้งงบ pattern in the
    // first place — it falls through to the normal intent parser, not a
    // ตั้งงบ-specific error.
    expect(await tryDirectCommand('ตั้งงบ ค่าไฟ กี่บาทดีนะ', ctx())).toBeNull();
  });
});

describe('tryDirectCommand — สรุปหนี้', () => {
  it('reports net balances for the current month', async () => {
    const other = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_debt', displayName: 'พี่เอ' },
    });
    await persistDraft(
      { kind: 'expense', amount: 10000, direction: 'OUT', occurredAt: NOW, splitWithNames: ['พี่เอ'] },
      { prisma: db.prisma, familyId, memberId, now: NOW },
    );

    const result = await tryDirectCommand('สรุปหนี้', ctx());
    expect(result?.reply).toContain('แม่: มีคนติดอยู่ 50 บาท');
    expect(result?.reply).toContain('พี่เอ: ติดคนอื่นอยู่ 50 บาท');
  });

  it('says so when nothing has been split this month', async () => {
    const result = await tryDirectCommand('ใครติดใคร', ctx());
    expect(result?.reply).toContain('ยังไม่มีรายการที่หารกัน');
  });
});

describe('tryDirectCommand — สรุปเงินกู้ / สรุปทรัพย์สิน / สรุปเงินฝาก / สรุปฐานะการเงิน', () => {
  it('reports only outstanding loans, with the total owed back', async () => {
    await db.prisma.loan.create({
      data: { familyId, borrowerName: 'พี่เอ', principalSatang: 500000, repaidSatang: 200000, lentAt: NOW.toJSDate() },
    });
    await db.prisma.loan.create({
      data: { familyId, borrowerName: 'พี่บี', principalSatang: 100000, repaidSatang: 100000, lentAt: NOW.toJSDate() },
    });

    const result = await tryDirectCommand('สรุปเงินกู้', ctx());
    expect(result?.reply).toContain('พี่เอ: ค้าง 3,000 จาก 5,000 บาท');
    expect(result?.reply).not.toContain('พี่บี'); // fully repaid — not outstanding
    expect(result?.reply).toContain('รวมค้างคืน 3,000 บาท');
  });

  it('says so when nothing is lent out', async () => {
    const result = await tryDirectCommand('สรุปเงินกู้', ctx());
    expect(result?.reply).toContain('ไม่มีเงินให้ใครยืมค้างอยู่');
  });

  it('reports assets with category label and total value', async () => {
    await db.prisma.asset.create({
      data: { familyId, name: 'บ้านสวน', category: 'PROPERTY', valueSatang: 300000000 },
    });
    const result = await tryDirectCommand('สรุปทรัพย์สิน', ctx());
    expect(result?.reply).toContain('บ้านสวน (บ้าน/ที่ดิน): 3,000,000 บาท');
    expect(result?.reply).toContain('รวมมูลค่า 3,000,000 บาท');
  });

  it('reports deposit accounts with total', async () => {
    await db.prisma.deposit.create({ data: { familyId, name: 'ออมทรัพย์ SCB', balanceSatang: 5000000 } });
    const result = await tryDirectCommand('สรุปเงินฝาก', ctx());
    expect(result?.reply).toContain('ออมทรัพย์ SCB: 50,000 บาท');
    expect(result?.reply).toContain('รวม 50,000 บาท');
  });

  it('rolls loans, assets, and deposits into one net-worth summary', async () => {
    await db.prisma.loan.create({
      data: { familyId, borrowerName: 'พี่เอ', principalSatang: 500000, repaidSatang: 0, lentAt: NOW.toJSDate() },
    });
    await db.prisma.asset.create({
      data: { familyId, name: 'บ้านสวน', category: 'PROPERTY', valueSatang: 300000000 },
    });
    await db.prisma.deposit.create({ data: { familyId, name: 'ออมทรัพย์ SCB', balanceSatang: 5000000 } });

    const result = await tryDirectCommand('สรุปฐานะการเงิน', ctx());
    expect(result?.reply).toContain('เงินให้ยืม (ค้างคืน): 5,000 บาท');
    expect(result?.reply).toContain('ทรัพย์สิน: 3,000,000 บาท');
    expect(result?.reply).toContain('เงินฝาก: 50,000 บาท');
    expect(result?.reply).toContain('รวมทั้งหมด: 3,055,000 บาท');
  });
});

describe('tryDirectCommand — ยกเลิกล่าสุด', () => {
  it('removes whatever was recorded most recently and says what went', async () => {
    await persistDraft(
      { kind: 'expense', amount: 25000, direction: 'OUT', occurredAt: NOW },
      ctx(),
    );
    // Recorded after the expense, so this is the one "ล่าสุด" means.
    await persistDraft({ kind: 'shopping', items: [{ name: 'นม' }] }, ctx());

    const result = await tryDirectCommand('ยกเลิกล่าสุด', ctx());
    expect(result?.reply).toContain('นม');

    expect(await db.prisma.shoppingItem.count()).toBe(0);
    // The older expense is untouched.
    expect(await db.prisma.transaction.count()).toBe(1);
  });

  it('cancels the reminders of whatever it removes', async () => {
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

    const result = await tryDirectCommand('ลบล่าสุด', ctx());
    expect(result?.reply).toContain('พาแม่ไปหาหมอ');

    expect(
      await db.prisma.notificationJob.count({ where: { kind: 'EVENT', status: 'PENDING' } }),
    ).toBe(0);
  });

  it('will not reach back past a day', async () => {
    await db.prisma.asset.create({
      data: {
        familyId,
        name: 'ของเก่า',
        valueSatang: 1000,
        createdAt: NOW.minus({ days: 3 }).toJSDate(),
      },
    });

    const result = await tryDirectCommand('ยกเลิกล่าสุด', ctx());
    expect(result?.reply).toContain('ไม่มีรายการที่บันทึกไว้ใน 24 ชั่วโมง');
    expect(await db.prisma.asset.count()).toBe(1);
  });
});

describe('tryDirectCommand — บอร์ดงาน', () => {
  it('lists what is still open, marking what is in progress', async () => {
    await persistDraft({ kind: 'task', title: 'โทรหาช่าง' }, ctx());
    await persistDraft({ kind: 'task', title: 'ส่งเอกสาร' }, ctx());
    const doing = await db.prisma.task.findFirstOrThrow({ where: { title: 'ส่งเอกสาร' } });
    await db.prisma.task.update({ where: { id: doing.id }, data: { status: 'DOING' } });

    const result = await tryDirectCommand('บอร์ดงาน', ctx());
    expect(result?.reply).toContain('ค้าง 2 งาน');
    expect(result?.reply).toContain('🔸 ส่งเอกสาร');
    expect(result?.reply).toContain('▫️ โทรหาช่าง');
  });

  it('says the board is clear when nothing is left', async () => {
    const result = await tryDirectCommand('บอร์ดงาน', ctx());
    expect(result?.reply).toContain('บอร์ดว่าง');
  });

  it('closes a task by name and reports what is left', async () => {
    await persistDraft({ kind: 'task', title: 'โทรหาช่างแอร์' }, ctx());
    await persistDraft({ kind: 'task', title: 'ส่งเอกสาร' }, ctx());

    const result = await tryDirectCommand('ปิดงาน ช่างแอร์', ctx());
    expect(result?.reply).toContain('โทรหาช่างแอร์');
    expect(result?.reply).toContain('เหลืออีก 1 งาน');

    const closed = await db.prisma.task.findFirstOrThrow({ where: { title: 'โทรหาช่างแอร์' } });
    expect(closed.status).toBe('DONE');
  });

  it('celebrates when that was the last one', async () => {
    await persistDraft({ kind: 'task', title: 'งานเดียว' }, ctx());
    const result = await tryDirectCommand('งานเสร็จ งานเดียว', ctx());
    expect(result?.reply).toContain('หมดบอร์ดแล้ว');
  });

  it('asks instead of guessing when several tasks match', async () => {
    await persistDraft({ kind: 'task', title: 'โทรหาช่างแอร์' }, ctx());
    await persistDraft({ kind: 'task', title: 'โทรหาช่างประปา' }, ctx());

    const result = await tryDirectCommand('ปิดงาน โทรหาช่าง', ctx());
    expect(result?.reply).toContain('ระบุให้ชัดขึ้น');
    expect(await db.prisma.task.count({ where: { status: 'DONE' } })).toBe(0);
  });
});

describe('tryDirectCommand — ลบ<อะไร> <ชื่อ>', () => {
  it('deletes the named appointment and retires its reminders', async () => {
    await persistDraft(
      {
        kind: 'event',
        title: 'ประชุมผู้ปกครอง',
        startAt: NOW.plus({ days: 6 }),
        allDay: false,
        category: 'SCHOOL',
      },
      ctx(),
    );

    const result = await tryDirectCommand('ลบนัด ประชุม', ctx());
    expect(result?.reply).toContain('ประชุมผู้ปกครอง');

    expect(await db.prisma.event.count()).toBe(0);
    expect(
      await db.prisma.notificationJob.count({ where: { kind: 'EVENT', status: 'PENDING' } }),
    ).toBe(0);
  });

  it('asks instead of guessing when the name matches several', async () => {
    for (const title of ['ประชุมผู้ปกครอง', 'ประชุมบริษัท']) {
      await persistDraft(
        { kind: 'event', title, startAt: NOW.plus({ days: 6 }), allDay: false, category: 'OTHER' },
        ctx(),
      );
    }

    const result = await tryDirectCommand('ลบนัด ประชุม', ctx());
    expect(result?.reply).toContain('ระบุให้ชัดขึ้น');
    expect(await db.prisma.event.count()).toBe(2);
  });

  it('says so when nothing matches', async () => {
    const result = await tryDirectCommand('ลบบิล ค่าเน็ต', ctx());
    expect(result?.reply).toContain('ไม่พบบิล');
  });

  it('deletes a medication, escalations included', async () => {
    const med = await db.prisma.medication.create({
      data: { memberId, name: 'ยาความดัน', times: ['20:00'], escalateAfterMin: 45 },
    });
    await generateMedicationJobs(db.prisma, med.id, NOW, 1);

    const result = await tryDirectCommand('ลบยา ยาความดัน', ctx());
    expect(result?.reply).toContain('ยาความดัน');

    expect(await db.prisma.medication.count()).toBe(0);
    expect(
      await db.prisma.notificationJob.count({ where: { kind: 'MEDICATION', status: 'PENDING' } }),
    ).toBe(0);
  });
});
