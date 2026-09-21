import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type OpenAI from 'openai';
import { VisionParser } from '../src/intent/VisionParser.js';
import type { EventBatchDraft, FamilyContext } from '../src/intent/types.js';
import { buildConfirmCard } from '../src/line/flex/confirm.js';

const ZONE = 'Asia/Bangkok';
const ctx: FamilyContext = {
  familyId: 'f',
  timezone: ZONE,
  now: DateTime.fromISO('2026-09-21T10:00', { zone: ZONE }),
  memberNames: [],
  categoryNames: [],
};

const none = { amount_baht: null, date_local: null, vendor: null, category_hint: null };

/** A client that answers per model, and remembers which models it was asked. */
function fakeClient(byModel: Record<string, unknown>) {
  const asked: string[] = [];
  const client = {
    responses: {
      create: async (req: { model: string }) => {
        asked.push(req.model);
        return { output_text: JSON.stringify(byModel[req.model]) };
      },
    },
  } as unknown as OpenAI;
  return { client, asked };
}

// The school notice from the family's group, as a model would read it.
const notice = (scoutTitle: string) => ({
  kind: 'schedule',
  ...none,
  confidence: 0.9,
  events: [
    { title: 'เริ่มเก็บคะแนนในคาบเรียน', start_date: '2026-09-14', end_date: '2026-09-22', time: null },
    { title: 'สอบปลายภาค', start_date: '2026-09-23', end_date: null, time: null },
    { title: scoutTitle, start_date: '2026-09-28', end_date: null, time: null },
    { title: 'ปิดภาคเรียน', start_date: '2026-10-01', end_date: '2026-10-25', time: null },
    { title: 'รับสมุดพก', start_date: '2026-09-10', end_date: null, time: null },
  ],
});

describe('VisionParser — a notice full of dates', () => {
  it('becomes one card of appointments, spans kept, finished items left out', async () => {
    const { client } = fakeClient({ fast: notice('กิจกรรมลูกเสือ') });
    const result = await new VisionParser({ client, model: 'fast' }).parsePhoto('x', 'image/jpeg', ctx);

    expect(result.kind).toBe('events');
    const draft = (result as { draft: EventBatchDraft }).draft;
    expect(draft.events.map((e) => e.title)).toEqual([
      'เริ่มเก็บคะแนนในคาบเรียน', // still under way today
      'สอบปลายภาค',
      'กิจกรรมลูกเสือ',
      'ปิดภาคเรียน',
    ]);
    expect(draft.skippedPast).toBe(1); // รับสมุดพก, 10 Sep
    expect(draft.events[3]?.endAt?.toISODate()).toBe('2026-10-25');
    expect(draft.events.every((e) => e.allDay)).toBe(true);
    expect(draft.events[1]?.category).toBe('SCHOOL');
  });

  it('re-reads a notice with the better model, and only a notice', async () => {
    const { client, asked } = fakeClient({ fast: notice('กิจกรรมมูลนิธิ'), careful: notice('กิจกรรมลูกเสือ') });
    const parser = new VisionParser({ client, model: 'fast', scheduleModel: 'careful' });

    const result = await parser.parsePhoto('x', 'image/jpeg', ctx);
    expect(asked).toEqual(['fast', 'careful']);
    expect((result as { draft: EventBatchDraft }).draft.events[2]?.title).toBe('กิจกรรมลูกเสือ');
  });

  it('keeps the first reading when the second fails', async () => {
    const { client } = fakeClient({ fast: notice('กิจกรรมลูกเสือ'), careful: { nonsense: true } });
    const result = await new VisionParser({ client, model: 'fast', scheduleModel: 'careful' }).parsePhoto(
      'x',
      'image/jpeg',
      ctx,
    );
    expect(result.kind).toBe('events');
  });

  it('lists every item on the confirm card, and says what it skipped', async () => {
    const { client } = fakeClient({ fast: notice('กิจกรรมลูกเสือ') });
    const result = await new VisionParser({ client, model: 'fast' }).parsePhoto('x', 'image/jpeg', ctx);
    if (result.kind === 'unknown') throw new Error('expected a reading');

    const card = JSON.stringify(
      buildConfirmCard({ draft: result.draft, draftToken: 't', timezone: ZONE, source: 'llm', confidence: 0.9 }),
    );
    expect(card).toContain('ลงปฏิทิน 4 นัด');
    expect(card).toContain('14–22 ก.ย.');
    expect(card).toContain('1–25 ต.ค.');
    expect(card).toContain('ข้าม 1 รายการที่ผ่านไปแล้ว');
  });
});

describe('VisionParser — everything else', () => {
  it('still reads a slip, with one look', async () => {
    const { client, asked } = fakeClient({
      fast: { kind: 'receipt', amount_baht: 350, date_local: '2026-09-20', vendor: 'ร้านข้าว', category_hint: 'อาหาร', events: [], confidence: 0.9 },
    });
    const result = await new VisionParser({ client, model: 'fast', scheduleModel: 'careful' }).parsePhoto(
      'x',
      'image/jpeg',
      ctx,
    );
    expect(result.kind).toBe('expense');
    expect(asked).toEqual(['fast']);
  });

  it('stays quiet about a family photo', async () => {
    const { client } = fakeClient({ fast: { kind: 'none', ...none, events: [], confidence: 0.9 } });
    const result = await new VisionParser({ client, model: 'fast' }).parsePhoto('x', 'image/jpeg', ctx);
    expect(result.kind).toBe('unknown');
  });
});
