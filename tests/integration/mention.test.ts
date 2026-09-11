import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { messagingApi, WebhookEvent } from '@line/bot-sdk';
import { createTestDb, type TestDb } from './harness.js';
import { handleEvent } from '../../src/line/webhook.js';
import { DraftStore } from '../../src/line/drafts.js';
import type { IntentParser, ParseResult } from '../../src/intent/types.js';

const GROUP_ID = 'G_mention_test';
const USER_ID = 'U_mention_test';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.reset();
});

const neverParser: IntentParser = {
  name: 'never',
  parse: async (): Promise<ParseResult> => ({ kind: 'unknown' }),
};

function fakeApi() {
  const replyMessage = vi.fn().mockResolvedValue({});
  const api = {
    replyMessage,
    getGroupMemberProfile: vi.fn().mockResolvedValue({ displayName: 'ทดสอบ' }),
  } as unknown as messagingApi.MessagingApiClient;
  return { api, replyMessage };
}

/** `mention` is 'none' | 'bot' (mentions the bot itself) | 'other' (mentions someone else). */
function textEvent(text: string, mention: 'none' | 'bot' | 'other'): WebhookEvent {
  const mentioneeData =
    mention === 'none'
      ? {}
      : {
          mention: {
            mentionees: [{ type: 'user', index: 0, length: 5, isSelf: mention === 'bot' }],
          },
        };

  return {
    type: 'message',
    replyToken: 'rt-1',
    source: { type: 'group', groupId: GROUP_ID, userId: USER_ID },
    timestamp: 0,
    mode: 'active',
    message: { type: 'text', id: 'm1', text, ...mentioneeData },
  } as unknown as WebhookEvent;
}

describe('unrecognised text + @mention', () => {
  it('replies with the clarify card when the bot is directly mentioned', async () => {
    const { api, replyMessage } = fakeApi();
    await handleEvent(textEvent('@บอท เอ่อ... งั้น...', 'bot'), {
      prisma: db.prisma,
      api,
      parser: neverParser,
      drafts: new DraftStore(),
      defaultTimezone: 'Asia/Bangkok',
    });

    expect(replyMessage).toHaveBeenCalledTimes(1);
    const sent = replyMessage.mock.calls[0]?.[0];
    expect(sent?.replyToken).toBe('rt-1');
    expect(sent?.messages[0].altText).toContain('ไม่แน่ใจว่าหมายถึงอะไร');
  });

  it('stays silent on the exact same unrecognised text without a mention', async () => {
    const { api, replyMessage } = fakeApi();
    await handleEvent(textEvent('เอ่อ... งั้น...', 'none'), {
      prisma: db.prisma,
      api,
      parser: neverParser,
      drafts: new DraftStore(),
      defaultTimezone: 'Asia/Bangkok',
    });

    expect(replyMessage).not.toHaveBeenCalled();
  });

  it('does not show the clarify card when the mentioned user is someone else in the group', async () => {
    const { api, replyMessage } = fakeApi();
    await handleEvent(textEvent('@น้องพร มาทานข้าว', 'other'), {
      prisma: db.prisma,
      api,
      parser: neverParser,
      drafts: new DraftStore(),
      defaultTimezone: 'Asia/Bangkok',
    });

    expect(replyMessage).not.toHaveBeenCalled();
  });

  it('still confirms normally when a recognised message happens to mention the bot too', async () => {
    const { api, replyMessage } = fakeApi();
    const workingParser: IntentParser = {
      name: 'rule',
      parse: async (): Promise<ParseResult> => ({
        kind: 'shopping',
        confidence: 0.9,
        source: 'rule',
        draft: { kind: 'shopping', items: [{ name: 'นม' }] },
      }),
    };

    await handleEvent(textEvent('@บอท ซื้อของ: นม', 'bot'), {
      prisma: db.prisma,
      api,
      parser: workingParser,
      drafts: new DraftStore(),
      defaultTimezone: 'Asia/Bangkok',
    });

    expect(replyMessage).toHaveBeenCalledTimes(1);
    const sent = replyMessage.mock.calls[0]?.[0];
    // The confirm card, not the clarify card.
    expect(sent?.messages[0].altText).not.toContain('ไม่แน่ใจว่าหมายถึงอะไร');
  });
});
