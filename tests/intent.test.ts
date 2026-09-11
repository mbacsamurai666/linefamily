import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { RuleIntentParser } from '../src/intent/RuleIntentParser.js';
import { ChainedIntentParser } from '../src/intent/ChainedIntentParser.js';
import type { FamilyContext, IntentParser, ParseResult } from '../src/intent/types.js';
import { NOW_ISO } from './fixtures/thai-datetime.fixtures.js';

const ctx: FamilyContext = {
  familyId: 'fam_test',
  timezone: 'Asia/Bangkok',
  now: DateTime.fromISO(NOW_ISO, { zone: 'Asia/Bangkok' }),
  memberNames: ['แม่', 'พ่อ', 'พี่เอ'],
  categoryNames: ['อาหาร', 'ไฟ', 'น้ำ'],
};

const rule = new RuleIntentParser();

describe('RuleIntentParser — expenses', () => {
  it('reads the common "ค่าX N" shorthand', async () => {
    const r = await rule.parse('ค่าข้าว 250', ctx);
    expect(r.kind).toBe('expense');
    if (r.kind !== 'expense') return;
    expect(r.draft).toMatchObject({ amount: 25000, direction: 'OUT', categoryName: 'ข้าว' });
    expect(r.source).toBe('rule');
  });

  it('keeps money in satang, including decimals', async () => {
    const r = await rule.parse('ค่ากาแฟ 62.50 บาท', ctx);
    expect(r.kind === 'expense' && r.draft.kind === 'expense' && r.draft.amount).toBe(6250);
  });

  it('handles thousands separators', async () => {
    const r = await rule.parse('จ่ายค่าไฟ 1,250 บาท', ctx);
    expect(r.kind === 'expense' && r.draft.kind === 'expense' && r.draft.amount).toBe(125000);
  });

  it('reads spelled-out amounts', async () => {
    const r = await rule.parse('ค่าแท็กซี่ ห้าร้อย บาท', ctx);
    expect(r.kind === 'expense' && r.draft.kind === 'expense' && r.draft.amount).toBe(50000);
  });

  it('detects income rather than defaulting to spend', async () => {
    const r = await rule.parse('เงินเดือน 30000', ctx);
    expect(r.kind === 'expense' && r.draft.kind === 'expense' && r.draft.direction).toBe('IN');
  });

  it('accepts a date alongside the amount', async () => {
    const r = await rule.parse('เมื่อวานค่าข้าว 250', ctx);
    expect(r.kind).toBe('expense');
    if (r.kind !== 'expense' || r.draft.kind !== 'expense') return;
    expect(r.draft.occurredAt.toFormat('yyyy-MM-dd')).toBe('2026-09-03');
  });

  it('parses a split with one other member', async () => {
    const r = await rule.parse('ค่าข้าว 300 หารกับ พี่เอ', ctx);
    expect(r.kind).toBe('expense');
    if (r.kind !== 'expense' || r.draft.kind !== 'expense') return;
    expect(r.draft.amount).toBe(30000);
    expect(r.draft.splitWithNames).toEqual(['พี่เอ']);
    expect(r.draft.categoryName).toBe('ข้าว');
  });

  it('parses a split with several members, without the split phrase leaking into the note', async () => {
    const r = await rule.parse('ค่าอาหาร 900 หารกับ แม่ พ่อ พี่เอ', ctx);
    expect(r.kind).toBe('expense');
    if (r.kind !== 'expense' || r.draft.kind !== 'expense') return;
    expect(r.draft.splitWithNames).toEqual(['แม่', 'พ่อ', 'พี่เอ']);
    expect(r.draft.note).not.toContain('หารกับ');
  });

  it('has no split field at all when nobody is named', async () => {
    const r = await rule.parse('ค่าข้าว 250', ctx);
    if (r.kind !== 'expense' || r.draft.kind !== 'expense') throw new Error('expected expense');
    expect(r.draft.splitWithNames).toBeUndefined();
  });
});

describe('RuleIntentParser — appointments', () => {
  it('is confident when the date is stated explicitly', async () => {
    const r = await rule.parse('พรุ่งนี้บ่าย 3 พาแม่ไปหาหมอศิริราช', ctx);
    if (r.kind !== 'event') throw new Error('expected event');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('drops confidence below the escalation threshold when only a bare time matched — no date word at all', async () => {
    const r = await rule.parse('บ่าย 3 พาแม่ไปหาหมอ', ctx);
    expect(r.kind).toBe('event');
    if (r.kind !== 'event') return;
    expect(r.confidence).toBeLessThan(0.7);
  });

  it('drops confidence the same way when a date word is misspelled and silently fails to match', async () => {
    // "พรุ้งนี้" (wrong tone mark) is not "พรุ่งนี้" — the date word never
    // matches, so this must degrade exactly like the no-date-at-all case
    // rather than confidently landing on today's occurrence of 15:00.
    const r = await rule.parse('พรุ้งนี้บ่าย 3 พาแม่ไปหาหมอ', ctx);
    expect(r.kind).toBe('event');
    if (r.kind !== 'event' || r.draft.kind !== 'event') return;
    expect(r.confidence).toBeLessThan(0.7);
    // And the silent failure mode itself: the typo reads as "today", not
    // tomorrow, which is exactly why this case needs the LLM's help.
    expect(r.draft.startAt.toFormat('yyyy-MM-dd')).toBe('2026-09-04');
  });

  it('stays confident for an explicit weekday name even with no other date word', async () => {
    const r = await rule.parse('วันจันทร์บ่าย 3 พาแม่ไปหาหมอ', ctx);
    expect(r.kind).toBe('event');
    if (r.kind !== 'event') return;
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('parses a natural appointment and categorises it', async () => {
    const r = await rule.parse('พรุ่งนี้บ่าย 3 พาแม่ไปหาหมอศิริราช', ctx);
    expect(r.kind).toBe('event');
    if (r.kind !== 'event' || r.draft.kind !== 'event') return;
    expect(r.draft.startAt.toFormat("yyyy-MM-dd'T'HH:mm")).toBe('2026-09-05T15:00');
    expect(r.draft.category).toBe('MEDICAL');
    expect(r.draft.allDay).toBe(false);
  });

  it('treats a dated payment as an expense, not an appointment', async () => {
    const r = await rule.parse('พรุ่งนี้จ่ายค่าไฟ 800', ctx);
    expect(r.kind).toBe('expense');
  });

  it('does not invent an appointment from a bare date', async () => {
    expect((await rule.parse('พรุ่งนี้', ctx)).kind).toBe('unknown');
  });

  it('attributes the event to a named family member (leading-name form)', async () => {
    const r = await rule.parse('พี่เอ สอบปลายภาค พรุ่งนี้ 9 โมงเช้า', ctx);
    expect(r.kind).toBe('event');
    if (r.kind !== 'event' || r.draft.kind !== 'event') return;
    expect(r.draft.attendeeName).toBe('พี่เอ');
    expect(r.draft.title).toBe('สอบปลายภาค');
    expect(r.draft.category).toBe('SCHOOL');
  });

  it('attributes the event to a named family member (ของ-marker form)', async () => {
    const r = await rule.parse('ประชุมผู้ปกครองของพี่เอ พรุ่งนี้บ่าย 2', ctx);
    expect(r.kind).toBe('event');
    if (r.kind !== 'event' || r.draft.kind !== 'event') return;
    expect(r.draft.attendeeName).toBe('พี่เอ');
    expect(r.draft.title).toBe('ประชุมผู้ปกครอง');
  });

  it('has no attendee field at all when nobody is named', async () => {
    const r = await rule.parse('พรุ่งนี้บ่าย 3 พาแม่ไปหาหมอศิริราช', ctx);
    if (r.kind !== 'event' || r.draft.kind !== 'event') throw new Error('expected event');
    expect(r.draft.attendeeName).toBeUndefined();
  });

  it('does not mistake an ordinary word for a name that only happens to be glued to one', async () => {
    // "พ่อแม่" is one compound word here, not the member "พ่อ" followed by
    // something else — the required trailing space must not be satisfied.
    const r = await rule.parse('พ่อแม่ไปงานแต่งพรุ่งนี้บ่าย 3', ctx);
    expect(r.kind).toBe('event');
    if (r.kind !== 'event' || r.draft.kind !== 'event') return;
    expect(r.draft.attendeeName).toBeUndefined();
  });
});

describe('RuleIntentParser — bills', () => {
  it('parses a recurring bill with an amount', async () => {
    const r = await rule.parse('ตั้งบิล ค่าไฟ 800 ทุกวันที่ 5', ctx);
    expect(r.kind).toBe('bill');
    if (r.kind !== 'bill' || r.draft.kind !== 'bill') return;
    expect(r.draft).toEqual({ kind: 'bill', name: 'ค่าไฟ', amount: 80000, dueDay: 5 });
    expect(r.source).toBe('rule');
  });

  it('allows a bill with no fixed amount', async () => {
    const r = await rule.parse('ตั้งบิล ค่าเน็ต ทุกวันที่ 15', ctx);
    expect(r.kind).toBe('bill');
    if (r.kind !== 'bill' || r.draft.kind !== 'bill') return;
    expect(r.draft.amount).toBeUndefined();
    expect(r.draft.dueDay).toBe(15);
    expect(r.draft.name).toBe('ค่าเน็ต');
  });

  it('requires the ตั้งบิล trigger, so an ordinary payment is not read as a bill', async () => {
    expect((await rule.parse('จ่ายค่าไฟ 800', ctx)).kind).toBe('expense');
  });

  it('without a due day, falls back to recording it as a plain expense rather than losing it', async () => {
    // "ตั้งบิล" alone is not a recognised trigger without "ทุกวันที่ N" — the
    // money marker "ค่า" still fires, so the amount is saved either way.
    const r = await rule.parse('ตั้งบิล ค่าไฟ 800', ctx);
    expect(r.kind).toBe('expense');
  });
});

describe('RuleIntentParser — documents', () => {
  it('parses an expiring document and guesses its type', async () => {
    const r = await rule.parse('ใบขับขี่ หมดอายุ 15 มี.ค. 70', ctx);
    expect(r.kind).toBe('document');
    if (r.kind !== 'document' || r.draft.kind !== 'document') return;
    expect(r.draft.type).toBe('DRIVER_LICENSE');
    expect(r.draft.name).toContain('ใบขับขี่');
    expect(r.draft.expiresAt.toFormat('yyyy-MM-dd')).toBe('2027-03-15');
  });

  it('falls back to OTHER when the wording gives no hint of the type', async () => {
    const r = await rule.parse('สัญญาเช่าบ้าน หมดอายุ 1 ม.ค.', ctx);
    expect(r.kind).toBe('document');
    if (r.kind !== 'document' || r.draft.kind !== 'document') return;
    expect(r.draft.type).toBe('OTHER');
  });

  it('does not match without an expiry date', async () => {
    expect((await rule.parse('ใบขับขี่หมดอายุแล้ว งงเลย', ctx)).kind).toBe('unknown');
  });

  it('does not misread it as an appointment on that date', async () => {
    const r = await rule.parse('ประกันรถ หมดอายุ 20 ธ.ค.', ctx);
    expect(r.kind).toBe('document');
  });
});

describe('RuleIntentParser — medication', () => {
  it('parses a schedule with two doses', async () => {
    const r = await rule.parse('ตั้งยา ยาความดัน เวลา 08:00, 20:00', ctx);
    expect(r.kind).toBe('med');
    if (r.kind !== 'med' || r.draft.kind !== 'med') return;
    expect(r.draft).toEqual({ kind: 'med', name: 'ยาความดัน', times: ['08:00', '20:00'] });
  });

  it('captures an explicit dosage', async () => {
    const r = await rule.parse('ตั้งยา ยาความดัน ขนาด 1 เม็ด เวลา 08:00', ctx);
    expect(r.kind).toBe('med');
    if (r.kind !== 'med' || r.draft.kind !== 'med') return;
    expect(r.draft.name).toBe('ยาความดัน');
    expect(r.draft.dosage).toBe('1 เม็ด');
    expect(r.draft.times).toEqual(['08:00']);
  });

  it('requires the เวลา marker, or it is not a medication schedule', async () => {
    expect((await rule.parse('ตั้งยา ยาความดัน', ctx)).kind).toBe('unknown');
  });

  it('does not misread the dose time as a same-day appointment', async () => {
    const r = await rule.parse('ตั้งยา ยาแก้แพ้ เวลา 09:00', ctx);
    expect(r.kind).toBe('med');
  });
});

describe('RuleIntentParser — chores', () => {
  it('parses a daily rotation', async () => {
    const r = await rule.parse('ตั้งเวร ล้างจาน ทุกวัน หมุนกับ แม่ พ่อ พี่เอ', ctx);
    expect(r.kind).toBe('chore');
    if (r.kind !== 'chore' || r.draft.kind !== 'chore') return;
    expect(r.draft).toEqual({
      kind: 'chore',
      name: 'ล้างจาน',
      cadence: 'DAILY',
      rotationNames: ['แม่', 'พ่อ', 'พี่เอ'],
    });
  });

  it('recognises weekly and monthly cadences', async () => {
    const weekly = await rule.parse('ตั้งเวร ทิ้งขยะ ทุกสัปดาห์ หมุนกับ พ่อ แม่', ctx);
    expect(weekly.kind === 'chore' && weekly.draft.kind === 'chore' && weekly.draft.cadence).toBe(
      'WEEKLY',
    );

    const monthly = await rule.parse('ตั้งเวร จ่ายค่าส่วนกลาง ทุกเดือน', ctx);
    expect(
      monthly.kind === 'chore' && monthly.draft.kind === 'chore' && monthly.draft.cadence,
    ).toBe('MONTHLY');
  });

  it('allows a chore with no rotation list', async () => {
    const r = await rule.parse('ตั้งเวร รดน้ำต้นไม้ ทุกวัน', ctx);
    expect(r.kind).toBe('chore');
    if (r.kind !== 'chore' || r.draft.kind !== 'chore') return;
    expect(r.draft.rotationNames).toEqual([]);
  });

  it('requires a cadence word, or it is not a recognised chore', async () => {
    expect((await rule.parse('ตั้งเวร ล้างจาน หมุนกับ แม่ พ่อ', ctx)).kind).toBe('unknown');
  });

  it('does not confuse ทุกวันที่ N (a bill due day) with ทุกวัน (daily)', async () => {
    // Sanity check that the two trigger phrases stay on separate parsers.
    const bill = await rule.parse('ตั้งบิล ค่าไฟ ทุกวันที่ 5', ctx);
    expect(bill.kind).toBe('bill');
  });
});

describe('RuleIntentParser — shopping', () => {
  it('splits an explicit shopping list', async () => {
    const r = await rule.parse('ซื้อของ: นม, ไข่, ขนมปัง', ctx);
    expect(r.kind).toBe('shopping');
    if (r.kind !== 'shopping' || r.draft.kind !== 'shopping') return;
    expect(r.draft.items).toEqual([{ name: 'นม' }, { name: 'ไข่' }, { name: 'ขนมปัง' }]);
  });
});

describe('RuleIntentParser — board tasks', () => {
  it('parses a bare task', async () => {
    const r = await rule.parse('เพิ่มงาน โทรหาช่างแอร์', ctx);
    expect(r.kind).toBe('task');
    if (r.kind !== 'task' || r.draft.kind !== 'task') return;
    expect(r.draft).toEqual({ kind: 'task', title: 'โทรหาช่างแอร์' });
  });

  it('picks up a due date and who it is for', async () => {
    const r = await rule.parse('เพิ่มงาน ส่งเอกสาร พรุ่งนี้ ให้พ่อทำ', ctx);
    expect(r.kind).toBe('task');
    if (r.kind !== 'task' || r.draft.kind !== 'task') return;
    expect(r.draft.title).toBe('ส่งเอกสาร');
    expect(r.draft.assigneeName).toBe('พ่อ');
    expect(r.draft.dueAt?.toFormat('yyyy-MM-dd')).toBe('2026-09-05');
  });

  it('needs something to do, not just the trigger word', async () => {
    expect((await rule.parse('เพิ่มงาน', ctx)).kind).toBe('unknown');
  });

  it('a dated task stays a task rather than becoming an appointment', async () => {
    const r = await rule.parse('เพิ่มงาน จ่ายค่าเทอม ศุกร์นี้', ctx);
    expect(r.kind).toBe('task');
  });
});

describe('RuleIntentParser — loans', () => {
  it('parses a loan with an amount and borrower', async () => {
    const r = await rule.parse('ให้ยืมเงิน พี่เอ 5000', ctx);
    expect(r.kind).toBe('loan');
    if (r.kind !== 'loan' || r.draft.kind !== 'loan') return;
    expect(r.draft).toEqual({ kind: 'loan', borrowerName: 'พี่เอ', principalSatang: 500000 });
  });

  it('captures an optional due date', async () => {
    const r = await rule.parse('ปล่อยกู้ พี่เอ 5000 คืน 5 ต.ค.', ctx);
    expect(r.kind).toBe('loan');
    if (r.kind !== 'loan' || r.draft.kind !== 'loan') return;
    expect(r.draft.borrowerName).toBe('พี่เอ');
    expect(r.draft.dueAt?.toFormat('yyyy-MM-dd')).toBe('2026-10-05');
  });

  it('requires an amount, or it is not a loan', async () => {
    expect((await rule.parse('ให้ยืมเงิน พี่เอ', ctx)).kind).toBe('unknown');
  });
});

describe('RuleIntentParser — assets', () => {
  it('parses a name and value, guessing the category', async () => {
    const r = await rule.parse('เพิ่มทรัพย์สิน บ้านสวน 3000000', ctx);
    expect(r.kind).toBe('asset');
    if (r.kind !== 'asset' || r.draft.kind !== 'asset') return;
    expect(r.draft).toEqual({
      kind: 'asset',
      name: 'บ้านสวน',
      category: 'PROPERTY',
      valueSatang: 300000000,
    });
  });

  it('falls back to OTHER when nothing hints at a category', async () => {
    const r = await rule.parse('เพิ่มทรัพย์สิน ของสะสม 5000', ctx);
    expect(r.kind === 'asset' && r.draft.kind === 'asset' && r.draft.category).toBe('OTHER');
  });

  it('requires a value, or it is not an asset', async () => {
    expect((await rule.parse('เพิ่มทรัพย์สิน บ้านสวน', ctx)).kind).toBe('unknown');
  });
});

describe('RuleIntentParser — deposits', () => {
  it('parses an account name and balance', async () => {
    const r = await rule.parse('เพิ่มบัญชีเงินฝาก ออมทรัพย์ SCB 50000', ctx);
    expect(r.kind).toBe('deposit');
    if (r.kind !== 'deposit' || r.draft.kind !== 'deposit') return;
    expect(r.draft).toEqual({ kind: 'deposit', name: 'ออมทรัพย์ SCB', balanceSatang: 5000000 });
  });

  it('requires a balance, or it is not a deposit', async () => {
    expect((await rule.parse('เพิ่มบัญชีเงินฝาก ออมทรัพย์ SCB', ctx)).kind).toBe('unknown');
  });
});

describe('RuleIntentParser — non-actionable messages', () => {
  it.each(['สวัสดีครับ', 'ขอบคุณมากนะ', 'โอเค เดี๋ยวไปรับ'])('%s -> unknown', async (text) => {
    expect((await rule.parse(text, ctx)).kind).toBe('unknown');
  });
});

/**
 * The cost guarantee from the plan. If these break, the hybrid design has
 * silently become "AI on every message" and the monthly bill moves with it.
 */
describe('ChainedIntentParser — LLM is a fallback, not a default', () => {
  let llmCalls: number;
  let llm: IntentParser;

  beforeEach(() => {
    llmCalls = 0;
    llm = {
      name: 'llm',
      parse: vi.fn(async (): Promise<ParseResult> => {
        llmCalls += 1;
        return { kind: 'unknown' };
      }),
    };
  });

  it('never calls the LLM when the rule parser is confident', async () => {
    const chain = new ChainedIntentParser([rule, llm]);
    for (const text of [
      'ค่าข้าว 250',
      'จ่ายค่าไฟ 1,250 บาท',
      'พรุ่งนี้บ่าย 3 พาแม่ไปหาหมอ',
      'ซื้อของ: นม, ไข่',
      'ตั้งบิล ค่าไฟ 800 ทุกวันที่ 5',
      'ใบขับขี่ หมดอายุ 15 มี.ค. 70',
      'ตั้งยา ยาความดัน เวลา 08:00, 20:00',
      'ตั้งเวร ล้างจาน ทุกวัน หมุนกับ แม่ พ่อ',
      'ให้ยืมเงิน พี่เอ 5000',
      'เพิ่มทรัพย์สิน บ้านสวน 3000000',
      'เพิ่มบัญชีเงินฝาก ออมทรัพย์ SCB 50000',
    ]) {
      await chain.parse(text, ctx);
    }
    expect(llmCalls).toBe(0);
  });

  it('escalates to the LLM only when the rule parser cannot read the message', async () => {
    const chain = new ChainedIntentParser([rule, llm]);
    await chain.parse('เดี๋ยวแวะไปหาคุณยายแป๊บนึงนะ ไม่แน่ใจว่ากี่โมง', ctx);
    expect(llmCalls).toBe(1);
  });

  it('also escalates a misspelled date word instead of confidently saving the wrong day', async () => {
    const chain = new ChainedIntentParser([rule, llm]);
    await chain.parse('พรุ้งนี้บ่าย 3 พาแม่ไปหาหมอ', ctx);
    expect(llmCalls).toBe(1);
  });

  it('prefers the LLM answer when the rule parser is only tentative', async () => {
    const confidentLlm: IntentParser = {
      name: 'llm',
      parse: async (): Promise<ParseResult> => ({
        kind: 'event',
        confidence: 0.95,
        source: 'llm',
        draft: {
          kind: 'event',
          title: 'จากโมเดล',
          startAt: ctx.now,
          allDay: true,
          category: 'OTHER',
        },
      }),
    };
    // Threshold above the rule parser's 0.7 "OTHER category" score.
    const chain = new ChainedIntentParser([rule, confidentLlm], { threshold: 0.8 });
    const r = await chain.parse('พรุ่งนี้ ธุระนิดหน่อย', ctx);
    expect(r.kind !== 'unknown' && r.source).toBe('llm');
  });
});

describe('AI disabled', () => {
  it('handles every rule-parseable message with the LLM removed from the chain', async () => {
    const chain = new ChainedIntentParser([rule]);
    const cases: Array<[string, string]> = [
      ['ค่าข้าว 250', 'expense'],
      ['เงินเดือน 30000', 'expense'],
      ['พรุ่งนี้บ่าย 3 พาแม่ไปหาหมอ', 'event'],
      ['ซื้อของ: นม, ไข่', 'shopping'],
      ['ตั้งบิล ค่าไฟ 800 ทุกวันที่ 5', 'bill'],
      ['ใบขับขี่ หมดอายุ 15 มี.ค. 70', 'document'],
      ['ตั้งยา ยาความดัน เวลา 08:00, 20:00', 'med'],
      ['ตั้งเวร ล้างจาน ทุกวัน หมุนกับ แม่ พ่อ', 'chore'],
      ['ให้ยืมเงิน พี่เอ 5000', 'loan'],
      ['เพิ่มทรัพย์สิน บ้านสวน 3000000', 'asset'],
      ['เพิ่มบัญชีเงินฝาก ออมทรัพย์ SCB 50000', 'deposit'],
    ];
    for (const [text, kind] of cases) {
      expect((await chain.parse(text, ctx)).kind, text).toBe(kind);
    }
  });
});
