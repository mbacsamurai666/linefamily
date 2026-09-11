import { parseThaiDateTime, stripMatched } from '../thai/date.js';
import { normalizeThaiDigits, parseAmountToSatang } from '../thai/number.js';
import { matchRecurrence } from '../thai/recurrence.js';
import { guessAssetCategory } from './assetTypes.js';
import type { EventCategory } from './categories.js';
import { guessEventCategory } from './categories.js';
import { guessDocumentType } from './documentTypes.js';
import type { FamilyContext, IntentParser, ParseResult } from './types.js';

/**
 * Free, deterministic first pass. Handles the shorthand people settle into
 * after a week of using the bot ("ค่าข้าว 250", "พรุ่งนี้บ่าย 3 หาหมอ").
 *
 * Anything it cannot read confidently returns `unknown`, which is the signal
 * for the chain to spend a token on the LLM. Keeping this parser good is what
 * keeps the monthly bill near zero.
 */

/** Words that mark a message as being about money at all. */
const MONEY_MARKERS =
  /ค่า|จ่าย|ซื้อ|โอน|บาท|เงินเดือน|โบนัส|รายรับ|รายจ่าย|ได้เงิน|รับเงิน|ขาย/;

/** Money coming in rather than going out. */
const INCOME_MARKERS = /เงินเดือน|โบนัส|ได้เงิน|รับเงิน|รายรับ|ขาย|คืนเงิน|ได้คืน/;

const SPLIT_MARKER = /หารกับ\s*(.+)$/;

const SHOPPING_PREFIX = /^(?:ซื้อของ|รายการซื้อของ|เพิ่มรายการ|ฝากซื้อ)\s*[:：]?\s*/;

/** A number token: Arabic with separators, or spelled out in Thai. */
const AMOUNT_TOKEN = /(\d[\d,]*(?:\.\d{1,2})?|[ก-๛]+)\s*บาท|(\d[\d,]*(?:\.\d{1,2})?)/;

const BILL_PREFIX = /^(?:ตั้งบิล|เพิ่มบิล|บิลใหม่|บิลประจำเดือน)\s*[:：]?\s*/;
const DUE_DAY = /ทุก\s?วันที่\s*(\d{1,2})/;

const MED_PREFIX = /^(?:ตั้งยา|เพิ่มยา|ยาใหม่)\s*[:：]?\s*/;
const MED_TIMES = /เวลา\s*(.+)$/;
const MED_DOSAGE = /ขนาด\s*(.+)$/;

const CHORE_PREFIX = /^(?:ตั้งเวร|เพิ่มเวร|เวรใหม่)\s*[:：]?\s*/;
const CHORE_ROTATION = /หมุนกับ\s*(.+)$/;
const CHORE_CADENCE: Array<[RegExp, 'DAILY' | 'WEEKLY' | 'MONTHLY']> = [
  [/ทุกวัน(?!ที่)/, 'DAILY'],
  [/ทุก(?:สัปดาห์|อาทิตย์)/, 'WEEKLY'],
  [/ทุกเดือน/, 'MONTHLY'],
];

const TASK_PREFIX = /^(?:เพิ่มงาน|งานใหม่|ฝากงาน|ต้องทำ)\s*[:：]?\s*/;
const TASK_ASSIGNEE = /ให้\s*([ก-๛a-zA-Z]+)\s*ทำ|มอบให้\s*([ก-๛a-zA-Z]+)/;

const LOAN_PREFIX = /^(?:ให้ยืมเงิน|ปล่อยกู้|ให้กู้)\s*[:：]?\s*/;
const ASSET_PREFIX = /^(?:เพิ่มทรัพย์สิน|ทรัพย์สินใหม่)\s*[:：]?\s*/;
const DEPOSIT_PREFIX = /^(?:เพิ่มบัญชีเงินฝาก|เงินฝากใหม่)\s*[:：]?\s*/;

function matchExpense(text: string, ctx: FamilyContext): ParseResult {
  if (!MONEY_MARKERS.test(text)) return { kind: 'unknown' };

  const m = text.match(AMOUNT_TOKEN);
  if (!m) return { kind: 'unknown' };

  const raw = m[1] ?? m[2];
  if (raw === undefined) return { kind: 'unknown' };

  const amount = parseAmountToSatang(raw);
  if (amount === null || amount <= 0) return { kind: 'unknown' };

  // "ค่าไฟ 800" -> category "ไฟ". This is the single most common shape.
  const categoryMatch = text.match(/ค่า([ก-๛a-zA-Z]+)/);
  const categoryName = categoryMatch?.[1];

  const direction = INCOME_MARKERS.test(text) ? 'IN' : 'OUT';

  // An explicit date is allowed ("เมื่อวานค่าข้าว 250") but is not required.
  const when = parseThaiDateTime(text, ctx.now);
  const occurredAt = when && when.allDay ? when.start : (when?.start ?? ctx.now);

  // "ค่าข้าว 300 หารกับ พี่เอ" -> split the cost with named members.
  const splitMatch = text.match(SPLIT_MARKER);
  const splitWithNames = splitMatch
    ? (splitMatch[1] ?? '')
        .split(/[,，]|\sและ\s|\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  const note = stripMatched(text, [
    m[0],
    ...(when?.matched ?? []),
    ...(splitMatch ? [splitMatch[0]] : []),
  ]).trim();

  return {
    kind: 'expense',
    confidence: categoryName ? 0.9 : 0.75,
    source: 'rule',
    draft: {
      kind: 'expense',
      amount,
      direction,
      ...(categoryName !== undefined ? { categoryName } : {}),
      ...(note.length > 0 ? { note } : {}),
      ...(splitWithNames.length > 0 ? { splitWithNames } : {}),
      occurredAt,
    },
  };
}

/**
 * "ตั้งบิล ค่าไฟ 800 ทุกวันที่ 5" -> a recurring bill.
 *
 * Runs before matchExpense: a bill name is typically "ค่าไฟ" etc. and would
 * otherwise trip the money markers and be recorded as a one-off payment.
 */
function matchBill(text: string): ParseResult {
  const prefix = text.match(BILL_PREFIX);
  if (!prefix) return { kind: 'unknown' };

  const rest = text.slice(prefix[0].length);

  const dueDayMatch = rest.match(DUE_DAY);
  if (!dueDayMatch) return { kind: 'unknown' };
  const dueDay = Number(dueDayMatch[1]);
  if (dueDay < 1 || dueDay > 31) return { kind: 'unknown' };

  // The due-day digits have to be removed before hunting for an amount, or
  // "ทุกวันที่ 15" gets misread as a 15-baht bill.
  const withoutDueDay = rest.replace(dueDayMatch[0], ' ');

  const amountMatch = withoutDueDay.match(AMOUNT_TOKEN);
  const amountRaw = amountMatch ? (amountMatch[1] ?? amountMatch[2]) : undefined;
  const amount = amountRaw !== undefined ? parseAmountToSatang(amountRaw) : null;

  const name = withoutDueDay
    .replace(amountMatch?.[0] ?? '', ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length === 0) return { kind: 'unknown' };

  return {
    kind: 'bill',
    confidence: 0.9,
    source: 'rule',
    draft: {
      kind: 'bill',
      name,
      dueDay,
      ...(amount !== null && amount > 0 ? { amount } : {}),
    },
  };
}

/**
 * "ใบขับขี่ หมดอายุ 15 มี.ค. 70" -> a document with an expiry date.
 *
 * Runs before matchEvent: without this, the same text would be read as an
 * appointment titled "ใบขับขี่ หมดอายุ" on that date, which is not what
 * anyone means by it.
 */
function matchDocument(text: string, ctx: FamilyContext): ParseResult {
  if (!/หมดอายุ/.test(text)) return { kind: 'unknown' };

  const when = parseThaiDateTime(text, ctx.now);
  if (!when) return { kind: 'unknown' };

  const name = stripMatched(text, [...when.matched, 'หมดอายุ']).trim();
  if (name.length === 0) return { kind: 'unknown' };

  const type = guessDocumentType(name);

  return {
    kind: 'document',
    // A recognised document type means the phrasing was unambiguous.
    confidence: type === 'OTHER' ? 0.65 : 0.9,
    source: 'rule',
    draft: { kind: 'document', name, type, expiresAt: when.start },
  };
}

/**
 * "ตั้งยา ยาความดัน ขนาด 1 เม็ด เวลา 08:00, 20:00" -> a daily medication.
 *
 * Runs before matchEvent: "เวลา 08:00" would otherwise read as a clock time
 * with no date, turning the whole message into a same-day appointment.
 */
function matchMed(text: string): ParseResult {
  const prefix = text.match(MED_PREFIX);
  if (!prefix) return { kind: 'unknown' };

  const rest = text.slice(prefix[0].length);
  const timesMatch = rest.match(MED_TIMES);
  if (!timesMatch) return { kind: 'unknown' };

  const times = (timesMatch[1] ?? '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{1,2}:\d{2}$/.test(s));
  if (times.length === 0) return { kind: 'unknown' };

  const beforeTimes = rest.slice(0, timesMatch.index).trim();
  const dosageMatch = beforeTimes.match(MED_DOSAGE);
  const name = (dosageMatch ? beforeTimes.slice(0, dosageMatch.index) : beforeTimes).trim();
  if (name.length === 0) return { kind: 'unknown' };

  const dosage = dosageMatch?.[1]?.trim();

  return {
    kind: 'med',
    confidence: 0.9,
    source: 'rule',
    draft: { kind: 'med', name, times, ...(dosage ? { dosage } : {}) },
  };
}

/**
 * "ตั้งเวร ล้างจาน ทุกวัน หมุนกับ แม่ พ่อ พี่เอ" -> a rotating household chore.
 *
 * A cadence word is required — without one there is no schedule to remind
 * against, so the message is left for the family to type again more clearly
 * rather than guessed at.
 */
function matchChore(text: string): ParseResult {
  const prefix = text.match(CHORE_PREFIX);
  if (!prefix) return { kind: 'unknown' };

  const rest = text.slice(prefix[0].length);

  let cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY' | undefined;
  let cadenceMatch: RegExpMatchArray | null = null;
  for (const [re, value] of CHORE_CADENCE) {
    const m = rest.match(re);
    if (m) {
      cadence = value;
      cadenceMatch = m;
      break;
    }
  }
  if (!cadence || !cadenceMatch) return { kind: 'unknown' };

  const rotationMatch = rest.match(CHORE_ROTATION);
  const rotationNames = rotationMatch
    ? (rotationMatch[1] ?? '')
        .split(/[,，]|\sและ\s|\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  const name = rest
    .replace(cadenceMatch[0], ' ')
    .replace(rotationMatch?.[0] ?? '', ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length === 0) return { kind: 'unknown' };

  return {
    kind: 'chore',
    confidence: 0.9,
    source: 'rule',
    draft: { kind: 'chore', name, cadence, rotationNames },
  };
}

/**
 * "เพิ่มงาน โทรหาช่าง พรุ่งนี้ ให้พ่อทำ" -> a card on the family board.
 *
 * Runs before matchExpense and matchEvent: the trigger word is explicit, and
 * a task that happens to mention a date is still a task, not an appointment.
 */
function matchTask(text: string, ctx: FamilyContext): ParseResult {
  const prefix = text.match(TASK_PREFIX);
  if (!prefix) return { kind: 'unknown' };

  const rest = text.slice(prefix[0].length);
  const when = parseThaiDateTime(rest, ctx.now);

  const assigneeMatch = rest.match(TASK_ASSIGNEE);
  const assigneeName = assigneeMatch?.[1] ?? assigneeMatch?.[2];

  const title = stripMatched(rest, [
    ...(when?.matched ?? []),
    ...(assigneeMatch ? [assigneeMatch[0]] : []),
  ]).trim();
  if (title.length === 0) return { kind: 'unknown' };

  return {
    kind: 'task',
    confidence: 0.9,
    source: 'rule',
    draft: {
      kind: 'task',
      title,
      ...(when ? { dueAt: when.start } : {}),
      ...(assigneeName ? { assigneeName } : {}),
    },
  };
}

/**
 * "ให้ยืมเงิน พี่เอ 5000 คืน 5 ต.ค." -> money lent out, with an optional due
 * date. The due date, when present, is whatever parseThaiDateTime finds in
 * the remainder — same trade-off matchExpense makes for its own optional
 * date, corrected on the confirm card rather than requiring a marker word.
 */
function matchLoan(text: string, ctx: FamilyContext): ParseResult {
  const prefix = text.match(LOAN_PREFIX);
  if (!prefix) return { kind: 'unknown' };

  const rest = text.slice(prefix[0].length);
  const amountMatch = rest.match(AMOUNT_TOKEN);
  if (!amountMatch) return { kind: 'unknown' };

  const raw = amountMatch[1] ?? amountMatch[2];
  if (raw === undefined) return { kind: 'unknown' };
  const principalSatang = parseAmountToSatang(raw);
  if (principalSatang === null || principalSatang <= 0) return { kind: 'unknown' };

  const when = parseThaiDateTime(rest, ctx.now);
  // "คืน" ("return it") commonly leads the due date ("... คืน 5 ต.ค.") but is
  // not part of the borrower's name — drop it whenever a date was actually
  // found, the same way matchDocument drops its own "หมดอายุ" marker word.
  const dueMarker = when ? rest.match(/คืน/)?.[0] : undefined;

  const borrowerName = stripMatched(rest, [
    amountMatch[0],
    ...(when?.matched ?? []),
    ...(dueMarker ? [dueMarker] : []),
  ]).trim();
  if (borrowerName.length === 0) return { kind: 'unknown' };

  return {
    kind: 'loan',
    confidence: 0.9,
    source: 'rule',
    draft: {
      kind: 'loan',
      borrowerName,
      principalSatang,
      ...(when ? { dueAt: when.start } : {}),
    },
  };
}

/** "เพิ่มทรัพย์สิน บ้านสวน 3000000" -> a snapshot of something owned. */
function matchAsset(text: string): ParseResult {
  const prefix = text.match(ASSET_PREFIX);
  if (!prefix) return { kind: 'unknown' };

  const rest = text.slice(prefix[0].length);
  const amountMatch = rest.match(AMOUNT_TOKEN);
  if (!amountMatch) return { kind: 'unknown' };

  const raw = amountMatch[1] ?? amountMatch[2];
  if (raw === undefined) return { kind: 'unknown' };
  const valueSatang = parseAmountToSatang(raw);
  if (valueSatang === null || valueSatang <= 0) return { kind: 'unknown' };

  const name = rest.replace(amountMatch[0], ' ').replace(/\s+/g, ' ').trim();
  if (name.length === 0) return { kind: 'unknown' };

  return {
    kind: 'asset',
    confidence: 0.9,
    source: 'rule',
    draft: { kind: 'asset', name, category: guessAssetCategory(name), valueSatang },
  };
}

/** "เพิ่มบัญชีเงินฝาก ออมทรัพย์ SCB 50000" -> a bank/savings balance snapshot. */
function matchDeposit(text: string): ParseResult {
  const prefix = text.match(DEPOSIT_PREFIX);
  if (!prefix) return { kind: 'unknown' };

  const rest = text.slice(prefix[0].length);
  const amountMatch = rest.match(AMOUNT_TOKEN);
  if (!amountMatch) return { kind: 'unknown' };

  const raw = amountMatch[1] ?? amountMatch[2];
  if (raw === undefined) return { kind: 'unknown' };
  const balanceSatang = parseAmountToSatang(raw);
  if (balanceSatang === null || balanceSatang < 0) return { kind: 'unknown' };

  const name = rest.replace(amountMatch[0], ' ').replace(/\s+/g, ' ').trim();
  if (name.length === 0) return { kind: 'unknown' };

  return {
    kind: 'deposit',
    confidence: 0.9,
    source: 'rule',
    draft: { kind: 'deposit', name, balanceSatang },
  };
}

function matchShopping(text: string): ParseResult {
  const m = text.match(SHOPPING_PREFIX);
  if (!m) return { kind: 'unknown' };

  const items = text
    .slice(m[0].length)
    .split(/[,，\n]|\sและ\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((name) => ({ name }));

  if (items.length === 0) return { kind: 'unknown' };

  return {
    kind: 'shopping',
    confidence: 0.9,
    source: 'rule',
    draft: { kind: 'shopping', items },
  };
}

/**
 * Escapes text for literal use inside a RegExp — same job as the private
 * helper in thai/date.ts, duplicated here because this one is built fresh
 * per-family from ctx.memberNames rather than from a fixed table.
 */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "น้องพร สอบปลายภาค พรุ่งนี้ 9 โมง" or "สอบปลายภาคของน้องพร พรุ่งนี้ 9 โมง"
 * -> whose event this is about.
 *
 * Only ever matches an exact member name from this family, so it cannot
 * mistake an ordinary word for a name — "เอาของไปโรงเรียนพรุ่งนี้" has no
 * family member named "ของไปโรงเรียน" and so is left alone. Two shapes are
 * recognised: an explicit "ของ<name>" marker anywhere, or the name leading
 * the whole message, both being how people actually say this in Thai.
 */
function extractAttendee(
  text: string,
  memberNames: string[],
): { name: string; matched: string } | null {
  if (memberNames.length === 0) return null;

  const alt = [...memberNames]
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegex)
    .join('|');

  const ofMatch = text.match(new RegExp(`ของ\\s*(${alt})`));
  if (ofMatch) return { name: ofMatch[1] as string, matched: ofMatch[0] };

  const leadMatch = text.match(new RegExp(`^(${alt})\\s+`));
  if (leadMatch) return { name: leadMatch[1] as string, matched: leadMatch[0] };

  return null;
}

function matchEvent(text: string, ctx: FamilyContext): ParseResult {
  const when = parseThaiDateTime(text, ctx.now);
  if (!when) return { kind: 'unknown' };

  const attendee = extractAttendee(text, ctx.memberNames);
  const repeat = matchRecurrence(text);

  const title = stripMatched(text, [
    ...when.matched,
    ...(attendee ? [attendee.matched] : []),
    ...(repeat ? [repeat.matched] : []),
  ]);
  // A bare date with no subject is not an appointment worth creating.
  if (title.length < 2) return { kind: 'unknown' };

  const category: EventCategory = guessEventCategory(title);

  // A bare time with no date word actually matching is genuinely ambiguous
  // about which day is meant — including the case where a date word was
  // there but misspelled and silently failed to match (e.g. "พรุ้งนี้").
  // Keeping confidence below the chain's escalation threshold here means
  // the LLM gets a chance to read the sentence as a whole and catch what a
  // literal-match parser cannot, without slowing down every message that
  // already names its date explicitly.
  const confidence = !when.hasExplicitDate
    ? 0.6
    : category === 'OTHER' && !attendee
      ? 0.7
      : 0.85;

  return {
    kind: 'event',
    confidence,
    source: 'rule',
    draft: {
      kind: 'event',
      title,
      startAt: when.start,
      allDay: when.allDay,
      category,
      ...(attendee ? { attendeeName: attendee.name } : {}),
      ...(repeat ? { rrule: repeat.rrule } : {}),
    },
  };
}

export class RuleIntentParser implements IntentParser {
  readonly name = 'rule';

  async parse(input: string, ctx: FamilyContext): Promise<ParseResult> {
    const text = normalizeThaiDigits(input).trim();
    if (text.length === 0) return { kind: 'unknown' };

    // Order matters. Shopping, bill, and document each have an explicit
    // trigger phrase ("ซื้อของ", "ตั้งบิล", "หมดอายุ") so they are checked
    // first and unambiguously claim their text. Money markers beat dates,
    // because "พรุ่งนี้จ่ายค่าไฟ 800" is a payment with a date on it, not an
    // appointment.
    for (const attempt of [
      matchShopping(text),
      matchBill(text),
      matchDocument(text, ctx),
      matchMed(text),
      matchChore(text),
      matchTask(text, ctx),
      matchLoan(text, ctx),
      matchAsset(text),
      matchDeposit(text),
      matchExpense(text, ctx),
      matchEvent(text, ctx),
    ]) {
      if (attempt.kind !== 'unknown') return attempt;
    }
    return { kind: 'unknown' };
  }
}
