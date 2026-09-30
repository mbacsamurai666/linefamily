import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createTestDb, type TestDb } from './harness.js';
import { createApiRouter } from '../../src/api/router.js';

/**
 * The family's money merged into its calendar: recurring expenses and income
 * laid out on their due dates, settled one due date at a time, saved up for
 * in pots, and added up into months, a year and a dashboard — through the
 * same API the app uses, against a real database.
 */

const ZONE = 'Asia/Bangkok';
const TOKEN = 'fake-id-token';
const LINE_USER_ID = 'U_money';

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
  const family = await db.prisma.family.create({ data: { lineGroupId: 'G_money', timezone: ZONE } });
  familyId = family.id;
  await db.prisma.member.create({ data: { familyId, lineUserId: LINE_USER_ID, displayName: 'แม่' } });
});

const app = () =>
  createApiRouter({
    prisma: db.prisma,
    defaultTimezone: ZONE,
    verifyToken: async (t) => (t === TOKEN ? { lineUserId: LINE_USER_ID } : null),
  });

async function call<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await app().request(path, {
    ...init,
    headers: { 'x-liff-id-token': TOKEN, 'content-type': 'application/json', ...init.headers },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

const post = <T = unknown>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) });
const patch = <T = unknown>(path: string, body: unknown) => call<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

const now = () => DateTime.now().setZone(ZONE);
const iso = (dt: DateTime) => dt.toISODate() as string;

interface Money {
  billId: string;
  name: string;
  dueOn: string;
  amountSatang: number | null;
  status: string;
  direction: string;
  reservePerMonthSatang: number | null;
  paidSatang: number | null;
}

/** The calendar's money for the month holding `day`, as the board asks for it. */
async function monthMoney(day: DateTime): Promise<Money[]> {
  const start = day.startOf('month');
  const { body } = await call<{ money: Money[] }>(
    `/events?from=${iso(start)}T00:00:00&to=${iso(start.endOf('month'))}T23:59:59`,
  );
  return body.money;
}

async function addBill(body: Record<string, unknown>): Promise<string> {
  const res = await post<{ recordId: string }>('/bills', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.recordId;
}

describe('adding money to the calendar', () => {
  it('1. a one-off lands on its day and nowhere else', async () => {
    const day = now().plus({ days: 10 }).startOf('day');
    await addBill({ name: 'ค่าซ่อมรถ', amountBaht: 8000, frequency: 'ONCE', startsOn: iso(day), categoryName: 'รถ' });

    const money = await monthMoney(day);
    expect(money.filter((m) => m.name === 'ค่าซ่อมรถ').map((m) => m.dueOn)).toEqual([iso(day)]);
    expect(await monthMoney(day.plus({ months: 1 }))).toEqual([]);
  });

  it('2. a monthly one lands every month on its day', async () => {
    await addBill({ name: 'ค่าส่วนกลาง', amountBaht: 1500, dueDay: 1 });
    for (const offset of [0, 1, 2]) {
      const month = now().plus({ months: offset });
      expect((await monthMoney(month)).map((m) => m.dueOn)).toEqual([iso(month.startOf('month'))]);
    }
  });

  it('3. a yearly one lands once a year, in its month', async () => {
    const due = now().plus({ months: 2 }).set({ day: 15 });
    await addBill({ name: 'ประกันรถ', amountBaht: 24000, dueDay: 15, everyMonths: 12, dueMonth: due.month });
    expect((await monthMoney(due)).map((m) => m.dueOn)).toEqual([iso(due.startOf('day'))]);
    expect(await monthMoney(due.plus({ months: 1 }))).toEqual([]);
    expect((await monthMoney(due.plus({ years: 1 }))).map((m) => m.name)).toEqual(['ประกันรถ']);
  });

  it('shows money in and money out side by side', async () => {
    await addBill({ name: 'เงินเดือน', amountBaht: 50000, dueDay: 25, direction: 'IN', categoryName: 'เงินเดือน' });
    await addBill({ name: 'กยศ.', amountBaht: 1800, dueDay: 5 });
    const money = await monthMoney(now());
    expect(money.map((m) => [m.name, m.direction])).toEqual([
      ['กยศ.', 'OUT'],
      ['เงินเดือน', 'IN'],
    ]);
  });
});

describe('changing and removing', () => {
  it('4. an edit is seen on the calendar at once', async () => {
    const id = await addBill({ name: 'อินเทอร์เน็ต', amountBaht: 599, dueDay: 10 });
    expect((await patch(`/bills/${id}`, { amountBaht: 699 })).status).toBe(200);
    expect((await monthMoney(now()))[0]?.amountSatang).toBe(69900);
  });

  it('5. a removed item leaves the calendar and its reminders', async () => {
    const id = await addBill({ name: 'ค่าเรียนพิเศษ', amountBaht: 3000, dueDay: 28 });
    expect(await db.prisma.notificationJob.count({ where: { refId: id, status: 'PENDING' } })).toBeGreaterThan(0);

    expect((await call(`/bills/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await monthMoney(now())).toEqual([]);
    expect(await db.prisma.notificationJob.count({ where: { refId: id, status: 'PENDING' } })).toBe(0);
  });

  it('6. moving the due day moves every due date', async () => {
    const id = await addBill({ name: 'ค่าไฟ', amountBaht: 2500, dueDay: 20 });
    await patch(`/bills/${id}`, { dueDay: 12 });
    expect((await monthMoney(now()))[0]?.dueOn.slice(8, 10)).toBe('12');
  });
});

describe('paying', () => {
  it('7. marking a due date paid records it against that date, once', async () => {
    const due = now().plus({ days: 3 }).startOf('day');
    const id = await addBill({ name: 'ค่าเทอม', amountBaht: 60000, frequency: 'ONCE', startsOn: iso(due) });

    const first = await post<{ alreadyPaid: boolean; amountSatang: number }>(`/bills/${id}/pay`, {
      dueOn: iso(due),
      amountBaht: 59500,
      note: 'ได้ส่วนลด',
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ alreadyPaid: false, amountSatang: 5_950_000 });

    // 17. The same due date twice is still one payment.
    const again = await post<{ alreadyPaid: boolean }>(`/bills/${id}/pay`, { dueOn: iso(due) });
    expect(again.body.alreadyPaid).toBe(true);
    expect(await db.prisma.transaction.count({ where: { billId: id } })).toBe(1);

    const item = (await monthMoney(due)).find((m) => m.billId === id);
    expect(item).toMatchObject({ status: 'PAID', paidSatang: 5_950_000, amountSatang: 6_000_000 });
    // Planned and actual stay apart: the plan still says 60,000.
  });

  it('8. an unpaid due date gone by is overdue, and undoing a payment brings that back', async () => {
    const past = now().minus({ days: 5 }).startOf('day');
    const id = await addBill({ name: 'ค่าน้ำ', amountBaht: 400, frequency: 'ONCE', startsOn: iso(past) });
    expect((await monthMoney(past)).find((m) => m.billId === id)?.status).toBe('OVERDUE');

    await post(`/bills/${id}/pay`, { dueOn: iso(past) });
    expect((await monthMoney(past)).find((m) => m.billId === id)?.status).toBe('PAID');

    expect((await call(`/bills/${id}/pay?dueOn=${iso(past)}`, { method: 'DELETE' })).status).toBe(200);
    expect((await monthMoney(past)).find((m) => m.billId === id)?.status).toBe('OVERDUE');
  });

  it('does not call a due date from before the item was entered late', async () => {
    await addBill({ name: 'ค่าส่วนกลาง', amountBaht: 1500, dueDay: 1 });
    const lastMonth = await monthMoney(now().minus({ months: 1 }));
    expect(lastMonth[0]?.status).toBe('UNTRACKED');
  });

  it('pays a lumpy bill out of its pot, and puts it back when the payment is undone', async () => {
    const due = now().plus({ months: 3 }).set({ day: 10 }).startOf('day');
    const id = await addBill({ name: 'ประกันสุขภาพ', amountBaht: 36000, dueDay: 10, everyMonths: 12, dueMonth: due.month });
    await post(`/funds/${id}/entries`, { amountBaht: 10000, note: 'เก็บเดือนแรก' });

    await post(`/bills/${id}/pay`, { dueOn: iso(due) });
    const pot = await db.prisma.reserveEntry.aggregate({ where: { billId: id }, _sum: { amount: true } });
    expect(pot._sum.amount).toBe(0); // the 10,000 went to the premium

    await call(`/bills/${id}/pay?dueOn=${iso(due)}`, { method: 'DELETE' });
    const restored = await db.prisma.reserveEntry.aggregate({ where: { billId: id }, _sum: { amount: true } });
    expect(restored._sum.amount).toBe(1_000_000);
  });
});

describe('the numbers', () => {
  /** The spec's own example: 24,000 + 120,000 + 36,000 a year. */
  async function specExample(year: number) {
    await addBill({ name: 'ประกันรถ', amountBaht: 24000, dueDay: 15, everyMonths: 12, dueMonth: 1, categoryName: 'ประกัน' });
    await addBill({ name: 'ค่าเทอม', amountBaht: 60000, dueDay: 31, everyMonths: 6, dueMonth: 3, categoryName: 'การศึกษา' });
    await addBill({ name: 'ประกันสุขภาพ', amountBaht: 36000, dueDay: 30, everyMonths: 12, dueMonth: 6, categoryName: 'ประกัน' });
    await addBill({ name: 'ค่าส่วนกลาง', amountBaht: 1500, dueDay: 1, categoryName: 'บ้าน' });
    await addBill({ name: 'เงินเดือน', amountBaht: 50000, dueDay: 25, direction: 'IN' });
    return (await call<{
      totalSatang: number;
      perMonthSatang: number;
      reserveSatang: number;
      incomeSatang: number;
      highestMonth: number;
      lowestMonth: number;
      months: Array<{ month: number; dueSatang: number }>;
    }>(`/expense-plan?year=${year}`)).body;
  }

  it('11. the year adds up, month by month, highest and lowest', async () => {
    const plan = await specExample(2027);
    const due = (m: number) => plan.months[m - 1]?.dueSatang;
    expect(due(1)).toBe(2_400_000 + 150_000);
    expect(due(3)).toBe(6_000_000 + 150_000);
    expect(due(6)).toBe(3_600_000 + 150_000);
    expect(due(9)).toBe(6_000_000 + 150_000);
    expect(due(2)).toBe(150_000);
    expect(plan.totalSatang).toBe(2_400_000 + 12_000_000 + 3_600_000 + 150_000 * 12);
    expect(plan.perMonthSatang).toBe(Math.round(plan.totalSatang / 12));
    expect(plan.incomeSatang).toBe(5_000_000 * 12);
    expect([3, 9]).toContain(plan.highestMonth);
    expect(plan.lowestMonth).toBe(2);
  });

  it('12. the monthly reserve is a twelfth of each lumpy bill’s year: 2,000 + 10,000 + 3,000', async () => {
    const plan = await specExample(2027);
    expect(plan.reserveSatang).toBe(200_000 + 1_000_000 + 300_000);

    const { body } = await call<{ items: Array<{ name: string; perMonthSatang: number }>; totals: { monthlyRequiredSatang: number } }>('/funds');
    expect(Object.fromEntries(body.items.map((f) => [f.name, f.perMonthSatang]))).toEqual({
      ประกันรถ: 200_000,
      ค่าเทอม: 1_000_000,
      ประกันสุขภาพ: 300_000,
    });
    expect(body.totals.monthlyRequiredSatang).toBe(1_500_000);
  });

  it('19. a different year counts its own months', async () => {
    await specExample(2027);
    const { body } = await call<{ totalSatang: number; year: number }>('/expense-plan?year=2028');
    expect(body.year).toBe(2028);
    // Same bills, same total — laid out in 2028's own calendar.
    expect(body.totalSatang).toBe(2_400_000 + 12_000_000 + 3_600_000 + 150_000 * 12);
  });

  it('18. "the 31st" lands on the last day of February, leap year or not', async () => {
    await addBill({ name: 'ค่างวดรถ', amountBaht: 9000, dueDay: 31 });
    const days = async (year: number) =>
      (await call<{ months: Array<{ items: Array<{ day: number }> }> }>(`/expense-plan?year=${year}`)).body.months[1]?.items[0]?.day;
    expect(await days(2027)).toBe(28);
    expect(await days(2028)).toBe(29);
  });

  it('carries next year’s tuition at its new amount', async () => {
    await addBill({
      name: 'ค่าเทอม',
      amountBaht: 60000,
      dueDay: 5,
      everyMonths: 12,
      dueMonth: 5,
      amountChanges: [{ effectiveFrom: '2028-05-01', amountBaht: 65000 }],
    });
    const total = async (year: number) => (await call<{ totalSatang: number }>(`/expense-plan?year=${year}`)).body.totalSatang;
    expect(await total(2027)).toBe(6_000_000);
    expect(await total(2028)).toBe(6_500_000);
  });

  it('10. the dashboard answers this month, next month, the year ahead and what is left', async () => {
    await specExample(2027);
    const { body } = await call<{
      finance: {
        monthlyIncomeSatang: number;
        monthlyReserveSatang: number;
        monthlyRunningSatang: number;
        monthlyLeftSatang: number;
        next12MonthsSatang: number;
        months: unknown[];
        fundTotals: { monthlyRequiredSatang: number };
        alerts: unknown[];
      };
    }>('/dashboard');
    const f = body.finance;
    expect(f.months).toHaveLength(12);
    expect(f.monthlyIncomeSatang).toBe(5_000_000);
    expect(f.monthlyRunningSatang).toBe(150_000);
    expect(f.monthlyReserveSatang).toBe(1_500_000);
    expect(f.monthlyLeftSatang).toBe(5_000_000 - 150_000 - 1_500_000);
    // Twelve months from now hold every bill's year exactly once.
    expect(f.next12MonthsSatang).toBe(2_400_000 + 12_000_000 + 3_600_000 + 150_000 * 12);
    expect(f.fundTotals.monthlyRequiredSatang).toBe(1_500_000);
  });

  it('a month under the board: income, spending, the reserve, and what is left', async () => {
    await addBill({ name: 'เงินเดือน', amountBaht: 150000, dueDay: 25, direction: 'IN' });
    await addBill({ name: 'ค่าบ้าน', amountBaht: 20000, dueDay: 5 });
    const yearly = now().plus({ months: 4 });
    await addBill({ name: 'ประกันรถ', amountBaht: 24000, dueDay: 15, everyMonths: 12, dueMonth: yearly.month });

    const { body } = await call<{
      incomeSatang: number;
      expenseSatang: number;
      reserveSatang: number;
      leftSatang: number;
    }>(`/money/month?month=${now().toFormat('yyyy-MM')}`);
    expect(body.incomeSatang).toBe(15_000_000);
    expect(body.expenseSatang).toBe(2_000_000);
    expect(body.reserveSatang).toBe(200_000);
    expect(body.leftSatang).toBe(15_000_000 - 2_000_000 - 200_000);
  });

  it('warns about what is coming, and a pot falling behind', async () => {
    const soon = now().plus({ days: 7 }).startOf('day');
    await addBill({ name: 'พ.ร.บ.', amountBaht: 650, frequency: 'ONCE', startsOn: iso(soon) });
    const renewal = now().plus({ months: 1 }).set({ day: 20 });
    await addBill({ name: 'ประกันรถ', amountBaht: 24000, dueDay: 20, everyMonths: 12, dueMonth: renewal.month });

    const { body } = await call<{ finance: { alerts: Array<{ text: string }> } }>('/dashboard');
    const texts = body.finance.alerts.map((a) => a.text);
    expect(texts.some((t) => t.includes('อีก 7 วัน พ.ร.บ.'))).toBe(true);
    expect(texts.some((t) => t.startsWith('เดือนหน้ามีค่าใช้จ่าย'))).toBe(true);
    expect(texts.some((t) => t.startsWith('กองประกันรถยังขาด'))).toBe(true);
  });
});

describe('what was there before', () => {
  it('13–14. appointments keep working, and the calendar keeps its shape', async () => {
    const created = await post('/events', { title: 'หาหมอฟัน', startAt: `${iso(now().plus({ days: 2 }))}T10:00`, allDay: false });
    expect(created.status).toBe(201);
    await addBill({ name: 'ค่าส่วนกลาง', amountBaht: 1500, dueDay: 1 });

    const start = now().startOf('month');
    const { body } = await call<{ items: Array<{ title: string }>; holidays: unknown[]; money: unknown[] }>(
      `/events?from=${iso(start)}T00:00:00&to=${iso(start.plus({ days: 44 }))}T23:59:59`,
    );
    expect(body.items.map((i) => i.title)).toContain('หาหมอฟัน');
    expect(Array.isArray(body.holidays)).toBe(true);
    // Money never becomes an Event row: the appointments table holds appointments.
    expect(await db.prisma.event.count()).toBe(1);
  });

  it('15–16. what was saved is there on the next request, from the database', async () => {
    const id = await addBill({ name: 'ค่ารถรับส่ง', amountBaht: 2000, dueDay: 3, categoryName: 'เดินทาง' });
    const fresh = await call<{ items: Array<{ id: string; category: string; amountSatang: number }> }>('/bills');
    expect(fresh.body.items.find((b) => b.id === id)).toMatchObject({ category: 'เดินทาง', amountSatang: 200_000 });
    expect(await db.prisma.bill.count({ where: { id } })).toBe(1);
  });

  it('17. reading the calendar writes nothing', async () => {
    await addBill({ name: 'ค่าส่วนกลาง', amountBaht: 1500, dueDay: 1 });
    const before = {
      events: await db.prisma.event.count(),
      tx: await db.prisma.transaction.count(),
      bills: await db.prisma.bill.count(),
    };
    for (let i = 0; i < 3; i++) await monthMoney(now());
    expect({
      events: await db.prisma.event.count(),
      tx: await db.prisma.transaction.count(),
      bills: await db.prisma.bill.count(),
    }).toEqual(before);
  });
});

describe('20. amounts that are not amounts', () => {
  it.each([
    ['zero', 0],
    ['negative', -500],
    ['not a number', 'สองพัน'],
  ])('refuses %s', async (_label, amountBaht) => {
    const res = await post('/bills', { name: 'ทดสอบ', amountBaht, dueDay: 1 });
    expect(res.status).toBe(400);
    expect(await db.prisma.bill.count()).toBe(0);
  });

  it('accepts no amount at all, and says the plan is short by it', async () => {
    await addBill({ name: 'ค่าซ่อมบ้าน', dueDay: 10 });
    const plan = (await call<{ missingAmount: string[]; totalSatang: number }>(`/expense-plan?year=${now().year}`)).body;
    expect(plan.missingAmount).toEqual(['ค่าซ่อมบ้าน']);
    expect(plan.totalSatang).toBe(0);
  });

  it('refuses a pot entry of zero, and a negative payment', async () => {
    const id = await addBill({ name: 'ประกันรถ', amountBaht: 24000, dueDay: 15, everyMonths: 12, dueMonth: 1 });
    expect((await post(`/funds/${id}/entries`, { amountBaht: 0 })).status).toBe(400);
    expect((await post(`/bills/${id}/pay`, { amountBaht: -1 })).status).toBe(400);
  });

  it('refuses a one-off without a date, and an end before the start', async () => {
    expect((await post('/bills', { name: 'ค่าซ่อมรถ', amountBaht: 100, frequency: 'ONCE' })).status).toBe(400);
    expect(
      (await post('/bills', { name: 'ผ่อน', amountBaht: 100, dueDay: 1, startsOn: '2027-01-01', endsOn: '2026-01-01' })).status,
    ).toBe(400);
  });
});

describe('what comes out of a pot', () => {
  it('a one-off already due is paid from the month, not from a pot it never had', async () => {
    const lastWeek = now().minus({ days: 7 }).startOf('day');
    const month = lastWeek.toFormat('yyyy-MM');
    await addBill({ name: 'ค่าซ่อมรถ', amountBaht: 8500, frequency: 'ONCE', startsOn: iso(lastWeek) });
    const { body } = await call<{ expenseSatang: number; lumpySatang: number }>(`/money/month?month=${month}`);
    expect(body.expenseSatang).toBe(850_000);
    expect(body.lumpySatang).toBe(0);
  });

  it('a premium is paid from its pot in the month it falls', async () => {
    const due = now().plus({ months: 2 });
    await addBill({ name: 'ประกันรถ', amountBaht: 24000, dueDay: 15, everyMonths: 12, dueMonth: due.month });
    const { body } = await call<{ lumpySatang: number }>(`/money/month?month=${due.toFormat('yyyy-MM')}`);
    expect(body.lumpySatang).toBe(2_400_000);
  });
});
