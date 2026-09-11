import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { messagingApi, WebhookEvent } from '@line/bot-sdk';
import { DateTime } from 'luxon';
import { createTestDb, type TestDb } from './harness.js';
import { handleEvent, type WebhookDeps } from '../../src/line/webhook.js';
import { DraftStore } from '../../src/line/drafts.js';
import { ChainedIntentParser } from '../../src/intent/ChainedIntentParser.js';
import { RuleIntentParser } from '../../src/intent/RuleIntentParser.js';
import type { CommandRewriter, Rewrite } from '../../src/intent/commandRewriter.js';

/**
 * The ChatGPT path end to end, with ChatGPT replaced by a lookup table: what
 * matters here is what the bot does with a translation, not the translation.
 * The webhook runs on the real clock, so fixtures are built around today.
 */

const ZONE = 'Asia/Bangkok';
const GROUP_ID = 'G_rewrite';
const USER_ID = 'U_rewrite';
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const thaiDay = (d: DateTime) => `${d.day} ${MONTHS[d.month - 1]}`;

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
  await db.prisma.member.create({ data: { familyId, lineUserId: USER_ID, displayName: 'แม่' } });
});

function fakeApi() {
  const replyMessage = vi.fn().mockResolvedValue({});
  const api = {
    replyMessage,
    getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: 'แม่' }),
  } as unknown as messagingApi.MessagingApiClient;
  return { api, replyMessage };
}

/** ChatGPT, as a table from what was typed to what it would have said. */
function fakeRewriter(table: Record<string, Rewrite>) {
  const rewrite = vi.fn(async (text: string): Promise<Rewrite> => table[text] ?? { kind: 'unavailable' });
  return { rewriter: { rewrite } satisfies CommandRewriter, rewrite };
}

function say(text: string): WebhookEvent {
  return {
    type: 'message',
    replyToken: 'rt-1',
    source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
    timestamp: 0,
    mode: 'active',
    message: { type: 'text', id: 'm1', text },
  } as unknown as WebhookEvent;
}

function deps(api: messagingApi.MessagingApiClient, rewriter: CommandRewriter, drafts = new DraftStore()): WebhookDeps {
  return {
    prisma: db.prisma,
    api,
    parser: new ChainedIntentParser([new RuleIntentParser()]),
    rewriter,
    drafts,
    defaultTimezone: ZONE,
  };
}

/** The next Monday strictly after today, at 09:00. */
function nextMonday(): DateTime {
  const today = DateTime.now().setZone(ZONE).startOf('day');
  return today.plus({ days: ((8 - today.weekday) % 7) || 7 }).set({ hour: 9 });
}

describe('a question the bot can answer', () => {
  it('answers it, and shows the command for next time', async () => {
    const power = await db.prisma.category.create({ data: { familyId, name: 'ไฟ', kind: 'OUT' } });
    await db.prisma.transaction.create({
      data: { familyId, amount: 123400, direction: 'OUT', categoryId: power.id, occurredAt: new Date() },
    });
    const { api, replyMessage } = fakeApi();
    const { rewriter } = fakeRewriter({
      'เดือนนี้ค่าไฟไปเท่าไหร่แล้ว': { kind: 'command', command: 'ค่าไฟเดือนนี้', confidence: 0.95 },
    });

    await handleEvent(say('เดือนนี้ค่าไฟไปเท่าไหร่แล้ว'), deps(api, rewriter));

    const text = replyMessage.mock.calls[0]?.[0].messages[0].text as string;
    expect(text).toContain('1,234 บาท');
    expect(text).toContain('ครั้งหน้าพิมพ์ "ค่าไฟเดือนนี้"');
  });

  it('stays quiet when ChatGPT is not sure the bot was even being asked', async () => {
    const { api, replyMessage } = fakeApi();
    const { rewriter } = fakeRewriter({
      'เดือนนี้ใช้เงินเยอะจัง': { kind: 'command', command: 'สรุปเดือนนี้', confidence: 0.55 },
    });

    await handleEvent(say('เดือนนี้ใช้เงินเยอะจัง'), deps(api, rewriter));

    expect(replyMessage).not.toHaveBeenCalled();
  });
});

describe('something that changes data', () => {
  it('waits for a tap, and the tap is what carries it out', async () => {
    const monday = nextMonday();
    const series = await db.prisma.event.create({
      data: {
        familyId,
        title: 'กายภาพแม่',
        category: 'MEDICAL',
        startAt: monday.minus({ weeks: 2 }).toJSDate(),
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      },
    });
    const command = `ข้ามนัด กายภาพแม่ ${thaiDay(monday)}`;
    const { api, replyMessage } = fakeApi();
    const { rewriter } = fakeRewriter({ 'งดกายภาพแม่จันทร์หน้านะ': { kind: 'command', command, confidence: 0.9 } });

    await handleEvent(say('งดกายภาพแม่จันทร์หน้านะ'), deps(api, rewriter));

    const offer = replyMessage.mock.calls[0]?.[0].messages[0];
    expect(offer.text).toContain(command);
    expect(offer.quickReply.items[0].action).toEqual({ type: 'message', label: '✅ ยืนยัน', text: command });
    // Nothing has happened yet.
    expect((await db.prisma.event.findUniqueOrThrow({ where: { id: series.id } })).exdates).toEqual([]);

    // The tap sends the command as an ordinary message, which the rules carry out.
    await handleEvent(say(command), deps(api, rewriter));

    expect(replyMessage.mock.calls[1]?.[0].messages[0].text).toContain('ข้าม "กายภาพแม่"');
    expect((await db.prisma.event.findUniqueOrThrow({ where: { id: series.id } })).exdates).toHaveLength(1);
  });

  it('turns a new appointment into the usual confirm card, marked as ChatGPT\'s reading', async () => {
    const saturday = DateTime.now().setZone(ZONE).plus({ days: 3 });
    const drafts = new DraftStore();
    const { api, replyMessage } = fakeApi();
    const { rewriter } = fakeRewriter({
      'จดไว้หน่อยว่าเสาร์นี้บ่ายสองพาแม่ไปหาหมอ': {
        kind: 'command',
        command: `พาแม่ไปหาหมอ ${thaiDay(saturday)} 14:00`,
        confidence: 0.85,
      },
    });

    await handleEvent(say('จดไว้หน่อยว่าเสาร์นี้บ่ายสองพาแม่ไปหาหมอ'), deps(api, rewriter, drafts));

    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(replyMessage.mock.calls[0]?.[0].messages[0].type).toBe('flex');
    expect(drafts.size).toBe(1);
    // Nothing is saved until the card is confirmed.
    expect(await db.prisma.event.count()).toBe(0);
  });
});

describe('what ChatGPT is never trusted with', () => {
  it('is not asked at all when the rules already understood the message', async () => {
    const { api } = fakeApi();
    const { rewriter, rewrite } = fakeRewriter({});

    await handleEvent(say('ค่าข้าว 250'), deps(api, rewriter));
    await handleEvent(say('บอร์ดงาน'), deps(api, rewriter));

    expect(rewrite).not.toHaveBeenCalled();
  });

  it('drops a "command" the bot does not actually have', async () => {
    const { api, replyMessage } = fakeApi();
    const { rewriter } = fakeRewriter({
      'ช่วยจองตั๋วเครื่องบินให้หน่อย': { kind: 'command', command: 'จองตั๋ว เชียงใหม่', confidence: 0.99 },
    });

    await handleEvent(say('ช่วยจองตั๋วเครื่องบินให้หน่อย'), deps(api, rewriter));

    expect(replyMessage).not.toHaveBeenCalled();
  });

  it('leaves ordinary chat alone, even when the rules half-read a date in it', async () => {
    const { api, replyMessage } = fakeApi();
    const { rewriter } = fakeRewriter({ 'วันนี้อากาศดีจัง': { kind: 'chatter' } });

    await handleEvent(say('วันนี้อากาศดีจัง'), deps(api, rewriter));

    expect(replyMessage).not.toHaveBeenCalled();
  });

  it("falls back to the rules' own hesitant card when ChatGPT cannot be reached", async () => {
    const drafts = new DraftStore();
    const { api, replyMessage } = fakeApi();
    const { rewriter } = fakeRewriter({}); // every call "unavailable"

    await handleEvent(say('บ่าย 3 ไปรับน้องพร'), deps(api, rewriter, drafts));

    // Exactly what the bot does with AI switched off: a card to correct.
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(drafts.size).toBe(1);
  });
});
