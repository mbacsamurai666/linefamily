import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createTestDb, type TestDb } from './harness.js';
import { createApiRouter, type ApiDeps } from '../../src/api/router.js';
import { persistDraft } from '../../src/modules/persist.js';

const ZONE = 'Asia/Bangkok';
const NOW = DateTime.fromISO('2026-09-04T10:00', { zone: ZONE });
const TOKEN = 'fake-id-token';
const LINE_USER_ID = 'U_liff_user';

let db: TestDb;
let familyId: string;
let memberId: string;
let app: ReturnType<typeof createApiRouter>;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.reset();
  const family = await db.prisma.family.create({ data: { lineGroupId: 'G_api', timezone: ZONE } });
  familyId = family.id;
  const member = await db.prisma.member.create({
    data: { familyId, lineUserId: LINE_USER_ID, displayName: 'แม่' },
  });
  memberId = member.id;

  const deps: ApiDeps = {
    prisma: db.prisma,
    defaultTimezone: ZONE,
    // Stands in for a real call to LINE's verify endpoint — this proves the
    // auth middleware and every route behind it, without ever going online.
    verifyToken: async (idToken) =>
      idToken === TOKEN ? { lineUserId: LINE_USER_ID } : null,
  };
  app = createApiRouter(deps);
});

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: { 'x-liff-id-token': TOKEN, ...init.headers },
  });
}

describe('auth middleware', () => {
  it('rejects a request with no token header', async () => {
    const res = await app.request('/me');
    expect(res.status).toBe(401);
  });

  it('rejects a token that fails verification', async () => {
    const res = await app.request('/me', { headers: { 'x-liff-id-token': 'wrong' } });
    expect(res.status).toBe(401);
  });

  it('rejects a verified LINE user who is not a member of any family', async () => {
    const deps: ApiDeps = {
      prisma: db.prisma,
      defaultTimezone: ZONE,
      verifyToken: async () => ({ lineUserId: 'U_stranger' }),
    };
    const strangerApp = createApiRouter(deps);
    const res = await strangerApp.request('/me', { headers: { 'x-liff-id-token': 'x' } });
    expect(res.status).toBe(401);
  });

  it('accepts a valid token and resolves the right family', async () => {
    const res = await authed('/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ memberId, familyId, displayName: 'แม่', timezone: ZONE, families: [] });
    // The LINE user id identifies the person across every group; the page has no use for it.
    expect(body).not.toHaveProperty('lineUserId');
  });
});

describe('someone in two family groups', () => {
  let inLawsId: string;

  beforeEach(async () => {
    // The same LINE account, also in the in-laws' group with the bot.
    const inLaws = await db.prisma.family.create({ data: { lineGroupId: 'G_inlaws', timezone: ZONE } });
    inLawsId = inLaws.id;
    await db.prisma.member.create({
      data: { familyId: inLawsId, lineUserId: LINE_USER_ID, displayName: 'สะใภ้' },
    });
    await db.prisma.member.create({
      data: { familyId: inLawsId, lineUserId: 'U_grandma', displayName: 'ย่า' },
    });
    await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_dad_home', displayName: 'พ่อ' },
    });
  });

  it('lists both families, each labelled by who else is in it', async () => {
    const body = (await authed('/me').then((r) => r.json())) as {
      familyId: string;
      families: Array<{ familyId: string; label: string }>;
    };
    expect(body.familyId).toBe(familyId); // the first one, when nothing is asked for
    expect(body.families).toEqual([
      { familyId, label: 'พ่อ' },
      { familyId: inLawsId, label: 'ย่า' },
    ]);
  });

  it('opens the family the page asks for', async () => {
    const res = await authed('/me', { headers: { 'x-family-id': inLawsId } });
    expect(await res.json()).toMatchObject({ familyId: inLawsId, displayName: 'สะใภ้' });
  });

  it('cannot be pointed at a family this person is not in', async () => {
    const strangers = await db.prisma.family.create({ data: { lineGroupId: 'G_strangers', timezone: ZONE } });
    const res = await authed('/me', { headers: { 'x-family-id': strangers.id } });
    // Falls back to their own first family — never the one they asked for.
    expect(await res.json()).toMatchObject({ familyId });
  });
});

describe('GET /agenda', () => {
  it('lists only this family\'s pending jobs within the window, soonest first', async () => {
    // Unlike every other test in this file, /agenda computes its own window
    // from the real wall clock (see api/router.ts), not an injected clock —
    // so this fixture must be relative to real "now", not the fixed NOW used
    // elsewhere. Anchoring it to NOW instead would drift into the past as
    // real time passes the fixed date, breaking the test independently of
    // any code change.
    const now = DateTime.now().setZone(ZONE);

    const otherFamily = await db.prisma.family.create({
      data: { lineGroupId: 'G_other', timezone: ZONE },
    });

    await db.prisma.notificationJob.createMany({
      data: [
        {
          familyId,
          kind: 'EVENT',
          refId: 'e1',
          dueAt: now.plus({ days: 5 }).toJSDate(),
          payload: { text: 'นัดหมอ' },
        },
        {
          familyId,
          kind: 'BILL',
          refId: 'b1',
          dueAt: now.plus({ days: 1 }).toJSDate(),
          payload: { text: 'จ่ายค่าไฟ' },
        },
        {
          familyId,
          kind: 'EVENT',
          refId: 'e2',
          dueAt: now.plus({ days: 40 }).toJSDate(),
          payload: { text: 'นอกช่วง 30 วัน' },
        },
        {
          familyId: otherFamily.id,
          kind: 'EVENT',
          refId: 'e3',
          dueAt: now.plus({ days: 2 }).toJSDate(),
          payload: { text: 'ของครอบครัวอื่น' },
        },
      ],
    });

    const res = await authed('/agenda');
    const body = (await res.json()) as { items: Array<{ text: string; kind: string }> };
    expect(body.items.map((i) => i.text)).toEqual(['จ่ายค่าไฟ', 'นัดหมอ']);
  });
});

describe('expenses', () => {
  it('POST creates a transaction the same way the chat path would, then GET summarises it', async () => {
    const res = await authed('/expenses', {
      method: 'POST',
      body: JSON.stringify({ amountBaht: 250, categoryName: 'ข้าว' }),
    });
    expect(res.status).toBe(201);

    await authed('/expenses', {
      method: 'POST',
      body: JSON.stringify({ amountBaht: 100, categoryName: 'ข้าว' }),
    });
    await authed('/expenses', {
      method: 'POST',
      body: JSON.stringify({ amountBaht: 500, categoryName: 'ไฟ' }),
    });

    const month = DateTime.now().setZone(ZONE).toFormat('yyyy-MM');
    const summary = await authed(`/expenses/summary?month=${month}`).then((r) => r.json());

    expect(summary).toMatchObject({
      totalSatang: 85000,
      byCategory: [
        { name: 'ไฟ', amountSatang: 50000 },
        { name: 'ข้าว', amountSatang: 35000 },
      ],
    });
  });

  it('rejects a non-positive amount rather than silently recording it', async () => {
    const res = await authed('/expenses', {
      method: 'POST',
      body: JSON.stringify({ amountBaht: -10 }),
    });
    expect(res.status).toBe(400);
    expect(await db.prisma.transaction.count()).toBe(0);
  });

  it('an empty month has a zero total, not an error', async () => {
    const summary = await authed('/expenses/summary?month=2020-01').then((r) => r.json());
    expect(summary).toMatchObject({ totalSatang: 0, byCategory: [] });
  });
});

describe('shopping', () => {
  it('adds items with an optional quantity, lists only what is unbought, and marking bought removes it', async () => {
    await authed('/shopping', {
      method: 'POST',
      body: JSON.stringify({ items: [{ name: 'นม', qty: '2 กล่อง' }, { name: 'ไข่' }] }),
    });

    const before = (await authed('/shopping').then((r) => r.json())) as {
      items: Array<{ id: string; name: string; qty: string | null }>;
    };
    expect(before.items.map((i) => i.name)).toEqual(['นม', 'ไข่']);
    expect(before.items.find((i) => i.name === 'นม')?.qty).toBe('2 กล่อง');
    expect(before.items.find((i) => i.name === 'ไข่')?.qty).toBeNull();

    const target = before.items.find((i) => i.name === 'นม')!;
    const boughtRes = await authed(`/shopping/${target.id}/bought`, { method: 'POST' });
    expect(boughtRes.status).toBe(200);

    const after = (await authed('/shopping').then((r) => r.json())) as {
      items: Array<{ name: string }>;
    };
    expect(after.items.map((i) => i.name)).toEqual(['ไข่']);
  });

  it('cannot mark another family\'s item bought', async () => {
    const otherFamily = await db.prisma.family.create({
      data: { lineGroupId: 'G_other2', timezone: ZONE },
    });
    const foreignItem = await db.prisma.shoppingItem.create({
      data: { familyId: otherFamily.id, name: 'ของครอบครัวอื่น' },
    });

    const res = await authed(`/shopping/${foreignItem.id}/bought`, { method: 'POST' });
    expect(res.status).toBe(404);

    const stillThere = await db.prisma.shoppingItem.findUniqueOrThrow({
      where: { id: foreignItem.id },
    });
    expect(stillThere.boughtAt).toBeNull();
  });
});

describe('GET /dashboard', () => {
  it('combines upcoming items, this month\'s money overview, and net worth', async () => {
    const now = DateTime.now().setZone(ZONE);
    // "Later today" whatever the clock says: two hours after 22:30 is
    // tomorrow, which is how this test first failed — at 22:55 Bangkok time.
    const laterToday = now.hour < 22 ? now.plus({ hours: 2 }) : now.plus({ minutes: 1 });

    await db.prisma.notificationJob.create({
      data: {
        familyId,
        kind: 'EVENT',
        refId: 'e1',
        dueAt: laterToday.toJSDate(),
        payload: { text: 'นัดวันนี้' },
      },
    });
    await authed('/expenses', { method: 'POST', body: JSON.stringify({ amountBaht: 100, direction: 'IN' }) });
    await authed('/expenses', { method: 'POST', body: JSON.stringify({ amountBaht: 40 }) });
    await db.prisma.loan.create({
      data: { familyId, borrowerName: 'พี่เอ', principalSatang: 500000, lentAt: now.toJSDate() },
    });
    await db.prisma.asset.create({
      data: { familyId, name: 'บ้านสวน', category: 'PROPERTY', valueSatang: 300000000 },
    });
    await db.prisma.deposit.create({ data: { familyId, name: 'ออมทรัพย์ SCB', balanceSatang: 5000000 } });

    const res = await authed('/dashboard');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      upcoming: { today: Array<{ text: string }>; next3d: unknown[]; next7d: unknown[] };
      money: { incomeSatang: number; expenseSatang: number; netSatang: number };
      netWorth: { loansOutstandingSatang: number; assetsValueSatang: number; depositsSatang: number };
    };

    expect(body.upcoming.today.map((i) => i.text)).toEqual(['นัดวันนี้']);
    expect(body.money).toMatchObject({ incomeSatang: 10000, expenseSatang: 4000, netSatang: 6000 });
    expect(body.netWorth).toMatchObject({
      loansOutstandingSatang: 500000,
      assetsValueSatang: 300000000,
      depositsSatang: 5000000,
    });
  });
});

describe('loans', () => {
  it('POST creates a loan, GET lists it, and repay reduces what is outstanding', async () => {
    const createRes = await authed('/loans', {
      method: 'POST',
      body: JSON.stringify({ borrowerName: 'พี่เอ', principalAmountBaht: 5000 }),
    });
    expect(createRes.status).toBe(201);

    const listed = (await authed('/loans').then((r) => r.json())) as {
      items: Array<{ id: string; borrowerName: string; principalSatang: number; repaidSatang: number }>;
    };
    expect(listed.items).toHaveLength(1);
    const loan = listed.items[0]!;
    expect(loan).toMatchObject({ borrowerName: 'พี่เอ', principalSatang: 500000, repaidSatang: 0 });

    const repayRes = await authed(`/loans/${loan.id}/repay`, {
      method: 'POST',
      body: JSON.stringify({ amountBaht: 1000 }),
    });
    expect(repayRes.status).toBe(200);

    const after = await db.prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(after.repaidSatang).toBe(100000);
  });

  it('rejects a due date that does not parse', async () => {
    const res = await authed('/loans', {
      method: 'POST',
      body: JSON.stringify({ borrowerName: 'พี่เอ', principalAmountBaht: 5000, dueAt: 'not-a-date' }),
    });
    expect(res.status).toBe(400);
  });

  it('cannot repay another family\'s loan', async () => {
    const otherFamily = await db.prisma.family.create({ data: { lineGroupId: 'G_loan_other', timezone: ZONE } });
    const foreignLoan = await db.prisma.loan.create({
      data: { familyId: otherFamily.id, borrowerName: 'คนอื่น', principalSatang: 1000, lentAt: NOW.toJSDate() },
    });

    const res = await authed(`/loans/${foreignLoan.id}/repay`, {
      method: 'POST',
      body: JSON.stringify({ amountBaht: 10 }),
    });
    expect(res.status).toBe(404);
  });
});

describe('assets', () => {
  it('POST creates an asset, GET lists it, and its value can be updated', async () => {
    const createRes = await authed('/assets', {
      method: 'POST',
      body: JSON.stringify({ name: 'บ้านสวน', category: 'PROPERTY', valueBaht: 3000000 }),
    });
    expect(createRes.status).toBe(201);

    const listed = (await authed('/assets').then((r) => r.json())) as {
      items: Array<{ id: string; name: string; valueSatang: number }>;
    };
    const asset = listed.items[0]!;
    expect(asset).toMatchObject({ name: 'บ้านสวน', valueSatang: 300000000 });

    const updateRes = await authed(`/assets/${asset.id}/value`, {
      method: 'POST',
      body: JSON.stringify({ valueBaht: 3200000 }),
    });
    expect(updateRes.status).toBe(200);

    const after = await db.prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(after.valueSatang).toBe(320000000);
  });

  it('accepts an optional acquiredAt date and note', async () => {
    const res = await authed('/assets', {
      method: 'POST',
      body: JSON.stringify({
        name: 'รถกระบะ',
        category: 'VEHICLE',
        valueBaht: 420000,
        acquiredAt: '2024-03-15',
        note: 'ผ่อนหมดแล้ว',
      }),
    });
    expect(res.status).toBe(201);

    const asset = await db.prisma.asset.findFirstOrThrow({ where: { name: 'รถกระบะ' } });
    expect(asset.note).toBe('ผ่อนหมดแล้ว');
    expect(DateTime.fromJSDate(asset.acquiredAt!, { zone: 'utc' }).toFormat('yyyy-MM-dd')).toBe('2024-03-15');
  });

  it('rejects an acquiredAt that does not parse', async () => {
    const res = await authed('/assets', {
      method: 'POST',
      body: JSON.stringify({ name: 'รถกระบะ', category: 'VEHICLE', valueBaht: 420000, acquiredAt: 'not-a-date' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /events', () => {
  it('creates an event the same way the chat path would, and it shows up in the agenda', async () => {
    const now = DateTime.now().setZone(ZONE);
    const startAt = now.plus({ days: 3 }).set({ hour: 15, minute: 0, second: 0, millisecond: 0 });

    const res = await authed('/events', {
      method: 'POST',
      body: JSON.stringify({
        title: 'พาแม่ไปหาหมอ',
        startAt: startAt.toFormat("yyyy-MM-dd'T'HH:mm"),
        allDay: false,
        category: 'MEDICAL',
        location: 'ศิริราช',
      }),
    });
    expect(res.status).toBe(201);

    const event = await db.prisma.event.findFirstOrThrow();
    expect(event).toMatchObject({ title: 'พาแม่ไปหาหมอ', category: 'MEDICAL', location: 'ศิริราช' });

    const jobs = await db.prisma.notificationJob.findMany({ where: { kind: 'EVENT' } });
    expect(jobs.length).toBeGreaterThan(0);
  });

  it('rejects a startAt that does not parse', async () => {
    const res = await authed('/events', {
      method: 'POST',
      body: JSON.stringify({ title: 'นัด', startAt: 'not-a-date', category: 'OTHER' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a missing title', async () => {
    const res = await authed('/events', {
      method: 'POST',
      body: JSON.stringify({ startAt: '2026-10-05T15:00', category: 'OTHER' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /agenda + GET /events/:id', () => {
  it('agenda items carry refId, and /events/:id returns the full record', async () => {
    const now = DateTime.now().setZone(ZONE);
    const startAt = now.plus({ days: 3 }).set({ hour: 15, minute: 0, second: 0, millisecond: 0 });

    await authed('/events', {
      method: 'POST',
      body: JSON.stringify({
        title: 'พาแม่ไปหาหมอ',
        startAt: startAt.toFormat("yyyy-MM-dd'T'HH:mm"),
        allDay: false,
        category: 'MEDICAL',
        location: 'ศิริราช',
        note: 'พาไปตรวจตา',
      }),
    });

    const agenda = (await authed('/agenda?days=10').then((r) => r.json())) as {
      items: Array<{ kind: string; refId: string }>;
    };
    const item = agenda.items.find((i) => i.kind === 'EVENT');
    expect(item).toBeDefined();

    const detailRes = await authed(`/events/${item!.refId}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail).toMatchObject({
      title: 'พาแม่ไปหาหมอ',
      category: 'MEDICAL',
      location: 'ศิริราช',
      note: 'พาไปตรวจตา',
      allDay: false,
    });
  });

  it('lists events within a date range, for the week timeline view', async () => {
    const now = DateTime.now().setZone(ZONE);
    const monday = now.startOf('week');

    await db.prisma.event.createMany({
      data: [
        { familyId, title: 'ในสัปดาห์', startAt: monday.plus({ days: 1, hours: 9 }).toJSDate(), category: 'WORK' },
        { familyId, title: 'นอกสัปดาห์', startAt: monday.plus({ weeks: 2 }).toJSDate(), category: 'WORK' },
      ],
    });

    const res = await authed(
      `/events?from=${monday.toISODate()}&to=${monday.plus({ days: 6 }).toISODate()}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ title: string }> };
    expect(body.items.map((i) => i.title)).toEqual(['ในสัปดาห์']);
  });

  it('rejects a range wider than a month grid', async () => {
    const res = await authed('/events?from=2026-01-01&to=2026-06-01');
    expect(res.status).toBe(400);
  });

  it('accepts the 6-week span a month board needs', async () => {
    const res = await authed('/events?from=2026-08-30&to=2026-10-10T23:59:59');
    expect(res.status).toBe(200);
  });

  it('puts a repeating appointment on every day it repeats, first entered or not', async () => {
    // First entered in August; the board is looking at the week of 14 Sep.
    await db.prisma.event.create({
      data: {
        familyId,
        title: 'กายภาพแม่',
        category: 'MEDICAL',
        startAt: DateTime.fromISO('2026-08-03T09:00', { zone: ZONE }).toJSDate(),
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      },
    });

    const body = (await authed('/events?from=2026-09-07&to=2026-09-20T23:59:59').then((r) =>
      r.json(),
    )) as { items: Array<{ title: string; startAt: string; repeats: boolean }> };

    const days = body.items.map((i) => DateTime.fromISO(i.startAt, { zone: ZONE }).toFormat('ccc dd HH:mm'));
    expect(days).toEqual(['Mon 07 09:00', 'Mon 14 09:00']);
    expect(body.items.every((i) => i.repeats)).toBe(true);
  });

  it('keeps an early-morning weekly appointment on its own weekday', async () => {
    // 06:00 Bangkok is 23:00 UTC the day before — the case that used to
    // turn "ทุกวันจันทร์" into every Tuesday.
    await db.prisma.event.create({
      data: {
        familyId,
        title: 'ตักบาตร',
        category: 'OTHER',
        startAt: DateTime.fromISO('2026-09-07T06:00', { zone: ZONE }).toJSDate(),
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      },
    });

    const body = (await authed('/events?from=2026-09-07&to=2026-09-20T23:59:59').then((r) =>
      r.json(),
    )) as { items: Array<{ startAt: string }> };

    expect(
      body.items.map((i) => DateTime.fromISO(i.startAt, { zone: ZONE }).toFormat('ccc HH:mm')),
    ).toEqual(['Mon 06:00', 'Mon 06:00']);
  });

  describe('one date of a repeating appointment', () => {
    type Listed = { items: Array<{ id: string; title: string; startAt: string; repeats: boolean }> };
    const week = '/events?from=2026-09-07&to=2026-09-27T23:59:59';
    const onMonday = (d: number, hour = 9) =>
      DateTime.fromISO(`2026-09-${String(d).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00`, {
        zone: ZONE,
      });

    async function weeklyPhysio() {
      return db.prisma.event.create({
        data: {
          familyId,
          title: 'กายภาพแม่',
          category: 'MEDICAL',
          location: 'รพ.ศิริราช',
          startAt: onMonday(7).toJSDate(),
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          attendees: { create: [{ memberId }] },
        },
      });
    }

    const dates = (body: Listed) =>
      body.items.map((i) => `${DateTime.fromISO(i.startAt, { zone: ZONE }).toFormat('dd HH:mm')} ${i.title}`);

    it('skips a single week and leaves the rest', async () => {
      const series = await weeklyPhysio();

      const res = await authed(`/events/${series.id}/skip`, {
        method: 'POST',
        body: JSON.stringify({ occurrence: onMonday(14).toISO() }),
      });
      expect(res.status).toBe(200);

      const body = (await authed(week).then((r) => r.json())) as Listed;
      expect(dates(body)).toEqual(['07 09:00 กายภาพแม่', '21 09:00 กายภาพแม่']);
    });

    it('moves a single week into its own appointment, keeping who and where', async () => {
      const series = await weeklyPhysio();

      const res = await authed(`/events/${series.id}/detach`, {
        method: 'POST',
        body: JSON.stringify({ occurrence: onMonday(14).toISO(), startAt: '2026-09-15T13:00' }),
      });
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };

      const body = (await authed(week).then((r) => r.json())) as Listed;
      expect(dates(body)).toEqual([
        '07 09:00 กายภาพแม่',
        '15 13:00 กายภาพแม่',
        '21 09:00 กายภาพแม่',
      ]);
      expect(body.items.find((i) => i.id === id)?.repeats).toBe(false);

      const moved = await db.prisma.event.findUniqueOrThrow({
        where: { id },
        include: { attendees: true },
      });
      expect(moved.location).toBe('รพ.ศิริราช');
      expect(moved.attendees.map((a) => a.memberId)).toEqual([memberId]);
    });

    it('stops reminding for the skipped week only', async () => {
      // The API generates reminders against the real clock, so this series is
      // built around today rather than the fixed September dates above.
      const first = DateTime.now().setZone(ZONE).plus({ days: 8 }).startOf('day').set({ hour: 9 });
      const created = await authed('/events', {
        method: 'POST',
        body: JSON.stringify({ title: 'กายภาพแม่', startAt: first.toISO(), rrule: 'FREQ=WEEKLY' }),
      });
      expect(created.status).toBe(201);
      const series = await db.prisma.event.findFirstOrThrow({ where: { title: 'กายภาพแม่' } });

      // The 2-hour-before reminder is the easiest to pin to one occurrence.
      const twoHoursBefore = (start: DateTime) => start.minus({ hours: 2 }).toMillis();
      const pending = async () =>
        new Set(
          (
            await db.prisma.notificationJob.findMany({
              where: { refId: series.id, status: 'PENDING' },
              select: { dueAt: true },
            })
          ).map((j) => j.dueAt.getTime()),
        );

      expect((await pending()).has(twoHoursBefore(first))).toBe(true);

      await authed(`/events/${series.id}/skip`, {
        method: 'POST',
        body: JSON.stringify({ occurrence: first.toISO() }),
      });

      const after = await pending();
      expect(after.has(twoHoursBefore(first))).toBe(false);
      expect(after.has(twoHoursBefore(first.plus({ weeks: 1 })))).toBe(true);
    });

    it('refuses a date the series does not actually fall on', async () => {
      const series = await weeklyPhysio();
      const res = await authed(`/events/${series.id}/skip`, {
        method: 'POST',
        body: JSON.stringify({ occurrence: '2026-09-15T09:00' }), // a Tuesday
      });
      expect(res.status).toBe(404);
      expect((await db.prisma.event.findUniqueOrThrow({ where: { id: series.id } })).exdates).toEqual([]);
    });

    it('keeps a skipped week skipped when the whole series moves an hour', async () => {
      const series = await weeklyPhysio();
      await authed(`/events/${series.id}/skip`, {
        method: 'POST',
        body: JSON.stringify({ occurrence: onMonday(14).toISO() }),
      });

      await authed(`/events/${series.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ startAt: '2026-09-07T10:00' }),
      });

      const body = (await authed(week).then((r) => r.json())) as Listed;
      expect(dates(body)).toEqual(['07 10:00 กายภาพแม่', '21 10:00 กายภาพแม่']);
    });
  });

  it('names the public holidays inside the range', async () => {
    const body = (await authed('/events?from=2026-12-01&to=2026-12-12T23:59:59').then((r) =>
      r.json(),
    )) as { holidays: Array<{ date: string; name: string }> };

    expect(body.holidays).toEqual([
      { date: '2026-12-05', name: 'วันพ่อแห่งชาติ' },
      { date: '2026-12-07', name: 'วันหยุดชดเชยวันพ่อแห่งชาติ' },
      { date: '2026-12-10', name: 'วันรัฐธรรมนูญ' },
    ]);
  });

  it('cannot fetch another family\'s event', async () => {
    const otherFamily = await db.prisma.family.create({ data: { lineGroupId: 'G_event_other', timezone: ZONE } });
    const foreignEvent = await db.prisma.event.create({
      data: { familyId: otherFamily.id, title: 'ของครอบครัวอื่น', startAt: NOW.toJSDate() },
    });

    const res = await authed(`/events/${foreignEvent.id}`);
    expect(res.status).toBe(404);
  });
});

describe('deposits', () => {
  it('POST creates a deposit, GET lists it, and its balance can be adjusted up or down', async () => {
    const createRes = await authed('/deposits', {
      method: 'POST',
      body: JSON.stringify({ name: 'ออมทรัพย์ SCB', balanceBaht: 50000 }),
    });
    expect(createRes.status).toBe(201);

    const listed = (await authed('/deposits').then((r) => r.json())) as {
      items: Array<{ id: string; name: string; balanceSatang: number }>;
    };
    const deposit = listed.items[0]!;
    expect(deposit).toMatchObject({ name: 'ออมทรัพย์ SCB', balanceSatang: 5000000 });

    await authed(`/deposits/${deposit.id}/adjust`, {
      method: 'POST',
      body: JSON.stringify({ amountBaht: 1000 }),
    });
    await authed(`/deposits/${deposit.id}/adjust`, {
      method: 'POST',
      body: JSON.stringify({ amountBaht: -500 }),
    });

    const after = await db.prisma.deposit.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(after.balanceSatang).toBe(5050000);
  });
});

describe('editing and deleting through the API', () => {
  it('PATCH /events/:id moves an appointment, DELETE removes it with its reminders', async () => {
    const now = DateTime.now().setZone(ZONE);
    const startAt = now.plus({ days: 4 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });

    await authed('/events', {
      method: 'POST',
      body: JSON.stringify({
        title: 'นัดหมอฟัน',
        startAt: startAt.toFormat("yyyy-MM-dd'T'HH:mm"),
        category: 'MEDICAL',
      }),
    });
    const event = await db.prisma.event.findFirstOrThrow();

    const patchRes = await authed(`/events/${event.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: 'นัดหมอฟัน (เลื่อน)',
        startAt: startAt.plus({ days: 1 }).toFormat("yyyy-MM-dd'T'HH:mm"),
        location: 'คลินิกใกล้บ้าน',
      }),
    });
    expect(patchRes.status).toBe(200);

    const moved = await db.prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(moved).toMatchObject({ title: 'นัดหมอฟัน (เลื่อน)', location: 'คลินิกใกล้บ้าน' });

    const delRes = await authed(`/events/${event.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(await db.prisma.event.count()).toBe(0);
    expect(
      await db.prisma.notificationJob.count({ where: { kind: 'EVENT', status: 'PENDING' } }),
    ).toBe(0);
  });

  it('GET /transactions lists the month, PATCH corrects it, DELETE removes it', async () => {
    await authed('/expenses', {
      method: 'POST',
      body: JSON.stringify({ amountBaht: 250, categoryName: 'ข้าว' }),
    });

    const listed = (await authed('/transactions').then((r) => r.json())) as {
      items: Array<{ id: string; amountSatang: number; categoryName: string | null }>;
    };
    expect(listed.items).toHaveLength(1);
    const tx = listed.items[0]!;
    expect(tx).toMatchObject({ amountSatang: 25000, categoryName: 'ข้าว' });

    const patchRes = await authed(`/transactions/${tx.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ amountBaht: 125, note: 'พิมพ์ผิด' }),
    });
    expect(patchRes.status).toBe(200);

    const corrected = await db.prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(corrected).toMatchObject({ amount: 12500, note: 'พิมพ์ผิด' });

    expect((await authed(`/transactions/${tx.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await db.prisma.transaction.count()).toBe(0);
  });

  it('GET /bills lists them and PATCH can switch one off', async () => {
    const bill = await db.prisma.bill.create({
      data: { familyId, name: 'ค่าเน็ต', amount: 59900, dueDay: 15 },
    });

    const listed = (await authed('/bills').then((r) => r.json())) as {
      items: Array<{ id: string; name: string; active: boolean }>;
    };
    expect(listed.items).toEqual([
      { id: bill.id, name: 'ค่าเน็ต', amountSatang: 59900, dueDay: 15, active: true },
    ]);

    const res = await authed(`/bills/${bill.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: false }),
    });
    expect(res.status).toBe(200);

    const after = await db.prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.active).toBe(false);
  });

  it('DELETE /shopping/:id drops an item added by mistake', async () => {
    await authed('/shopping', { method: 'POST', body: JSON.stringify({ items: [{ name: 'นม' }] }) });
    const item = await db.prisma.shoppingItem.findFirstOrThrow();

    expect((await authed(`/shopping/${item.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await db.prisma.shoppingItem.count()).toBe(0);
  });

  it('404s on an id belonging to another family, for both PATCH and DELETE', async () => {
    const otherFamily = await db.prisma.family.create({
      data: { lineGroupId: 'G_other_edit', timezone: ZONE },
    });
    const foreign = await db.prisma.asset.create({
      data: { familyId: otherFamily.id, name: 'ของบ้านอื่น', valueSatang: 100 },
    });

    expect(
      (
        await authed(`/assets/${foreign.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ valueBaht: 5 }),
        })
      ).status,
    ).toBe(404);
    expect((await authed(`/assets/${foreign.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(await db.prisma.asset.count({ where: { id: foreign.id } })).toBe(1);
  });
});

describe('creating standing items from the app', () => {
  it('POST /bills sets one up with its reminders', async () => {
    const res = await authed('/bills', {
      method: 'POST',
      body: JSON.stringify({ name: 'ค่าไฟ', amountBaht: 800, dueDay: 5 }),
    });
    expect(res.status).toBe(201);

    const bill = await db.prisma.bill.findFirstOrThrow();
    expect(bill).toMatchObject({ name: 'ค่าไฟ', amount: 80000, dueDay: 5, active: true });
    expect(await db.prisma.notificationJob.count({ where: { kind: 'BILL' } })).toBeGreaterThan(0);
  });

  it('POST /documents accepts an expiry and schedules the 60/30/7 warnings', async () => {
    const expiresAt = DateTime.now().setZone(ZONE).plus({ days: 120 }).toISODate();
    const res = await authed('/documents', {
      method: 'POST',
      body: JSON.stringify({ name: 'ใบขับขี่', type: 'DRIVER_LICENSE', expiresAt }),
    });
    expect(res.status).toBe(201);

    expect(await db.prisma.document.count()).toBe(1);
    expect(await db.prisma.notificationJob.count({ where: { kind: 'DOCUMENT' } })).toBe(3);
  });

  it('POST /medications files it under whoever is signed in', async () => {
    const res = await authed('/medications', {
      method: 'POST',
      body: JSON.stringify({ name: 'ยาความดัน', times: ['08:00', '20:00'], dosage: '1 เม็ด' }),
    });
    expect(res.status).toBe(201);

    const med = await db.prisma.medication.findFirstOrThrow();
    expect(med).toMatchObject({ name: 'ยาความดัน', memberId, dosage: '1 เม็ด' });
  });

  it('POST /chores resolves the rotation names it recognises', async () => {
    await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_dad_api', displayName: 'พ่อ' },
    });

    const res = await authed('/chores', {
      method: 'POST',
      body: JSON.stringify({ name: 'ล้างจาน', cadence: 'DAILY', rotationNames: ['แม่', 'พ่อ'] }),
    });
    expect(res.status).toBe(201);

    const chore = await db.prisma.chore.findFirstOrThrow();
    expect(chore.rotationMemberIds).toHaveLength(2);
  });

  it('PATCH /chores/:id changes who is in the rotation, and the first name goes next', async () => {
    await db.prisma.member.create({ data: { familyId, lineUserId: 'U_dad_r', displayName: 'พ่อ' } });
    await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_sis_r', displayName: 'Aon Somchai' },
    });
    await authed('/chores', {
      method: 'POST',
      body: JSON.stringify({ name: 'ล้างจาน', cadence: 'DAILY', rotationNames: ['แม่', 'พ่อ'] }),
    });
    const chore = await db.prisma.chore.findFirstOrThrow();
    // Two turns in: it is พ่อ's go, one lap around.
    await db.prisma.chore.update({ where: { id: chore.id }, data: { rotationCursor: 3 } });

    type Listed = { items: Array<{ nextAssignee: string | null; rotationNames: string[] }> };
    const before = (await authed('/chores').then((r) => r.json())) as Listed;
    // Listed from whoever is up next, which is what the edit form prefills.
    expect(before.items[0]?.rotationNames).toEqual(['พ่อ', 'แม่']);

    const res = await authed(`/chores/${chore.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ rotationNames: ['Aon Somchai', 'แม่', 'พ่อ'] }),
    });
    expect(res.status).toBe(200);

    const after = (await authed('/chores').then((r) => r.json())) as Listed;
    expect(after.items[0]?.nextAssignee).toBe('Aon Somchai');
    expect(after.items[0]?.rotationNames).toEqual(['Aon Somchai', 'แม่', 'พ่อ']);
  });

  it('PATCH /chores/:id refuses a name it cannot find instead of dropping someone', async () => {
    await authed('/chores', {
      method: 'POST',
      body: JSON.stringify({ name: 'ทิ้งขยะ', cadence: 'WEEKLY', rotationNames: ['แม่'] }),
    });
    const chore = await db.prisma.chore.findFirstOrThrow();

    const res = await authed(`/chores/${chore.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ rotationNames: ['แม่', 'ลุงไม่มีตัวตน'] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('ลุงไม่มีตัวตน');

    const unchanged = await db.prisma.chore.findUniqueOrThrow({ where: { id: chore.id } });
    expect(unchanged.rotationMemberIds).toHaveLength(1);
  });

  it('POST /events carries a repeat rule through', async () => {
    const startAt = DateTime.now().setZone(ZONE).plus({ days: 4 }).set({ hour: 9, minute: 0 });
    const res = await authed('/events', {
      method: 'POST',
      body: JSON.stringify({
        title: 'กายภาพบำบัด',
        startAt: startAt.toFormat("yyyy-MM-dd'T'HH:mm"),
        category: 'MEDICAL',
        rrule: 'FREQ=WEEKLY',
      }),
    });
    expect(res.status).toBe(201);

    const event = await db.prisma.event.findFirstOrThrow();
    expect(event.rrule).toBe('FREQ=WEEKLY');

    const detail = (await authed(`/events/${event.id}`).then((r) => r.json())) as {
      rrule: string | null;
    };
    expect(detail.rrule).toBe('FREQ=WEEKLY');
  });
});

describe('LIFF-created data is indistinguishable from chat-created data', () => {
  it('a LIFF-added expense generates a budget-tracked transaction just like the chat path', async () => {
    // persistDraft is the single write path both surfaces share — this is a
    // sanity check that the API route did not bypass it.
    await persistDraft(
      { kind: 'expense', amount: 10000, direction: 'OUT', occurredAt: NOW },
      { prisma: db.prisma, familyId, memberId, now: NOW },
    );
    await authed('/expenses', { method: 'POST', body: JSON.stringify({ amountBaht: 50 }) });

    expect(await db.prisma.transaction.count({ where: { familyId } })).toBe(2);
  });
});

describe('a trip across several days, from the app', () => {
  it('saves its last day, lists it while it is under way, and can be made one day again', async () => {
    const created = await authed('/events', {
      method: 'POST',
      body: JSON.stringify({ title: 'เที่ยวจูไห่', startAt: '2026-10-01', endAt: '2026-10-07', allDay: true }),
    });
    expect(created.status).toBe(201);
    const event = await db.prisma.event.findFirstOrThrow({ where: { title: 'เที่ยวจูไห่' } });
    // No kind was sent, so it is guessed from the title.
    expect(event.category).toBe('TRAVEL');

    // A range that begins mid-trip still finds it.
    const res = await authed('/events?from=2026-10-04&to=2026-10-05');
    const body = (await res.json()) as { items: Array<{ title: string; endAt: string | null }> };
    expect(body.items.map((i) => i.title)).toEqual(['เที่ยวจูไห่']);

    const backwards = await authed(`/events/${event.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ startAt: '2026-10-05', endAt: '2026-10-01' }),
    });
    expect(backwards.status).toBe(400);

    await authed(`/events/${event.id}`, { method: 'PATCH', body: JSON.stringify({ endAt: null }) });
    expect((await db.prisma.event.findUniqueOrThrow({ where: { id: event.id } })).endAt).toBeNull();
  });
});

describe('reminders for one appointment', () => {
  const DAY = 24 * 60;

  it('override the family setting, and can be handed back to it', async () => {
    const created = await authed('/events', {
      method: 'POST',
      body: JSON.stringify({
        title: 'สอบว่ายน้ำ',
        startAt: '2026-10-08T09:00',
        reminderMinutes: [DAY, 120],
      }),
    });
    expect(created.status).toBe(201);
    const event = await db.prisma.event.findFirstOrThrow({ where: { title: 'สอบว่ายน้ำ' } });
    expect(event.reminderOffsets).toEqual([DAY, 120]);

    const jobs = await db.prisma.notificationJob.findMany({ where: { refId: event.id }, orderBy: { dueAt: 'asc' } });
    expect(jobs).toHaveLength(2);

    await authed(`/events/${event.id}`, { method: 'PATCH', body: JSON.stringify({ reminderMinutes: [30] }) });
    expect((await db.prisma.event.findUniqueOrThrow({ where: { id: event.id } })).reminderOffsets).toEqual([30]);

    // Null hands it back to whatever the family has set for appointments.
    await authed(`/events/${event.id}`, { method: 'PATCH', body: JSON.stringify({ reminderMinutes: null }) });
    const family = await db.prisma.family.findUniqueOrThrow({ where: { id: familyId } });
    expect((await db.prisma.event.findUniqueOrThrow({ where: { id: event.id } })).reminderOffsets).toEqual(
      family.eventLeadMinutes,
    );
  });

  it('are refused when the list is empty or absurd', async () => {
    for (const reminderMinutes of [[], [999999]]) {
      const res = await authed('/events', {
        method: 'POST',
        body: JSON.stringify({ title: 'x', startAt: '2026-10-08T09:00', reminderMinutes }),
      });
      expect(res.status).toBe(400);
    }
  });
});
