import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { messagingApi } from '@line/bot-sdk';
import { createTestDb, type TestDb } from './harness.js';
import { ReminderEngine } from '../../src/reminders/engine.js';
import {
  LineNotifier,
  PrismaBudgetStore,
  PrismaFamilyStore,
  PrismaJobStore,
} from '../../src/reminders/prisma-stores.js';
import { persistDraft } from '../../src/modules/persist.js';

const ZONE = 'Asia/Bangkok';
const QUOTA = 500;

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
  const family = await db.prisma.family.create({
    data: { lineGroupId: 'G_engine', timezone: ZONE },
  });
  familyId = family.id;
});

/** Minimal stand-in for the LINE client: records what would have been sent. */
function fakeApi() {
  const pushed: Array<{ to: string; altText: string }> = [];
  const api = {
    pushMessage: async (req: messagingApi.PushMessageRequest) => {
      const first = req.messages[0];
      pushed.push({
        to: req.to,
        altText: first && 'altText' in first ? String(first.altText) : (first?.type ?? ''),
      });
      return {};
    },
  } as unknown as messagingApi.MessagingApiClient;
  return { api, pushed };
}

function buildEngine(now: () => DateTime, api: messagingApi.MessagingApiClient) {
  return new ReminderEngine({
    jobs: new PrismaJobStore(db.prisma),
    budget: new PrismaBudgetStore(db.prisma, QUOTA),
    notifier: new LineNotifier(api, db.prisma),
    families: new PrismaFamilyStore(db.prisma),
    clock: { now },
    morningHour: 7,
    eveningHour: 20,
    reserveThreshold: 60,
  });
}

describe('PrismaJobStore', () => {
  const now = DateTime.fromISO('2026-09-04T10:00', { zone: ZONE });

  it('claims only pending jobs that are due, on the right lane', async () => {
    const store = new PrismaJobStore(db.prisma);

    await db.prisma.notificationJob.createMany({
      data: [
        { familyId, kind: 'EVENT', refId: 'a', dueAt: now.minus({ hours: 1 }).toJSDate(), payload: { text: 'due' } },
        { familyId, kind: 'EVENT', refId: 'b', dueAt: now.plus({ hours: 1 }).toJSDate(), payload: { text: 'later' } },
        { familyId, kind: 'MEDICATION', refId: 'c', dueAt: now.minus({ hours: 1 }).toJSDate(), lane: 'URGENT', payload: { text: 'urgent' } },
        { familyId, kind: 'EVENT', refId: 'd', dueAt: now.minus({ hours: 2 }).toJSDate(), status: 'SENT', payload: { text: 'gone' } },
      ],
    });

    const digest = await store.claimDue(now.toJSDate(), 'DIGEST', 100);
    expect(digest.map((j) => j.refId)).toEqual(['a']);

    const urgent = await store.claimDue(now.toJSDate(), 'URGENT', 100);
    expect(urgent.map((j) => j.refId)).toEqual(['c']);
  });

  it('markSent is a no-op the second time, so a duplicate worker cannot double send', async () => {
    const store = new PrismaJobStore(db.prisma);
    const job = await db.prisma.notificationJob.create({
      data: { familyId, kind: 'EVENT', refId: 'x', dueAt: now.toJSDate(), payload: { text: 'once' } },
    });

    await store.markSent([job.id], now.toJSDate());
    const firstSentAt = (await db.prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } })).sentAt;

    await store.markSent([job.id], now.plus({ hours: 1 }).toJSDate());
    const after = await db.prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });

    expect(after.status).toBe('SENT');
    expect(after.sentAt?.getTime()).toBe(firstSentAt?.getTime());
  });
});

describe('PrismaBudgetStore', () => {
  it('counts consumption and creates the month row on first use', async () => {
    const budget = new PrismaBudgetStore(db.prisma, QUOTA);

    expect(await budget.remaining(familyId, '2026-09')).toBe(QUOTA);
    await budget.consume(familyId, '2026-09', 1);
    await budget.consume(familyId, '2026-09', 2);
    expect(await budget.remaining(familyId, '2026-09')).toBe(QUOTA - 3);

    // A different month starts fresh.
    expect(await budget.remaining(familyId, '2026-10')).toBe(QUOTA);
  });

  it('trusts the higher of our tally and what LINE reported', async () => {
    const budget = new PrismaBudgetStore(db.prisma, QUOTA);
    await budget.consume(familyId, '2026-09', 5);

    // LINE says more was sent than we counted — messages from the OA console.
    await db.prisma.pushBudget.update({
      where: { familyId_yearMonth: { familyId, yearMonth: '2026-09' } },
      data: { lineReported: 120 },
    });

    expect(await budget.remaining(familyId, '2026-09')).toBe(QUOTA - 120);
  });
});

describe('full loop: appointment -> jobs -> digest push', () => {
  it('delivers one push carrying every due reminder, and charges the budget once', async () => {
    const created = DateTime.fromISO('2026-09-04T10:00', { zone: ZONE });

    // Three appointments, all on the same day, 9 reminder jobs in total.
    for (const title of ['หาหมอ', 'ประชุม', 'รับลูก']) {
      await persistDraft(
        {
          kind: 'event',
          title,
          startAt: created.plus({ days: 12 }),
          allDay: false,
          category: 'OTHER',
        },
        { prisma: db.prisma, familyId, memberId: null, now: created },
      );
    }
    expect(await db.prisma.notificationJob.count()).toBe(9);

    const { api, pushed } = fakeApi();

    // Move to the morning after the 7-day reminders have come due.
    const digestTime = created.plus({ days: 5 }).set({ hour: 7, minute: 0, second: 0, millisecond: 0 });
    await buildEngine(() => digestTime, api).tick();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.to).toBe('G_engine');
    expect(pushed[0]?.altText).toContain('สรุปเช้านี้');

    const sent = await db.prisma.notificationJob.findMany({ where: { status: 'SENT' } });
    expect(sent).toHaveLength(3); // the three 7-day reminders

    const budget = await db.prisma.pushBudget.findUniqueOrThrow({
      where: { familyId_yearMonth: { familyId, yearMonth: '2026-09' } },
    });
    expect(budget.used).toBe(1);
  });

  it('a second tick in the same minute sends nothing more', async () => {
    const created = DateTime.fromISO('2026-09-04T10:00', { zone: ZONE });
    await persistDraft(
      { kind: 'event', title: 'นัด', startAt: created.plus({ days: 12 }), allDay: false, category: 'OTHER' },
      { prisma: db.prisma, familyId, memberId: null, now: created },
    );

    const { api, pushed } = fakeApi();
    const digestTime = created.plus({ days: 5 }).set({ hour: 7, minute: 0, second: 0, millisecond: 0 });
    const engine = buildEngine(() => digestTime, api);

    await engine.tick();
    await engine.tick();

    expect(pushed).toHaveLength(1);
    expect(
      (await db.prisma.pushBudget.findUniqueOrThrow({
        where: { familyId_yearMonth: { familyId, yearMonth: '2026-09' } },
      })).used,
    ).toBe(1);
  });

  it('demotes an urgent reminder to the digest when the reserve is gone', async () => {
    const now = DateTime.fromISO('2026-09-04T10:00', { zone: ZONE });
    await db.prisma.pushBudget.create({
      data: { familyId, yearMonth: '2026-09', used: QUOTA - 40 },
    });
    const job = await db.prisma.notificationJob.create({
      data: {
        familyId,
        kind: 'MEDICATION',
        refId: 'm1',
        dueAt: now.minus({ minutes: 1 }).toJSDate(),
        lane: 'URGENT',
        payload: { text: 'ยังไม่กดยืนยันกินยา' },
      },
    });

    const { api, pushed } = fakeApi();
    await buildEngine(() => now, api).tick();

    expect(pushed).toHaveLength(0);
    const after = await db.prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.lane).toBe('DIGEST');
    expect(after.status).toBe('PENDING');
  });
});
