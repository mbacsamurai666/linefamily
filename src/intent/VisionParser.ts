import { DateTime } from 'luxon';
import OpenAI from 'openai';
import { z } from 'zod';
import { guessEventCategory } from './categories.js';
import type { Draft, EventDraft, FamilyContext, ParseResult } from './types.js';

/**
 * Reads a bank transfer slip or a shop receipt photo and turns it into an
 * ExpenseDraft — the OCR path from the plan's Phase 2 — or a school notice,
 * appointment card or trip plan into the appointments it lists.
 *
 * Separate from IntentParser: that interface takes text, this one takes image
 * bytes, so it is invoked directly from the image-message branch in
 * webhook.ts rather than joining the ChainedIntentParser. The two safety
 * rules from the text pipeline still apply unchanged: nothing here writes to
 * the database, and a low-confidence or unreadable image degrades to
 * `unknown` — never a guessed number silently saved as someone's spending.
 */

/**
 * One call reads either kind of picture the family sends on purpose: a slip or
 * receipt, or a schedule — a school notice, an appointment card, a trip plan.
 * Everything else is `none`, and the bot stays quiet about it.
 */
const responseSchema = z.object({
  kind: z.enum(['receipt', 'schedule', 'none']),
  amount_baht: z.number().positive().nullable(),
  // Local date only (no time) — a slip's timestamp is not precise enough to
  // be worth more than "which day this happened".
  date_local: z.string().nullable(),
  vendor: z.string().nullable(),
  category_hint: z.string().nullable(),
  events: z.array(
    z.object({
      title: z.string(),
      start_date: z.string(),
      end_date: z.string().nullable(),
      time: z.string().nullable(),
    }),
  ),
  confidence: z.number().min(0).max(1),
});

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'amount_baht', 'date_local', 'vendor', 'category_hint', 'events', 'confidence'],
  properties: {
    kind: {
      type: 'string',
      enum: ['receipt', 'schedule', 'none'],
      description:
        'receipt = สลิปโอนเงิน/ใบเสร็จที่มียอดชัด, schedule = ประกาศ/ตาราง/ใบนัดที่มีวันที่ของกิจกรรม, none = อย่างอื่นทั้งหมด',
    },
    amount_baht: { type: ['number', 'null'], description: 'receipt only: total amount in Thai baht, not satang' },
    date_local: { type: ['string', 'null'], description: 'receipt only: YYYY-MM-DD if a date is visible on the slip' },
    vendor: { type: ['string', 'null'], description: 'receipt only: shop or payee name if visible' },
    category_hint: {
      type: ['string', 'null'],
      description: 'receipt only: a short Thai spending category guess, e.g. อาหาร, ไฟ, น้ำมัน',
    },
    events: {
      type: 'array',
      description: 'schedule only: every dated item, in the order shown; empty otherwise',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'start_date', 'end_date', 'time'],
        properties: {
          title: { type: 'string', description: 'what happens, in Thai as written, short' },
          start_date: { type: 'string', description: 'YYYY-MM-DD (Gregorian)' },
          end_date: {
            type: ['string', 'null'],
            description: 'YYYY-MM-DD last day of a span such as 1-25 ต.ค., else null',
          },
          time: { type: ['string', 'null'], description: 'HH:mm if a time of day is written, else null' },
        },
      },
    },
    confidence: { type: 'number' },
  },
} as const;

function instructions(today: DateTime): string {
  return [
    'คุณอ่านรูปภาพที่ครอบครัวส่งเข้ากลุ่ม LINE แล้วตอบเป็น JSON ตาม schema เท่านั้น',
    `วันนี้คือ ${today.toFormat('yyyy-MM-dd')} (ปี พ.ศ. ${today.year + 543})`,
    '',
    'กติกา:',
    '- สลิปโอนเงินหรือใบเสร็จที่อ่านยอดรวมได้ชัด → kind = receipt',
    '  amount_baht คือยอดรวมสุทธิเป็นหน่วยบาท ไม่ใช่สตางค์ ถ้าไม่มั่นใจยอดให้ลด confidence อย่าเดา',
    '- ประกาศ ตารางกิจกรรม ใบนัด ที่มีวันที่ของกิจกรรม → kind = schedule แล้วใส่ทุกรายการใน events',
    '  ปี พ.ศ. ให้แปลงเป็น ค.ศ. (ลบ 543, "69" คือ 2569 = 2026) ถ้าไม่เขียนปี ให้ใช้ปีที่ใกล้วันนี้ที่สุด',
    '  ช่วงวัน เช่น "14-22 ก.ย." ใส่ start_date และ end_date, วันเดียวให้ end_date = null',
    '  title เขียนสั้นตามที่เห็น เช่น "สอบปลายภาค", "ปิดภาคเรียน" ไม่ต้องใส่วันที่ใน title',
    '- รูปอื่นทั้งหมด (รูปคน อาหาร วิว มีม ฯลฯ) → kind = none, events = []',
    '- field ที่ไม่เกี่ยวกับ kind นั้นให้เป็น null',
  ].join('\n');
}

export interface VisionParserOptions {
  client: OpenAI;
  /** Looks at every photo: fast and cheap, and good enough for a slip's total. */
  model: string;
  /**
   * Re-reads a photo the first look called a schedule. Titles are the whole
   * point of a notice and the fast model misreads Thai ones ("กิจกรรมลูกเสือ"
   * came back as "กิจกรรมมูลนิธิ"); a notice is rare enough to afford the
   * slower, better read. Omit to keep the first reading.
   */
  scheduleModel?: string;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

type PhotoReading = z.infer<typeof responseSchema>;

export class VisionParser {
  readonly name = 'vision';

  constructor(private readonly options: VisionParserOptions) {}

  /** A slip becomes an expense, a notice becomes appointments, anything else `unknown`. */
  async parsePhoto(imageBase64: string, mimeType: string, ctx: FamilyContext): Promise<ParseResult> {
    try {
      const imageUrl = `data:${mimeType};base64,${imageBase64}`;
      let reading = await this.read(this.options.model, imageUrl, ctx, this.options.timeoutMs ?? 15000);
      if (!reading) return { kind: 'unknown' };

      const second = this.options.scheduleModel;
      if (reading.kind === 'schedule' && second && second !== this.options.model) {
        // The better read wins, but a failed one still leaves the first.
        const better = await this.read(second, imageUrl, ctx, 60000).catch((err) => {
          this.options.onError?.(err);
          return null;
        });
        if (better?.kind === 'schedule' && better.events.length > 0) reading = better;
      }

      return toParseResult(reading, ctx);
    } catch (err) {
      this.options.onError?.(err);
      return { kind: 'unknown' };
    }
  }

  private async read(
    model: string,
    imageUrl: string,
    ctx: FamilyContext,
    timeoutMs: number,
  ): Promise<PhotoReading | null> {
    const response = await this.options.client.responses.create(
      {
        model,
        instructions: instructions(ctx.now),
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: imageUrl, detail: 'auto' }],
          },
        ],
        text: {
          format: { type: 'json_schema', name: 'family_photo', schema: jsonSchema },
        },
      },
      { timeout: timeoutMs },
    );

    const raw = response.output_text;
    if (!raw) return null;
    const parsed = responseSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }
}

function toParseResult(data: PhotoReading, ctx: FamilyContext): ParseResult {
  if (data.kind === 'schedule') return toSchedule(data.events, data.confidence, ctx);
  if (data.kind !== 'receipt' || data.amount_baht === null) return { kind: 'unknown' };

  let occurredAt = ctx.now;
  if (data.date_local) {
    const parsedDate = DateTime.fromISO(data.date_local, { zone: ctx.timezone });
    if (parsedDate.isValid) occurredAt = parsedDate;
  }

  const draft: Draft = {
    kind: 'expense',
    amount: Math.round(data.amount_baht * 100),
    direction: 'OUT',
    occurredAt,
    ...(data.category_hint ? { categoryName: data.category_hint } : {}),
    ...(data.vendor ? { note: data.vendor } : {}),
  };

  return { kind: 'expense', confidence: data.confidence, draft, source: 'llm' };
}

/** Most items one card carries — a term calendar, not a year planner. */
const MAX_EVENTS = 15;

/**
 * A notice with dates becomes one card of appointments. Items already over
 * are left out — a notice sent mid-month still lists the start of it — while
 * a span still under way stays in.
 */
export function toSchedule(
  items: Array<{ title: string; start_date: string; end_date: string | null; time: string | null }>,
  confidence: number,
  ctx: FamilyContext,
): ParseResult {
  const today = ctx.now.startOf('day');
  const events: EventDraft[] = [];
  let past = 0;

  for (const item of items) {
    const title = item.title.trim();
    const day = DateTime.fromISO(item.start_date, { zone: ctx.timezone });
    if (!title || !day.isValid) continue;
    const last = item.end_date ? DateTime.fromISO(item.end_date, { zone: ctx.timezone }) : null;
    const end = last?.isValid && last > day ? last : null;
    if ((end ?? day) < today) {
      past += 1;
      continue;
    }

    const time = item.time?.match(/^(\d{1,2}):(\d{2})$/);
    const startAt = time ? day.set({ hour: Number(time[1]), minute: Number(time[2]) }) : day;
    events.push({
      kind: 'event',
      title,
      startAt,
      ...(end ? { endAt: time ? end.set({ hour: startAt.hour, minute: startAt.minute }) : end } : {}),
      allDay: !time,
      category: guessEventCategory(title),
    });
  }

  if (events.length === 0) return { kind: 'unknown' };
  const shown = events.slice(0, MAX_EVENTS);
  if (shown.length === 1 && past === 0) return { kind: 'event', confidence, draft: shown[0]!, source: 'llm' };
  return {
    kind: 'events',
    confidence,
    draft: { kind: 'events', events: shown, skippedPast: past },
    source: 'llm',
  };
}
