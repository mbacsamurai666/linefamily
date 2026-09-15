import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { messagingApi, WebhookEvent } from '@line/bot-sdk';
import { createTestDb, type TestDb } from './harness.js';
import { handleEvent } from '../../src/line/webhook.js';
import { DraftStore } from '../../src/line/drafts.js';
import type { IntentParser, ParseResult } from '../../src/intent/types.js';

/**
 * Everyone arrives the same way: the bot is invited to a group, and the people
 * in it become members without anybody registering anything. This is the path
 * every new relative walks, so it is worth holding still.
 */

const GROUP_ID = 'G_joining';

let db: TestDb;

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
});

function fakeApi(names: Record<string, string> = {}) {
  const replyMessage = vi.fn().mockResolvedValue({});
  const getGroupMemberProfile = vi.fn(async (_group: string, userId: string) => {
    const displayName = names[userId];
    if (!displayName) throw new Error('profile unavailable');
    return { displayName };
  });
  return {
    api: { replyMessage, getGroupMemberProfile } as unknown as messagingApi.MessagingApiClient,
    replyMessage,
  };
}

function deps(api: messagingApi.MessagingApiClient) {
  return {
    prisma: db.prisma,
    api,
    parser: neverParser,
    drafts: new DraftStore(),
    defaultTimezone: 'Asia/Bangkok',
  };
}

const joinEvent = (): WebhookEvent =>
  ({
    type: 'join',
    replyToken: 'rt-join',
    source: { type: 'group', groupId: GROUP_ID },
    timestamp: 0,
    mode: 'active',
  }) as unknown as WebhookEvent;

const memberJoinedEvent = (userIds: string[]): WebhookEvent =>
  ({
    type: 'memberJoined',
    replyToken: 'rt-member',
    source: { type: 'group', groupId: GROUP_ID },
    timestamp: 0,
    mode: 'active',
    joined: { members: userIds.map((userId) => ({ type: 'user', userId })) },
  }) as unknown as WebhookEvent;

const textEvent = (userId: string, text: string): WebhookEvent =>
  ({
    type: 'message',
    replyToken: 'rt-text',
    source: { type: 'group', groupId: GROUP_ID, userId },
    timestamp: 0,
    mode: 'active',
    message: { type: 'text', id: 'm1', text },
  }) as unknown as WebhookEvent;

describe('a family group getting started', () => {
  it('registers the group itself when the bot is invited, and says hello', async () => {
    const { api, replyMessage } = fakeApi();

    await handleEvent(joinEvent(), deps(api));

    const family = await db.prisma.family.findUniqueOrThrow({ where: { lineGroupId: GROUP_ID } });
    expect(family.timezone).toBe('Asia/Bangkok');
    expect(replyMessage.mock.calls[0]?.[0].messages[0].text).toContain('พร้อมช่วยจัดการเรื่องบ้าน');
  });

  it('takes in everyone who joins after it, under their LINE name', async () => {
    const { api } = fakeApi({ U_dad: 'พ่อ', U_sis: 'น้องพร' });
    await handleEvent(joinEvent(), deps(api));

    await handleEvent(memberJoinedEvent(['U_dad', 'U_sis']), deps(api));

    const members = await db.prisma.member.findMany({ orderBy: { createdAt: 'asc' } });
    expect(members.map((m) => m.displayName)).toEqual(['พ่อ', 'น้องพร']);
  });

  it('still records someone whose profile it cannot read', async () => {
    // No profile unless the person has added the bot as a friend.
    const { api } = fakeApi();
    await handleEvent(joinEvent(), deps(api));

    await handleEvent(memberJoinedEvent(['U_shy']), deps(api));

    const member = await db.prisma.member.findFirstOrThrow();
    expect(member.lineUserId).toBe('U_shy');
    expect(member.displayName).toBe('สมาชิก');
  });

  it('picks up someone who was already in the group the first time they speak', async () => {
    const { api } = fakeApi({ U_quiet: 'ป้า' });
    await handleEvent(joinEvent(), deps(api));
    expect(await db.prisma.member.count()).toBe(0);

    await handleEvent(textEvent('U_quiet', 'สวัสดีจ้า'), deps(api));

    const member = await db.prisma.member.findFirstOrThrow();
    expect(member.displayName).toBe('ป้า');
  });

  it('does not duplicate anyone who joins, leaves and comes back', async () => {
    const { api } = fakeApi({ U_dad: 'พ่อ' });
    await handleEvent(joinEvent(), deps(api));

    await handleEvent(memberJoinedEvent(['U_dad']), deps(api));
    await handleEvent(memberJoinedEvent(['U_dad']), deps(api));
    await handleEvent(textEvent('U_dad', 'ค่าข้าว 250'), deps(api));

    expect(await db.prisma.member.count({ where: { lineUserId: 'U_dad' } })).toBe(1);
  });
});

describe('finding the app', () => {
  const LIFF = 'https://liff.line.me/1234-abcd';
  const withApp = (api: messagingApi.MessagingApiClient) => ({ ...deps(api), liffUrl: LIFF });

  function buttonUri(message: unknown): string | undefined {
    const card = message as messagingApi.FlexMessage;
    const footer = (card.contents as messagingApi.FlexBubble).footer;
    const button = footer?.contents.find((c) => c.type === 'button') as messagingApi.FlexButton | undefined;
    return (button?.action as messagingApi.URIAction | undefined)?.uri;
  }

  it('greets someone new by name, with the app one tap away', async () => {
    const { api, replyMessage } = fakeApi({ U_aunt: 'ป้าแดง' });
    await handleEvent(joinEvent(), withApp(api));
    replyMessage.mockClear();

    await handleEvent(memberJoinedEvent(['U_aunt']), withApp(api));

    const card = replyMessage.mock.calls[0]?.[0].messages[0];
    expect(card.altText).toContain('ยินดีต้อนรับ ป้าแดง');
    expect(buttonUri(card)).toBe(LIFF);
  });

  it('hands over the app when someone asks for it in their own words', async () => {
    const { api, replyMessage } = fakeApi({ U_dad: 'พ่อ' });
    await handleEvent(joinEvent(), withApp(api));

    for (const ask of ['แอป', 'ขอลิงก์แอปหน่อย', 'เปิดแอป', 'ลิ้งแอปครับ', 'link app']) {
      replyMessage.mockClear();
      await handleEvent(textEvent('U_dad', ask), withApp(api));
      expect(buttonUri(replyMessage.mock.calls[0]?.[0].messages[0]), ask).toBe(LIFF);
    }
  });

  it('puts the app under the help text too', async () => {
    const { api, replyMessage } = fakeApi({ U_dad: 'พ่อ' });
    await handleEvent(joinEvent(), withApp(api));
    replyMessage.mockClear();

    await handleEvent(textEvent('U_dad', 'ช่วย'), withApp(api));

    const messages = replyMessage.mock.calls[0]?.[0].messages;
    expect(messages).toHaveLength(2);
    expect(buttonUri(messages[1])).toBe(LIFF);
  });

  it('does not answer ordinary chat that merely mentions an app', async () => {
    const { api, replyMessage } = fakeApi({ U_dad: 'พ่อ' });
    await handleEvent(joinEvent(), withApp(api));
    replyMessage.mockClear();

    await handleEvent(textEvent('U_dad', 'แอปธนาคารล่มอีกแล้ว'), withApp(api));

    expect(replyMessage).not.toHaveBeenCalled();
  });
});
