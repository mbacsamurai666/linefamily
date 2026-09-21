import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { messagingApi } from '@line/bot-sdk';
import { createTestDb, type TestDb } from './harness.js';
import { createApiRouter } from '../../src/api/router.js';
import { persistDraft } from '../../src/modules/persist.js';
import { ReminderEngine } from '../../src/reminders/engine.js';
import { generateEventJobs } from '../../src/reminders/generate.js';
import {
  familyClock,
  LineNotifier,
  PrismaBudgetStore,
  PrismaFamilyStore,
  PrismaJobStore,
} from '../../src/reminders/prisma-stores.js';

/**
 * "Why is there no notification every morning?" — the first week went three
 * days without a word because nothing happened to be due. The family now
 * hears from the bot every morning by default, at times it chooses.
 */

const ZONE = 'Asia/Bangkok';
const TOKEN = 'fake-id-token';
const LINE_USER_ID = 'U_daily';

let db: TestDb;
let familyId: string;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.reset();
  const family = await db.prisma.family.create({ data: { lineGroupId: 'G_daily', timezone: ZONE } });
  familyId = family.id;
  await db.prisma.member.create({ data: { familyId, lineUserId: LINE_USER_ID, displayName: 'แม่' } });
});

function fakeLine() {
  const pushed: messagingApi.PushMessageRequest[] = [];
  const api = {
    pushMessage: async (req: messagingApi.PushMessageRequest) => {
      pushed.push(req);
      return {};
    },
  } as unknown as messagingApi.MessagingApiClient;
  return { api, pushed };
}

function engineAt(now: () => DateTime, api: messagingApi.MessagingApiClient) {
  return new ReminderEngine({
    jobs: new PrismaJobStore(db.prisma),
    budget: new PrismaBudgetStore(db.prisma, 500),
    notifier: new LineNotifier(api, db.prisma),
    families: new PrismaFamilyStore(db.prisma),
    clock: { now },
    morningHour: 7,
    eveningHour: 20,
    reserveThreshold: 60,
  });
}

const api = () =>
  createApiRouter({
    prisma: db.prisma,
    defaultTimezone: ZONE,
    verifyToken: async (t) => (t === TOKEN ? { lineUserId: LINE_USER_ID } : null),
  });

const authed = (path: string, init: RequestInit = {}) =>
  api().request(path, {
    ...init,
    headers: { 'x-liff-id-token': TOKEN, 'content-type': 'application/json', ...init.headers },
  });

describe('a quiet morning', () => {
  it('still gets its digest, carrying the week ahead', async () => {
    await db.prisma.event.create({
      data: {
        familyId,
        title: 'พาแม่ไปหาหมอ',
        category: 'MEDICAL',
        startAt: DateTime.fromISO('2026-09-17T15:00', { zone: ZONE }).toJSDate(),
      },
    });
    const { api: line, pushed } = fakeLine();

    await engineAt(() => DateTime.fromISO('2026-09-15T07:00', { zone: ZONE }), line).tick();

    expect(pushed).toHaveLength(1);
    const card = pushed[0]!.messages[0] as messagingApi.FlexMessage;
    expect(card.altText).toBe('สรุปเช้านี้ — วันนี้ไม่มีอะไรต้องเตือน');
    expect(JSON.stringify(card.contents)).toContain('[หมอ] พาแม่ไปหาหมอ');
    expect(JSON.stringify(card.contents)).toContain('พฤ. 17 ก.ย. 15:00');
    // Grouped the same way as the app's หน้าหลัก.
    expect(JSON.stringify(card.contents)).toContain('ใน 3 วัน (1)');
    expect(JSON.stringify(card.contents)).not.toContain('ใน 7 วัน');
  });

  it('stays quiet when the family turned the daily morning off', async () => {
    await db.prisma.family.update({ where: { id: familyId }, data: { digestEveryMorning: false } });
    const { api: line, pushed } = fakeLine();

    await engineAt(() => DateTime.fromISO('2026-09-15T07:00', { zone: ZONE }), line).tick();

    expect(pushed).toHaveLength(0);
  });

  it('goes out at the time the family chose', async () => {
    await db.prisma.family.update({ where: { id: familyId }, data: { digestMorningAt: 6 * 60 + 30 } });
    const { api: line, pushed } = fakeLine();

    await engineAt(() => DateTime.fromISO('2026-09-15T07:00', { zone: ZONE }), line).tick();
    expect(pushed).toHaveLength(0); // 07:00 is not their time any more

    await engineAt(() => DateTime.fromISO('2026-09-16T06:30', { zone: ZONE }), line).tick();
    expect(pushed).toHaveLength(1);
  });
});

describe('an all-day appointment', () => {
  it("is in that morning's digest, not only the night before", async () => {
    // ไหว้เจ้าที่ on Saturday 19 Sep: stored at midnight, entered a week before.
    const event = await db.prisma.event.create({
      data: {
        familyId,
        title: 'ไหว้เจ้าที่',
        allDay: true,
        startAt: DateTime.fromISO('2026-09-19T00:00', { zone: ZONE }).toJSDate(),
      },
    });
    await generateEventJobs(db.prisma, event.id, DateTime.fromISO('2026-09-10T12:00', { zone: ZONE }));
    const { api: line, pushed } = fakeLine();

    await engineAt(() => DateTime.fromISO('2026-09-19T07:00', { zone: ZONE }), line).tick();

    expect(pushed).toHaveLength(1);
    const card = JSON.stringify(pushed[0]!.messages[0]);
    expect(card).toContain('ไหว้เจ้าที่');
    expect(card).toContain('(วันนี้)');
  });
});

describe('"today" and "tomorrow"', () => {
  it('are said as of the digest, not as of when each reminder falls due', async () => {
    // A 02:00 appointment: its two-hour reminder falls due at midnight, so the
    // evening before carries it — and must call it tomorrow's.
    const event = await db.prisma.event.create({
      data: {
        familyId,
        title: 'ไปส่งสนามบิน',
        startAt: DateTime.fromISO('2026-09-16T02:00', { zone: ZONE }).toJSDate(),
        reminderOffsets: [120],
      },
    });
    await generateEventJobs(db.prisma, event.id, DateTime.fromISO('2026-09-10T12:00', { zone: ZONE }));
    const { api: line, pushed } = fakeLine();

    await engineAt(() => DateTime.fromISO('2026-09-15T20:00', { zone: ZONE }), line).tick();

    const card = JSON.stringify(pushed[0]!.messages[0]);
    expect(card).toContain('ไปส่งสนามบิน');
    expect(card).toContain('(พรุ่งนี้)');
    expect(card).not.toContain('(วันนี้)');
  });
});

describe('a quiet evening', () => {
  it('says good night when the family asked for every evening', async () => {
    await db.prisma.family.update({ where: { id: familyId }, data: { digestEveryEvening: true } });
    const { api: line, pushed } = fakeLine();

    await engineAt(() => DateTime.fromISO('2026-09-15T20:00', { zone: ZONE }), line).tick();

    expect(pushed).toHaveLength(1);
    const card = pushed[0]!.messages[0] as messagingApi.FlexMessage;
    expect(card.altText).toBe('สรุปเย็นนี้ — คืนนี้ไม่มีอะไรต้องเตือน');
  });

  it('stays quiet on a weekend the family left out', async () => {
    await db.prisma.family.update({ where: { id: familyId }, data: { digestDays: [1, 2, 3, 4, 5] } });
    const { api: line, pushed } = fakeLine();

    // Saturday 19 Sep 2026.
    await engineAt(() => DateTime.fromISO('2026-09-19T07:00', { zone: ZONE }), line).tick();

    expect(pushed).toHaveLength(0);
  });
});

describe('lead times', () => {
  const DAY = 24 * 60;

  it('applies to appointments already on record, and to new ones', async () => {
    const soon = DateTime.now().plus({ days: 20 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const existing = await db.prisma.event.create({
      data: { familyId, title: 'ทำฟัน', startAt: soon.toJSDate() },
    });
    await generateEventJobs(db.prisma, existing.id, DateTime.now());
    expect(await db.prisma.notificationJob.count({ where: { refId: existing.id } })).toBe(3);

    const res = await authed('/family/lead-times', {
      method: 'PATCH',
      body: JSON.stringify({ event: [DAY, 3 * DAY] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { event: number[] }).event).toEqual([3 * DAY, DAY]);

    const jobs = await db.prisma.notificationJob.findMany({
      where: { refId: existing.id, status: 'PENDING' },
      orderBy: { dueAt: 'asc' },
    });
    expect(jobs.map((j) => DateTime.fromJSDate(j.dueAt).toMillis())).toEqual([
      soon.minus({ days: 3 }).toMillis(),
      soon.minus({ days: 1 }).toMillis(),
    ]);

    await persistDraft(
      { kind: 'event', title: 'ประชุมผู้ปกครอง', category: 'SCHOOL', startAt: soon.plus({ days: 1 }), allDay: false },
      { prisma: db.prisma, familyId, memberId: null, now: DateTime.now() },
    );
    const created = await db.prisma.event.findFirstOrThrow({ where: { title: 'ประชุมผู้ปกครอง' } });
    expect(created.reminderOffsets).toEqual([3 * DAY, DAY]);
  });

  it('refuses a kind with nothing chosen', async () => {
    const res = await authed('/family/lead-times', { method: 'PATCH', body: JSON.stringify({ bill: [] }) });
    expect(res.status).toBe(400);
  });
});

describe('familyClock', () => {
  const row = {
    id: 'f',
    timezone: ZONE,
    digestMorningAt: 420,
    digestEveningAt: 1200,
    digestMorningOn: true,
    digestEveningOn: true,
    digestEveryMorning: true,
    digestEveryEvening: false,
    digestDays: [1, 2, 3, 4, 5, 6, 7],
  };

  it('schedules both slots and a daily morning by default', () => {
    expect(familyClock(row)).toEqual({
      familyId: 'f',
      timezone: ZONE,
      slots: [420, 1200],
      quietDaySlots: [420],
      days: [1, 2, 3, 4, 5, 6, 7],
    });
  });

  it('drops a switched-off slot, and its daily message goes with it', () => {
    expect(familyClock({ ...row, digestMorningOn: false })).toMatchObject({ slots: [1200], quietDaySlots: [] });
    expect(familyClock({ ...row, digestEveningOn: false })).toMatchObject({ slots: [420], quietDaySlots: [420] });
  });

  it('adds the evening to the daily messages when asked', () => {
    expect(familyClock({ ...row, digestEveryEvening: true })).toMatchObject({ quietDaySlots: [420, 1200] });
  });
});

describe('the digest settings API', () => {
  it('reads the defaults as clock times', async () => {
    const res = await authed('/family/digest');
    expect(await res.json()).toEqual({
      morningAt: '07:00',
      eveningAt: '20:00',
      morningOn: true,
      eveningOn: true,
      everyMorning: true,
      everyEvening: false,
      days: [1, 2, 3, 4, 5, 6, 7],
    });
  });

  it('saves the days and the daily evening', async () => {
    const res = await authed('/family/digest', {
      method: 'PATCH',
      body: JSON.stringify({ days: [5, 1, 2, 3, 4], everyEvening: true }),
    });
    expect(res.status).toBe(200);

    const family = await db.prisma.family.findUniqueOrThrow({ where: { id: familyId } });
    expect(family.digestDays).toEqual([1, 2, 3, 4, 5]);
    expect(family.digestEveryEvening).toBe(true);
  });

  it('refuses no days at all', async () => {
    const res = await authed('/family/digest', { method: 'PATCH', body: JSON.stringify({ days: [] }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('อย่างน้อย 1 วัน');
  });

  it('saves a new morning time and the daily switch', async () => {
    const res = await authed('/family/digest', {
      method: 'PATCH',
      body: JSON.stringify({ morningAt: '06:30', everyMorning: false }),
    });
    expect(res.status).toBe(200);

    const family = await db.prisma.family.findUniqueOrThrow({ where: { id: familyId } });
    expect(family.digestMorningAt).toBe(390);
    expect(family.digestEveryMorning).toBe(false);
    expect(family.digestEveningAt).toBe(1200); // untouched
  });

  it('refuses switching both digests off — reminders would never leave', async () => {
    const res = await authed('/family/digest', {
      method: 'PATCH',
      body: JSON.stringify({ morningOn: false, eveningOn: false }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('อย่างน้อย 1 รอบ');
  });

  it('refuses a "morning" in the afternoon, and a malformed time', async () => {
    const afternoon = await authed('/family/digest', {
      method: 'PATCH',
      body: JSON.stringify({ morningAt: '13:00' }),
    });
    expect(afternoon.status).toBe(400);

    const nonsense = await authed('/family/digest', {
      method: 'PATCH',
      body: JSON.stringify({ morningAt: '7 โมง' }),
    });
    expect(nonsense.status).toBe(400);
  });
});
