import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { messagingApi } from '@line/bot-sdk';
import { DateTime } from 'luxon';
import { createTestDb, type TestDb } from './harness.js';
import { createApp } from '../../src/line/app.js';
import { DraftStore } from '../../src/line/drafts.js';
import { ExportLinkStore } from '../../src/api/exportLinks.js';
import type { IntentParser, ParseResult } from '../../src/intent/types.js';

/**
 * The copy of itself the family can keep. The database is one free Supabase
 * project; this file is the only thing standing between a bad day there and
 * every appointment, bill and record they ever entered.
 */

const ZONE = 'Asia/Bangkok';
const NOW = DateTime.fromISO('2026-09-12T10:00', { zone: ZONE });
const TOKEN = 'fake-id-token';
const LINE_USER_ID = 'U_backup';

let db: TestDb;
let familyId: string;
let links: ExportLinkStore;

const neverParser: IntentParser = {
  name: 'never',
  parse: async (): Promise<ParseResult> => ({ kind: 'unknown' }),
};

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.reset();
  const family = await db.prisma.family.create({ data: { lineGroupId: 'G_backup', timezone: ZONE } });
  familyId = family.id;
  const mother = await db.prisma.member.create({
    data: { familyId, lineUserId: LINE_USER_ID, displayName: 'แม่', bloodType: 'O' },
  });
  await db.prisma.event.create({
    data: { familyId, title: 'พาแม่ไปหาหมอ', startAt: NOW.plus({ days: 3 }).toJSDate(), category: 'MEDICAL' },
  });
  await db.prisma.bill.create({ data: { familyId, name: 'ค่าไฟ', dueDay: 5, amount: 80000 } });
  await db.prisma.medication.create({
    data: { memberId: mother.id, name: 'ยาความดัน', times: ['08:00'] },
  });
  links = new ExportLinkStore();
});

function app() {
  return createApp({
    prisma: db.prisma,
    api: {} as unknown as messagingApi.MessagingApiClient,
    parser: neverParser,
    drafts: new DraftStore(),
    defaultTimezone: ZONE,
    channelSecret: 'secret',
    liffApi: {
      prisma: db.prisma,
      defaultTimezone: ZONE,
      exportLinks: links,
      publicBaseUrl: 'https://bot.example.com',
      verifyToken: async (t) => (t === TOKEN ? { lineUserId: LINE_USER_ID } : null),
    },
  });
}

const authed = (path: string, init: RequestInit = {}) =>
  app().request(path, { ...init, headers: { 'x-liff-id-token': TOKEN, ...init.headers } });

describe('downloading the family backup', () => {
  it('hands out a link the browser can open, then the file itself', async () => {
    const linkRes = await authed('/api/export/link', { method: 'POST' });
    expect(linkRes.status).toBe(200);
    const { url, expiresInMinutes } = (await linkRes.json()) as {
      url: string;
      expiresInMinutes: number;
    };
    expect(url.startsWith('https://bot.example.com/export/')).toBe(true);
    expect(expiresInMinutes).toBe(10);

    const fileRes = await app().request(new URL(url).pathname);
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get('content-disposition')).toContain('attachment; filename=');

    const data = (await fileRes.json()) as Record<string, Array<Record<string, unknown>>>;
    expect(data.events?.[0]).toMatchObject({ title: 'พาแม่ไปหาหมอ' });
    expect(data.bills?.[0]).toMatchObject({ name: 'ค่าไฟ', amountSatang: 80000 });
    expect(data.medications?.[0]).toMatchObject({ name: 'ยาความดัน', owner: 'แม่' });
    expect(data.members?.[0]).toMatchObject({ displayName: 'แม่', bloodType: 'O' });
  });

  it('leaves LINE user ids out of a file that will sit in someone\'s downloads', async () => {
    const linkRes = await authed('/api/export/link', { method: 'POST' });
    const { url } = (await linkRes.json()) as { url: string };
    const body = await (await app().request(new URL(url).pathname)).text();

    expect(body).not.toContain(LINE_USER_ID);
    expect(body).toContain('แม่');
  });

  it('refuses a token nobody was given', async () => {
    const res = await app().request('/export/not-a-real-token');
    expect(res.status).toBe(404);
  });

  it('needs a member to ask for the link in the first place', async () => {
    const res = await app().request('/api/export/link', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('the setup checklist', () => {
  it('ticks what the house has and leaves the rest', async () => {
    const res = await authed('/api/setup');
    const { items, doneCount } = (await res.json()) as {
      items: Array<{ key: string; done: boolean; count: number }>;
      doneCount: number;
    };
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));

    expect(byKey.bills?.done).toBe(true);
    expect(byKey.medications?.done).toBe(true);
    expect(byKey.emergency?.done).toBe(true); // blood type is filled in
    expect(byKey.documents?.done).toBe(false);
    expect(byKey.chores?.done).toBe(false);
    expect(byKey.birthdays?.done).toBe(false);
    expect(doneCount).toBe(3);
  });

  it('counts an emergency card as done on any one field', async () => {
    await db.prisma.member.updateMany({ where: { familyId }, data: { bloodType: null } });
    const before = (await (await authed('/api/setup')).json()) as {
      items: Array<{ key: string; done: boolean }>;
    };
    expect(before.items.find((i) => i.key === 'emergency')?.done).toBe(false);

    const patch = await authed('/api/me/emergency', {
      method: 'PATCH',
      body: JSON.stringify({ allergies: 'เพนิซิลลิน' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(patch.status).toBe(200);

    const after = (await (await authed('/api/setup')).json()) as {
      items: Array<{ key: string; done: boolean }>;
    };
    expect(after.items.find((i) => i.key === 'emergency')?.done).toBe(true);
  });

  it('writes only the caller\'s own emergency card', async () => {
    const other = await db.prisma.member.create({
      data: { familyId, lineUserId: 'U_other', displayName: 'พ่อ' },
    });

    await authed('/api/me/emergency', {
      method: 'PATCH',
      body: JSON.stringify({ bloodType: 'AB' }),
      headers: { 'content-type': 'application/json' },
    });

    const father = await db.prisma.member.findUniqueOrThrow({ where: { id: other.id } });
    expect(father.bloodType).toBeNull();
    const mother = await db.prisma.member.findFirstOrThrow({ where: { lineUserId: LINE_USER_ID } });
    expect(mother.bloodType).toBe('AB');
  });
});
