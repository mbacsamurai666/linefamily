import type { DateTime } from 'luxon';
import type OpenAI from 'openai';
import { z } from 'zod';
import { formatThaiDate } from '../line/format.js';
import { COMMAND_CATALOG } from './commandCatalog.js';

/**
 * ChatGPT as a translator, not an operator.
 *
 * The family talks the way people talk — "งดกายภาพแม่จันทร์หน้านะ",
 * "เดือนนี้ค่าไฟไปเท่าไหร่แล้ว". The model's only job is to rewrite that into
 * one of the bot's own commands (intent/commandCatalog.ts). The rewritten text
 * then goes through exactly the handlers a person typing it would reach, so
 * the model never touches the database and every rule the bot already keeps —
 * who may change what, which names exist, what needs confirming — still holds.
 *
 * Like the rest of the AI path it fails closed: any error, timeout or reply
 * that does not fit the schema is simply "no command", and the bot behaves as
 * it does with AI switched off.
 */

export interface RewriteContext {
  now: DateTime;
  timezone: string;
  memberNames: string[];
  categoryNames: string[];
  /** Appointment titles — repeating ones and the next few weeks'. */
  eventTitles: string[];
  billNames: string[];
  taskTitles: string[];
  choreNames: string[];
}

/**
 * Three answers, because "no command" means two different things. Chatter is
 * ChatGPT having read the message and judged it was not for the bot — worth
 * more than a hesitant rule guess, so the bot stays quiet. Unavailable is not
 * having an answer at all, and the bot carries on as it would with AI off.
 */
export type Rewrite =
  | {
      kind: 'command';
      command: string;
      /** 0..1 — how sure the model is this is what was asked. */
      confidence: number;
    }
  | { kind: 'chatter' }
  | { kind: 'unavailable' };

export interface CommandRewriter {
  rewrite(text: string, ctx: RewriteContext): Promise<Rewrite>;
}

const responseSchema = z.object({
  command: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['command', 'confidence'],
  properties: {
    command: { type: ['string', 'null'] },
    confidence: { type: 'number' },
  },
} as const;

/** LINE's limit on the text a quick-reply button can send. */
const MAX_COMMAND_LENGTH = 300;

/** Long enough to name everything a family has, short enough to stay cheap. */
const MAX_NAMES = 30;

/**
 * The next three weeks, one line per day: "จ. 14 ก.ย. (จันทร์นี้)".
 *
 * Working out which date "จันทร์หน้า" is was where the model spent most of its
 * time — 12 to 15 seconds of reasoning, long enough to time out — and where
 * the faster settings got it wrong. Handing it a calendar to look things up
 * in turns date arithmetic into reading, which is both faster and right.
 */
export function calendarLines(now: DateTime): string {
  const today = now.startOf('day');
  const nextWeekStart = today.plus({ weeks: 1 }).startOf('week');
  const lines: string[] = [];
  for (let i = 0; i < 21; i++) {
    const day = today.plus({ days: i });
    const notes: string[] = [];
    if (i === 0) notes.push('วันนี้');
    if (i === 1) notes.push('พรุ่งนี้');
    if (i === 2) notes.push('มะรืน');
    notes.push(day < nextWeekStart ? 'สัปดาห์นี้' : day < nextWeekStart.plus({ weeks: 1 }) ? 'สัปดาห์หน้า' : 'อีกสองสัปดาห์');
    lines.push(`${formatThaiDate(day)} (${notes.join(', ')})`);
  }
  return lines.join('\n');
}

function list(label: string, names: string[]): string {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, MAX_NAMES);
  return unique.length > 0 ? `${label}: ${unique.join(', ')}` : '';
}

export function systemPrompt(ctx: RewriteContext): string {
  const catalog = COMMAND_CATALOG.map((e) => `${e.example}  — ${e.means}`).join('\n');

  return [
    'คุณคือผู้ช่วยแปลข้อความของบอทจัดการเรื่องครอบครัวในกลุ่ม LINE',
    'หน้าที่เดียวของคุณ: แปลข้อความของคนในบ้าน ให้เป็น "คำสั่งของบอท" หนึ่งคำสั่ง ตามรูปแบบในรายการด้านล่างเท่านั้น',
    '',
    'รายการคำสั่ง (เขียนตามรูปแบบนี้เป๊ะ ๆ เปลี่ยนแค่ชื่อ วัน เวลา จำนวน):',
    catalog,
    '',
    'กติกา:',
    '- ถ้าข้อความเป็นการคุยกันทั่วไป เล่าเรื่อง ทักทาย หรือไม่ได้ขอให้บอททำ/ดูอะไร ให้ command = null',
    '- ห้ามแต่งคำสั่งที่ไม่มีในรายการ ถ้าไม่มีคำสั่งที่ตรง ให้ command = null',
    '- วันที่ต้องเขียนเป็นวันที่จริงเสมอ เช่น "21 ก.ย." ห้ามเขียน "พรุ่งนี้" หรือ "จันทร์หน้า" (ยกเว้นคำสั่ง นัดวันนี้/นัดพรุ่งนี้/นัดสัปดาห์นี้/นัดสัปดาห์หน้า)',
    '- หาวันที่จากปฏิทินด้านล่าง ไม่ต้องคำนวณเอง: "จันทร์หน้า"/"จันทร์นี้" คือวันจันทร์ถัดไปที่ยังมาไม่ถึง, "อีก 5 วัน" คือนับจากวันนี้ไป 5 วัน',
    '- เขียนเฉพาะตัวคำสั่ง ห้ามใส่คำอธิบายหลังขีด (—) ที่อยู่ในรายการ',
    '- ใส่ปี พ.ศ. เฉพาะเมื่อไม่ใช่ปีนี้ เวลาเขียนแบบ 24 ชั่วโมง เช่น 14:00',
    '- ถ้าข้อความพูดถึงชื่อที่มีอยู่แล้วในรายชื่อด้านล่าง ให้ใช้ชื่อนั้นตามที่เขียนไว้',
    '- ห้ามเดาจำนวนเงิน ชื่อคน หรือวันที่ ที่ไม่มีในข้อความ ถ้าขาดข้อมูลสำคัญให้ command = null',
    '- confidence คือความมั่นใจว่าคนพิมพ์ต้องการคำสั่งนี้จริง ๆ (0 ถึง 1)',
    '',
    `วันนี้: ${formatThaiDate(ctx.now)} เวลา ${ctx.now.toFormat('HH:mm')} (${ctx.now.toFormat('yyyy-MM-dd')})`,
    '',
    'ปฏิทิน:',
    calendarLines(ctx.now),
    '',
    list('สมาชิกในบ้าน', ctx.memberNames),
    list('หมวดค่าใช้จ่ายที่มี', ctx.categoryNames),
    list('นัดที่มี', ctx.eventTitles),
    list('บิลที่มี', ctx.billNames),
    list('งานที่ค้าง', ctx.taskTitles),
    list('เวรงานบ้าน', ctx.choreNames),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export interface OpenAiRewriterOptions {
  client: OpenAI;
  model: string;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Measured on twelve real family messages with the calendar in the prompt
 * (gpt-5-mini): default reasoning 11/12 right, median 10s, worst 30s; 'low'
 * 11–12/12, median 6s, worst 8–12s; 'minimal' 6/12. The first production
 * message timed out at the old 8-second limit on default reasoning.
 */
const REASONING_EFFORT = 'low';

/** Only reasoning models take reasoning_effort; anything else rejects it. */
function takesReasoningEffort(model: string): boolean {
  return /^(?:gpt-5|o\d)/.test(model);
}

export class OpenAiCommandRewriter implements CommandRewriter {
  constructor(private readonly options: OpenAiRewriterOptions) {}

  async rewrite(text: string, ctx: RewriteContext): Promise<Rewrite> {
    const unavailable = { kind: 'unavailable' } as const;
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
            json_schema: { name: 'family_command', strict: true, schema: jsonSchema },
          },
          ...(takesReasoningEffort(this.options.model) ? { reasoning_effort: REASONING_EFFORT } : {}),
        },
        {
          timeout: this.options.timeoutMs ?? 20_000,
          // The SDK retries twice by default, so one slow answer became three
          // and the family waited half a minute for silence. One try; if it
          // fails, the bot falls back to its rules.
          maxRetries: 0,
        },
      );

      const raw = completion.choices[0]?.message.content;
      if (!raw) return unavailable;

      const parsed = responseSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return unavailable;

      const command = parsed.data.command?.trim().replace(/\s+/g, ' ');
      if (!command) return { kind: 'chatter' };
      if (command.length > MAX_COMMAND_LENGTH) return unavailable;
      // Echoing the message back is not a translation — the rules already
      // had their chance at exactly this text.
      if (command === text.trim()) return unavailable;

      return { kind: 'command', command, confidence: parsed.data.confidence };
    } catch (err) {
      this.options.onError?.(err);
      return unavailable;
    }
  }
}
