import { describe, expect, it } from 'vitest';
import type { messagingApi } from '@line/bot-sdk';
import {
  buildDigestQuickReply,
  buildUrgentQuickReply,
  fitLabel,
  type DigestNames,
} from '../src/line/digestActions.js';
import type { JobKind, ReminderJob } from '../src/reminders/ports.js';

function job(kind: JobKind, refId: string): ReminderJob {
  return {
    id: `${kind}-${refId}`,
    familyId: 'fam',
    kind,
    refId,
    dueAt: new Date(),
    lane: 'DIGEST',
    payload: { text: `${kind} ${refId}` },
  };
}

const names: DigestNames = {
  bills: new Map([['b1', 'ค่าไฟ'], ['b2', 'ค่าน้ำ']]),
  tasks: new Map([['t1', 'โทรหาช่างแอร์']]),
  chores: new Map([['c1', 'ล้างจาน'], ['c2', 'ทิ้งขยะ']]),
};

/** The text a tap would send, in order. */
const texts = (qr: ReturnType<typeof buildDigestQuickReply>) =>
  qr?.items?.map((i) => {
    const action = i.action as messagingApi.Action | undefined;
    if (action?.type === 'message') return (action as messagingApi.MessageAction).text;
    if (action?.type === 'uri') return `uri:${(action as messagingApi.URIAction).uri}`;
    return `?${action?.type}`;
  });

describe('buttons under a digest', () => {
  it('offers exactly the commands the batch calls for, dose first', () => {
    const qr = buildDigestQuickReply(
      [job('EVENT', 'e1'), job('BILL', 'b1'), job('MEDICATION', 'm1'), job('TASK', 't1')],
      names,
    );
    expect(texts(qr)).toEqual(['กินยาแล้ว', 'จ่ายบิลแล้ว ค่าไฟ', 'ปิดงาน โทรหาช่างแอร์']);
  });

  it('sends what a person would have typed — the chat command, not a code', () => {
    const qr = buildDigestQuickReply([job('BILL', 'b1')], names);
    const action = qr?.items?.[0]?.action;
    expect(action).toEqual({ type: 'message', label: '💸 จ่ายแล้ว ค่าไฟ', text: 'จ่ายบิลแล้ว ค่าไฟ' });
  });

  it('marks one chore with the short form, several by name', () => {
    expect(texts(buildDigestQuickReply([job('CHORE', 'c1')], names))).toEqual(['ทำแล้ว']);
    expect(texts(buildDigestQuickReply([job('CHORE', 'c1'), job('CHORE', 'c2')], names))).toEqual([
      'ทำแล้ว ล้างจาน',
      'ทำแล้ว ทิ้งขยะ',
    ]);
  });

  it('offers a bill once however many reminders it produced', () => {
    const qr = buildDigestQuickReply([job('BILL', 'b1'), job('BILL', 'b1')], names);
    expect(texts(qr)).toEqual(['จ่ายบิลแล้ว ค่าไฟ']);
  });

  it('skips a row whose name it does not have rather than sending a broken command', () => {
    const qr = buildDigestQuickReply([job('BILL', 'gone')], names);
    expect(qr).toBeUndefined();
  });

  it('adds the app as the last button when there is an app to open', () => {
    const qr = buildDigestQuickReply([job('MEDICATION', 'm1')], names, 'https://liff.line.me/x');
    expect(texts(qr)).toEqual(['กินยาแล้ว', 'uri:https://liff.line.me/x']);
  });

  it('offers nothing at all for a digest of appointments only', () => {
    expect(buildDigestQuickReply([job('EVENT', 'e1')], names)).toBeUndefined();
  });

  it('never exceeds the thirteen LINE allows, keeping the app button', () => {
    const many: DigestNames = {
      bills: new Map(Array.from({ length: 20 }, (_, i) => [`b${i}`, `บิล ${i}`])),
      tasks: new Map(),
      chores: new Map(),
    };
    const jobs = Array.from({ length: 20 }, (_, i) => job('BILL', `b${i}`));
    const qr = buildDigestQuickReply(jobs, many, 'https://liff.line.me/x');
    expect(qr?.items).toHaveLength(13);
    expect(qr?.items?.[12]?.action?.type).toBe('uri');
  });
});

describe('labels', () => {
  it('fit LINE\'s twenty characters with an ellipsis, not a silent cut', () => {
    expect(fitLabel('💸 จ่ายแล้ว ค่าไฟ')).toBe('💸 จ่ายแล้ว ค่าไฟ');
    const long = fitLabel('✅ โทรหาช่างแอร์เรื่องน้ำหยดห้องนอนใหญ่');
    expect([...long]).toHaveLength(20);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('an escalated dose', () => {
  it('gets the one button that answers it', () => {
    expect(texts(buildUrgentQuickReply(job('MEDICATION', 'm1')))).toEqual(['กินยาแล้ว']);
  });

  it('other urgent reminders get none', () => {
    expect(buildUrgentQuickReply(job('EVENT', 'e1'))).toBeUndefined();
  });
});
