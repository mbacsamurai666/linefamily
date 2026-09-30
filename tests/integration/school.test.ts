import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import type { messagingApi, WebhookEvent } from '@line/bot-sdk';
import { createTestDb, type TestDb } from './harness.js';
import { createApiRouter } from '../../src/api/router.js';
import { handleEvent } from '../../src/line/webhook.js';
import { DraftStore } from '../../src/line/drafts.js';
import { AssignmentStore } from '../../src/line/assignments.js';
import { RuleIntentParser } from '../../src/intent/RuleIntentParser.js';
import { toSchedule } from '../../src/intent/VisionParser.js';
import { listCalendar } from '../../src/modules/calendar.js';
import type { EventBatchDraft } from '../../src/intent/types.js';

/**
 * Most of what the family puts on its calendar is school, and school is the
 * children's — who are not in the LINE group. They are added in the app,
 * named in the chat, asked about after a notice is saved, and filtered by.
 */

const ZONE = 'Asia/Bangkok';
const GROUP_ID = 'G_school';
const TOKEN = 'fake-id-token';
const PARENT = 'U_parent';

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
  const family = await db.prisma.family.create({ data: { lineGroupId: GROUP_ID, timezone: ZONE } });
  familyId = family.id;
  await db.prisma.member.create({ data: { familyId, lineUserId: PARENT, displayName: 'แม่' } });
});

const app = () =>
  createApiRouter({
    prisma: db.prisma,
    defaultTimezone: ZONE,
    verifyToken: async (t) => (t === TOKEN ? { lineUserId: PARENT } : null),
  });

async function call<T = unknown>(path: string, init: RequestInit = {}) {
  const res = await app().request(path, {
    ...init,
    headers: { 'x-liff-id-token': TOKEN, 'content-type': 'application/json', ...init.headers },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

describe('the people in the house who are not in the LINE group', () => {
  it('can be added, renamed and removed; the LINE members cannot be removed', async () => {
    const added = await call<{ id: string }>('/people', {
      method: 'POST',
      body: JSON.stringify({ displayName: 'น้องพร', role: 'CHILD', birthDate: '2017-01-05' }),
    });
    expect(added.status).toBe(201);

    // A name is how the chat finds someone, so two alike are refused.
    const twin = await call('/people', { method: 'POST', body: JSON.stringify({ displayName: 'น้องพร' }) });
    expect(twin.status).toBe(409);

    const list = await call<{ items: Array<{ displayName: string; inLine: boolean; role: string }> }>('/people');
    expect(list.body.items.map((p) => [p.displayName, p.inLine, p.role])).toEqual([
      ['แม่', true, 'ADULT'],
      ['น้องพร', false, 'CHILD'],
    ]);

    await call(`/people/${added.body.id}`, { method: 'PATCH', body: JSON.stringify({ displayName: 'น้องพรพรรณ' }) });
    expect((await db.prisma.member.findUniqueOrThrow({ where: { id: added.body.id } })).displayName).toBe('น้องพรพรรณ');

    const parent = await db.prisma.member.findFirstOrThrow({ where: { lineUserId: PARENT } });
    expect((await call(`/people/${parent.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await call(`/people/${added.body.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await db.prisma.member.count()).toBe(1);
  });

  it('are named from the chat, and the calendar says whose appointment it is', async () => {
    await db.prisma.member.create({ data: { familyId, displayName: 'น้องพร', role: 'CHILD' } });
    const names = (await db.prisma.member.findMany({ select: { displayName: true } })).map((m) => m.displayName);
    const now = DateTime.fromISO('2026-09-30T10:00', { zone: ZONE });

    const parsed = await new RuleIntentParser().parse('น้องพร สอบปลายภาค 5 ต.ค.', {
      familyId,
      timezone: ZONE,
      now,
      memberNames: names,
      categoryNames: [],
    });
    if (parsed.kind !== 'event' || parsed.draft.kind !== 'event') throw new Error('expected an appointment');
    expect(parsed.draft.attendeeName).toBe('น้องพร');

    const { persistDraft } = await import('../../src/modules/persist.js');
    await persistDraft(parsed.draft, { prisma: db.prisma, familyId, memberId: null, now });

    const { items } = await listCalendar(db.prisma, familyId, now.startOf('month').plus({ months: 1 }), now.plus({ months: 1 }).endOf('month'), ZONE);
    expect(items.map((i) => [i.title, i.people])).toEqual([['สอบปลายภาค', ['น้องพร']]]);
  });
});

describe('"whose is it?" after a notice is saved', () => {
  function fakeApi() {
    const replyMessage = vi.fn().mockResolvedValue({});
    return { api: { replyMessage } as unknown as messagingApi.MessagingApiClient, replyMessage };
  }

  const postback = (data: string): WebhookEvent =>
    ({
      type: 'postback',
      replyToken: 'rt',
      source: { type: 'group', groupId: GROUP_ID, userId: PARENT },
      timestamp: 0,
      mode: 'active',
      postback: { data },
    }) as unknown as WebhookEvent;

  it('offers one button per child, and a tap names every appointment in it', async () => {
    const child = await db.prisma.member.create({ data: { familyId, displayName: 'น้องพร', role: 'CHILD' } });
    const drafts = new DraftStore();
    const assignments = new AssignmentStore();
    const { api, replyMessage } = fakeApi();
    const deps = {
      prisma: db.prisma,
      api,
      parser: { name: 'none', parse: async () => ({ kind: 'unknown' as const }) },
      drafts,
      assignments,
      defaultTimezone: ZONE,
    };

    const day = (iso: string) => DateTime.fromISO(iso, { zone: ZONE });
    const batch: EventBatchDraft = {
      kind: 'events',
      skippedPast: 0,
      events: [
        { kind: 'event', title: 'สอบปลายภาค', startAt: day('2027-03-01'), allDay: true, category: 'SCHOOL' },
        { kind: 'event', title: 'ปิดภาคเรียน', startAt: day('2027-03-20'), endAt: day('2027-05-10'), allDay: true, category: 'SCHOOL' },
      ],
    };
    const token = drafts.put({ draft: batch, familyId, memberId: null, source: 'llm', confidence: 0.9 });

    await handleEvent(postback(`action=confirm&token=${token}`), deps);
    const reply = replyMessage.mock.calls[0]?.[0].messages[0];
    expect(reply.text).toContain('เป็นนัดของใครครับ?');
    const button = reply.quickReply.items[0].action;
    expect(button.label).toBe('น้องพร');

    await handleEvent(postback(button.data), deps);
    expect(replyMessage.mock.calls[1]?.[0].messages[0].text).toContain('ของน้องพรให้ 2 นัด');
    expect(await db.prisma.eventAttendee.count({ where: { memberId: child.id } })).toBe(2);

    // The same tap again finds nothing to do: the question was answered.
    await handleEvent(postback(button.data), deps);
    expect(replyMessage.mock.calls[2]?.[0].messages[0].text).toContain('หมดเวลา');
    expect(await db.prisma.eventAttendee.count()).toBe(2);
  });

  it('asks nothing when there is no child to ask about', async () => {
    const drafts = new DraftStore();
    const { api, replyMessage } = fakeApi();
    const token = drafts.put({
      draft: {
        kind: 'event',
        title: 'ประชุมผู้ปกครอง',
        startAt: DateTime.fromISO('2027-03-01T09:00', { zone: ZONE }),
        allDay: false,
        category: 'SCHOOL',
      },
      familyId,
      memberId: null,
      source: 'rule',
      confidence: 0.9,
    });
    await handleEvent(postback(`action=confirm&token=${token}`), {
      prisma: db.prisma,
      api,
      parser: { name: 'none', parse: async () => ({ kind: 'unknown' as const }) },
      drafts,
      assignments: new AssignmentStore(),
      defaultTimezone: ZONE,
    });
    const reply = replyMessage.mock.calls[0]?.[0].messages[0];
    expect(reply.text).not.toContain('ของใคร');
    expect(reply.quickReply).toBeUndefined();
  });
});

describe('a weekly timetable read off a photo', () => {
  it('becomes one repeating appointment per class, from the next such day, until the course ends', () => {
    const now = DateTime.fromISO('2026-09-30T10:00', { zone: ZONE }); // a Wednesday
    const result = toSchedule(
      [
        { title: 'เรียนพิเศษคณิต', start_date: '2026-09-01', end_date: '2026-12-26', time: '09:00', repeat_weekday: 6 },
        { title: 'ว่ายน้ำ', start_date: '2026-10-05', end_date: null, time: '16:30', repeat_weekday: 1 },
      ],
      0.9,
      { familyId, timezone: ZONE, now, memberNames: [], categoryNames: [] },
    );
    if (result.kind !== 'events' || result.draft.kind !== 'events') throw new Error('expected a batch');
    const [maths, swim] = result.draft.events;

    expect(maths?.startAt.toFormat("yyyy-MM-dd'T'HH:mm")).toBe('2026-10-03T09:00'); // the first Saturday from today
    expect(maths?.rrule).toBe('FREQ=WEEKLY;BYDAY=SA;UNTIL=20261226T165959Z');
    expect(swim?.startAt.toFormat("yyyy-MM-dd'T'HH:mm")).toBe('2026-10-05T16:30');
    expect(swim?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(maths?.category).toBe('SCHOOL');
  });
});
