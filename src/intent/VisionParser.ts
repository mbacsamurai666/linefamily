import { DateTime } from 'luxon';
import OpenAI from 'openai';
import { z } from 'zod';
import type { Draft, FamilyContext, ParseResult } from './types.js';

/**
 * Reads a bank transfer slip or a shop receipt photo and turns it into an
 * ExpenseDraft — the OCR path from the plan's Phase 2.
 *
 * Separate from IntentParser: that interface takes text, this one takes image
 * bytes, so it is invoked directly from the image-message branch in
 * webhook.ts rather than joining the ChainedIntentParser. The two safety
 * rules from the text pipeline still apply unchanged: nothing here writes to
 * the database, and a low-confidence or unreadable image degrades to
 * `unknown` — never a guessed number silently saved as someone's spending.
 */

const responseSchema = z.object({
  found: z.boolean(),
  amount_baht: z.number().positive().nullable(),
  // Local date only (no time) — a slip's timestamp is not precise enough to
  // be worth more than "which day this happened".
  date_local: z.string().nullable(),
  vendor: z.string().nullable(),
  category_hint: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'amount_baht', 'date_local', 'vendor', 'category_hint', 'confidence'],
  properties: {
    found: { type: 'boolean', description: 'true only if this is a receipt or transfer slip with a clear total amount' },
    amount_baht: { type: ['number', 'null'], description: 'total amount in Thai baht, not satang' },
    date_local: { type: ['string', 'null'], description: 'YYYY-MM-DD if a date is visible on the slip' },
    vendor: { type: ['string', 'null'], description: 'shop or payee name if visible' },
    category_hint: { type: ['string', 'null'], description: 'a short Thai spending category guess, e.g. อาหาร, ไฟ, น้ำมัน' },
    confidence: { type: 'number' },
  },
} as const;

const INSTRUCTIONS = [
  'คุณอ่านสลิปโอนเงินหรือใบเสร็จภาษาไทยจากรูปภาพ แล้วตอบเป็น JSON ตาม schema เท่านั้น',
  '',
  'กติกา:',
  '- ถ้ารูปไม่ใช่สลิป/ใบเสร็จ หรืออ่านยอดเงินไม่ออกชัดเจน ให้ found = false',
  '- amount_baht คือยอดรวมสุทธิเป็นหน่วยบาท ไม่ใช่สตางค์',
  '- ถ้าไม่มั่นใจยอด ให้ลด confidence ลง อย่าเดายอดที่อ่านไม่ชัด',
  '- date_local ต้องเป็น YYYY-MM-DD เท่านั้น ถ้าไม่เห็นวันที่ให้เป็น null',
].join('\n');

export interface VisionParserOptions {
  client: OpenAI;
  model: string;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

export class VisionParser {
  readonly name = 'vision';

  constructor(private readonly options: VisionParserOptions) {}

  async parseReceipt(
    imageBase64: string,
    mimeType: string,
    ctx: FamilyContext,
  ): Promise<ParseResult> {
    try {
      const response = await this.options.client.responses.create(
        {
          model: this.options.model,
          instructions: INSTRUCTIONS,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_image',
                  image_url: `data:${mimeType};base64,${imageBase64}`,
                  detail: 'auto',
                },
              ],
            },
          ],
          text: {
            format: { type: 'json_schema', name: 'receipt_slip', schema: jsonSchema },
          },
        },
        { timeout: this.options.timeoutMs ?? 15000 },
      );

      const raw = response.output_text;
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

function toParseResult(data: z.infer<typeof responseSchema>, ctx: FamilyContext): ParseResult {
  if (!data.found || data.amount_baht === null) return { kind: 'unknown' };

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
