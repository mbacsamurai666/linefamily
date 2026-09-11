import { DateTime } from 'luxon';
import OpenAI from 'openai';
import { z } from 'zod';
import type { EventCategory } from './categories.js';
import type { Draft, FamilyContext, IntentParser, ParseResult } from './types.js';

/**
 * Fallback parser. Only ever reached when RuleIntentParser could not read the
 * message, so the call volume — and the bill — is a fraction of message volume.
 *
 * Two rules hold this to the plan:
 *  - it returns a Draft, never a database write; the confirm card is mandatory
 *  - any malformed or unexpected response degrades to `unknown` rather than
 *    throwing, so an API outage or a quota trip cannot take the bot down
 */

const EVENT_CATEGORIES = ['MEDICAL', 'SCHOOL', 'GOVERNMENT', 'SOCIAL', 'WORK', 'OTHER'] as const;

const responseSchema = z.object({
  kind: z.enum(['event', 'expense', 'shopping', 'none']),
  confidence: z.number().min(0).max(1),
  event: z
    .object({
      title: z.string().min(1),
      // Local wall-clock time; the zone comes from the family, not the model.
      start_local: z.string(),
      all_day: z.boolean(),
      category: z.enum(EVENT_CATEGORIES),
      location: z.string().nullable(),
    })
    .nullable(),
  expense: z
    .object({
      amount_baht: z.number().positive(),
      direction: z.enum(['IN', 'OUT']),
      category_name: z.string().nullable(),
      note: z.string().nullable(),
    })
    .nullable(),
  shopping: z.object({ items: z.array(z.string().min(1)).min(1) }).nullable(),
});

/** JSON Schema mirror of the zod shape above, for structured outputs. */
const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'confidence', 'event', 'expense', 'shopping'],
  properties: {
    kind: { type: 'string', enum: ['event', 'expense', 'shopping', 'none'] },
    confidence: { type: 'number' },
    event: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['title', 'start_local', 'all_day', 'category', 'location'],
      properties: {
        title: { type: 'string' },
        start_local: { type: 'string', description: 'YYYY-MM-DDTHH:mm, local time' },
        all_day: { type: 'boolean' },
        category: { type: 'string', enum: EVENT_CATEGORIES },
        location: { type: ['string', 'null'] },
      },
    },
    expense: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['amount_baht', 'direction', 'category_name', 'note'],
      properties: {
        amount_baht: { type: 'number' },
        direction: { type: 'string', enum: ['IN', 'OUT'] },
        category_name: { type: ['string', 'null'] },
        note: { type: ['string', 'null'] },
      },
    },
    shopping: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['items'],
      properties: { items: { type: 'array', items: { type: 'string' } } },
    },
  },
} as const;

function systemPrompt(ctx: FamilyContext): string {
  return [
    'คุณคือตัวแยกความหมายข้อความภาษาไทยของบอทจัดการเรื่องครอบครัวในกลุ่ม LINE',
    'อ่านข้อความหนึ่งข้อความ แล้วตอบเป็น JSON ตาม schema เท่านั้น',
    '',
    'กติกา:',
    '- ถ้าข้อความไม่ใช่การนัดหมาย ค่าใช้จ่าย หรือรายการซื้อของ ให้ตอบ kind = "none"',
    '- start_local ต้องเป็นเวลาท้องถิ่นรูปแบบ YYYY-MM-DDTHH:mm เท่านั้น ห้ามใส่ timezone',
    '- ถ้าระบุแต่วันไม่ระบุเวลา ให้ all_day = true และใช้เวลา 00:00',
    '- ปี พ.ศ. ให้แปลงเป็น ค.ศ. (ลบ 543)',
    '- amount_baht เป็นจำนวนบาท ไม่ใช่สตางค์',
    '- ห้ามเดาข้อมูลที่ไม่มีในข้อความ ถ้าไม่แน่ใจให้ลด confidence ลง',
    '',
    `เวลาปัจจุบัน: ${ctx.now.toFormat("yyyy-MM-dd'T'HH:mm")} (${ctx.timezone})`,
    ctx.memberNames.length > 0 ? `สมาชิกในบ้าน: ${ctx.memberNames.join(', ')}` : '',
    ctx.categoryNames.length > 0
      ? `หมวดค่าใช้จ่ายที่มีอยู่ (ใช้ชื่อเดิมถ้าตรง): ${ctx.categoryNames.join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export interface OpenAiParserOptions {
  client: OpenAI;
  model: string;
  /** Fails closed: on timeout the chain just gets `unknown`. */
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

export class OpenAiIntentParser implements IntentParser {
  readonly name = 'llm';

  constructor(private readonly options: OpenAiParserOptions) {}

  async parse(text: string, ctx: FamilyContext): Promise<ParseResult> {
    try {
      const completion = await this.options.client.chat.completions.create(
        {
          model: this.options.model,
          messages: [
            { role: 'system', content: systemPrompt(ctx) },
            { role: 'user', content: text },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'family_intent', strict: true, schema: jsonSchema },
          },
        },
        { timeout: this.options.timeoutMs ?? 8000 },
      );

      const raw = completion.choices[0]?.message.content;
      if (!raw) return { kind: 'unknown' };

      const parsed = responseSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return { kind: 'unknown' };

      return toParseResult(parsed.data, ctx);
    } catch (err) {
      this.options.onError?.(err);
      return { kind: 'unknown' };
    }
  }
}

function toParseResult(
  data: z.infer<typeof responseSchema>,
  ctx: FamilyContext,
): ParseResult {
  const confidence = data.confidence;

  if (data.kind === 'event' && data.event) {
    const start = DateTime.fromISO(data.event.start_local, { zone: ctx.timezone });
    if (!start.isValid) return { kind: 'unknown' };

    const draft: Draft = {
      kind: 'event',
      title: data.event.title,
      startAt: start,
      allDay: data.event.all_day,
      category: data.event.category as EventCategory,
      ...(data.event.location ? { location: data.event.location } : {}),
    };
    return { kind: 'event', confidence, draft, source: 'llm' };
  }

  if (data.kind === 'expense' && data.expense) {
    const draft: Draft = {
      kind: 'expense',
      amount: Math.round(data.expense.amount_baht * 100),
      direction: data.expense.direction,
      ...(data.expense.category_name ? { categoryName: data.expense.category_name } : {}),
      ...(data.expense.note ? { note: data.expense.note } : {}),
      occurredAt: ctx.now,
    };
    return { kind: 'expense', confidence, draft, source: 'llm' };
  }

  if (data.kind === 'shopping' && data.shopping) {
    return {
      kind: 'shopping',
      confidence,
      draft: { kind: 'shopping', items: data.shopping.items.map((name) => ({ name })) },
      source: 'llm',
    };
  }

  return { kind: 'unknown' };
}
