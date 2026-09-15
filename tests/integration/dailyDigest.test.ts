import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { messagingApi } from '@line/bot-sdk';
import { createTestDb, type TestDb } from './harness.js';
import { createApiRouter } from '../../src/api/router.js';
import { ReminderEngine } from '../../src/reminders/engine.js';
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
        startAt: DateTime.fromISO('2026-09-17T15:00', { zone: ZONE }).toJSDate(),
      },
    });
    const { api: line, pushed } = fakeLine();

    await engineAt(() => DateTime.fromISO('2026-09-15T07:00', { zone: ZONE }), line).tick();

    expect(pushed).toHaveLength(1);
    const card = pushed[0]!.messages[0] as messagingApi.FlexMessage;
    expect(card.altText).toBe('สรุปเช้านี้ — วันนี้ไม่มีอะไรต้องเตือน');
    expect(JSON.stringify(card.contents)).toContain('พาแม่ไปหาหมอ');
    expect(JSON.stringify(card.contents)).toContain('พฤ. 17 ก.ย. 15:00');
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

describe('familyClock', () => {
  const row = {
    id: 'f',
    timezone: ZONE,
    digestMorningAt: 420,
    digestEveningAt: 1200,
    digestMorningOn: true,
    digestEveningOn: true,
    digestEveryMorning: true,
  };

  it('schedules both slots and a daily morning by default', () => {
    expect(familyClock(row)).toEqual({ familyId: 'f', timezone: ZONE, slots: [420, 1200], quietDaySlot: 420 });
  });

  it('drops a switched-off slot, and the daily morning goes with the morning', () => {
    expect(familyClock({ ...row, digestMorningOn: false })).toMatchObject({ slots: [1200], quietDaySlot: null });
    expect(familyClock({ ...row, digestEveningOn: false })).toMatchObject({ slots: [420], quietDaySlot: 420 });
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
    });
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
