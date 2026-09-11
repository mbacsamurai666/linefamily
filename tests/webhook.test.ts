import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/line/app.js';
import { DraftStore } from '../src/line/drafts.js';
import type { IntentParser, ParseResult } from '../src/intent/types.js';

const SECRET = 'test-channel-secret';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

const neverParser: IntentParser = {
  name: 'never',
  parse: async (): Promise<ParseResult> => ({ kind: 'unknown' }),
};

function buildTestApp(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  const drafts = new DraftStore();
  return createApp({
    // The signature gate rejects before any of these are touched, which is
    // what lets the unhappy paths be tested without a database.
    prisma: {} as never,
    api: {} as never,
    parser: neverParser,
    drafts,
    defaultTimezone: 'Asia/Bangkok',
    channelSecret: SECRET,
    pendingDrafts: () => drafts.size,
    processSynchronously: true,
    ...overrides,
  });
}

const BODY = JSON.stringify({
  destination: 'Uxxxx',
  events: [
    {
      type: 'message',
      message: { type: 'text', id: '1', text: 'ค่าข้าว 250' },
      source: { type: 'group', groupId: 'Gtest', userId: 'Utest' },
      replyToken: 'rt',
      timestamp: 0,
      mode: 'active',
    },
  ],
});

describe('POST /line/webhook signature verification', () => {
  it('accepts a correctly signed request', async () => {
    const res = await buildTestApp().request('/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': sign(BODY), 'content-type': 'application/json' },
      body: BODY,
    });
    expect(res.status).toBe(200);
  });

  it('rejects a request signed with the wrong secret', async () => {
    const res = await buildTestApp().request('/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': sign(BODY, 'wrong-secret') },
      body: BODY,
    });
    expect(res.status).toBe(401);
  });

  it('rejects a request with no signature header at all', async () => {
    const res = await buildTestApp().request('/line/webhook', {
      method: 'POST',
      body: BODY,
    });
    expect(res.status).toBe(401);
  });

  it('rejects a body that was tampered with after signing', async () => {
    const signature = sign(BODY);
    const tampered = BODY.replace('250', '9999');
    const res = await buildTestApp().request('/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': signature },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });

  it('does not touch the parser when the signature fails', async () => {
    const parse = vi.fn(async (): Promise<ParseResult> => ({ kind: 'unknown' }));
    const res = await buildTestApp({ parser: { name: 'spy', parse } }).request('/line/webhook', {
      method: 'POST',
      headers: { 'x-line-signature': sign(BODY, 'wrong-secret') },
      body: BODY,
    });
    expect(res.status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
  });
});

describe('GET /health', () => {
  it('reports ok', async () => {
    const res = await buildTestApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, drafts: 0 });
  });
});

describe('DraftStore', () => {
  it('is single use, so a double tap cannot create two rows', () => {
    const store = new DraftStore();
    const token = store.put({
      draft: { kind: 'shopping', items: [{ name: 'นม' }] },
      familyId: 'f1',
      memberId: null,
      source: 'rule',
      confidence: 0.9,
    });

    expect(store.take(token)).not.toBeNull();
    expect(store.take(token)).toBeNull();
  });
});
