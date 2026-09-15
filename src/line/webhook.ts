import type { PrismaClient } from '@prisma/client';
import type { messagingApi, WebhookEvent } from '@line/bot-sdk';
import { DateTime } from 'luxon';
import type { CommandRewriter, RewriteContext } from '../intent/commandRewriter.js';
import type { FamilyContext, IntentParser, ParseResult } from '../intent/types.js';
import type { VisionParser } from '../intent/VisionParser.js';
import { classifyCommand, tryDirectCommand } from '../modules/commands.js';
import { persistDraft } from '../modules/persist.js';
import { ASK_FOR_APP, buildAppCard } from './flex/appCard.js';
import { buildClarifyCard } from './flex/clarify.js';
import { buildConfirmCard } from './flex/confirm.js';
import type { DraftStore } from './drafts.js';
import type { PhotoTargetStore } from './photoTargets.js';

/**
 * Webhook event handling.
 *
 * Everything here answers with the reply token, which is free and unmetered.
 * The push budget is spent only by the reminder engine — if a code path in
 * this file ever calls pushMessage, that is a bug.
 */

export interface WebhookDeps {
  prisma: PrismaClient;
  api: messagingApi.MessagingApiClient;
  parser: IntentParser;
  drafts: DraftStore;
  defaultTimezone: string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Needed to download image message content. Omit to leave receipts off. */
  blobApi?: messagingApi.MessagingApiBlobClient;
  /** Omit (or leave AI_MODULES_DISABLED including "receipts") to skip OCR entirely. */
  visionParser?: VisionParser;
  /** Remembers which document an incoming photo belongs to. */
  photoTargets?: PhotoTargetStore;
  /** ChatGPT's translation of plain speech into commands. Omit to run with rules only. */
  rewriter?: CommandRewriter;
  /** The LIFF app's link, handed to people who join or ask. Omit when there is no app. */
  liffUrl?: string;
}

/** A rule-parsed draft at or above this goes straight to its confirm card. */
const RULE_CONFIDENT = 0.7;

/**
 * How sure ChatGPT must be before the bot acts on its reading. A 'read' is
 * answered in the group at once, and answering a remark nobody addressed to
 * the bot is the one mistake here that cannot be taken back — so it needs
 * more. Anything that changes data waits for a tap or a confirm card anyway.
 */
const REWRITE_READ_CONFIDENT = 0.75;
const REWRITE_CHANGE_CONFIDENT = 0.5;

const HELP_TEXT = [
  'พิมพ์ได้เลยแบบนี้',
  '• "พรุ่งนี้บ่าย 3 พาแม่ไปหาหมอ" — สร้างนัด',
  '• "น้องพร สอบปลายภาค พรุ่งนี้ 9 โมง" — นัดของลูก ระบุชื่อได้เลย',
  '• "ทุกวันจันทร์ 9 โมง กายภาพแม่" — นัดที่เกิดซ้ำ',
  '• "ยื่นเอกสาร วันทำการถัดไป" — ข้ามเสาร์-อาทิตย์และวันหยุดให้',
  '• "ค่าข้าว 250" — บันทึกรายจ่าย',
  '• "ซื้อของ: นม, ไข่" — เพิ่มลิสต์ซื้อของ',
  '• "ตั้งบิล ค่าไฟ 800 ทุกวันที่ 5" — บิลประจำเดือน',
  '• "ใบขับขี่ หมดอายุ 15 มี.ค. 70" — เตือนเอกสารหมดอายุ',
  '• "ตั้งยา ยาความดัน เวลา 08:00, 20:00" — เตือนกินยา',
  '• "ตั้งเวร ล้างจาน ทุกวัน หมุนกับ แม่ พ่อ" — งานบ้านหมุนเวียน',
  '• "ค่าข้าว 300 หารกับ พี่เอ" — บันทึกรายจ่ายพร้อมหารกัน',
  '• "เพิ่มงาน โทรหาช่าง พรุ่งนี้ ให้พ่อทำ" — เพิ่มงานลงบอร์ด',
  '• "ให้ยืมเงิน พี่เอ 5000 คืน 5 ต.ค." — บันทึกเงินให้ยืม',
  '• "เพิ่มทรัพย์สิน บ้านสวน 3000000" — บันทึกทรัพย์สิน',
  '• "เพิ่มบัญชีเงินฝาก ออมทรัพย์ SCB 50000" — บันทึกบัญชีเงินฝาก',
  '',
  'ทุกอย่างจะขึ้นการ์ดให้ยืนยันก่อนบันทึกเสมอ',
  '',
  'คำสั่งด่วน (ไม่ต้องยืนยัน):',
  '• "กินยาแล้ว" — บันทึกว่ากินยาแล้ว',
  '• "ทำแล้ว <ชื่องาน>" — เวรนี้ทำแล้ว หมุนไปคนถัดไป',
  '• "ข้อมูลฉุกเฉิน" — ดูกรุ๊ปเลือด/แพ้ยา/โรคประจำตัวทุกคน',
  '• "ตั้งงบ ค่าไฟ 1000 บาท" — ตั้งงบรายเดือน เตือนเมื่อใกล้/เกินงบ',
  '• "วันเกิด น้องพร 5 ม.ค. 60" — เตือนวันเกิดล่วงหน้า 1 วันทุกปี',
  '• "จ่ายบิลแล้ว ค่าไฟ" — ตัดเป็นรายจ่ายและหยุดเตือนรอบนี้',
  '• "บอร์ดงาน" — ดูงานที่ค้างอยู่ทั้งหมด',
  '• "ปิดงาน <ชื่องาน>" — ย้ายงานไปช่องเสร็จแล้ว',
  '• "สรุปหนี้" — ดูว่าใครติดใครอยู่เท่าไหร่เดือนนี้',
  '• "สรุปเงินกู้" / "สรุปทรัพย์สิน" / "สรุปเงินฝาก" — ดูรายการที่บันทึกไว้',
  '• "สรุปฐานะการเงิน" — ภาพรวมเงินให้ยืม + ทรัพย์สิน + เงินฝาก',
  '• "นัดพรุ่งนี้" / "นัดสัปดาห์นี้" — ดูว่ามีนัดอะไรบ้าง',
  '• "แอป" — ขอลิงก์เปิดแอปบ้านเรา',
  '• "ลิสต์ซื้อของ" — ดูของที่ยังต้องซื้อ',
  '• "ข้ามนัด กายภาพ 21 ก.ย." — งดนัดที่เกิดซ้ำเฉพาะวันนั้น',
  '',
  '💬 พิมพ์แบบพูดปกติก็ได้ เช่น "พรุ่งนี้มีนัดอะไรบ้าง", "จ่ายค่าน้ำแล้วนะ",',
  '"งดกายภาพแม่จันทร์หน้า" — บอทจะแปลเป็นคำสั่งให้ ถ้าเป็นการเปลี่ยนข้อมูลจะให้กดยืนยันก่อนเสมอ',
  '',
  'บันทึกผิด แก้ได้:',
  '• "ยกเลิกล่าสุด" — ลบสิ่งที่เพิ่งบันทึกไปล่าสุด',
  '• "ลบนัด <ชื่อ>" / "ลบบิล <ชื่อ>" / "ลบยา <ชื่อ>" / "ลบเวร <ชื่อ>"',
  '• "ลบเอกสาร / ลบเงินกู้ / ลบทรัพย์สิน / ลบเงินฝาก / ลบของ <ชื่อ>"',
  '• แก้ไขรายละเอียด ทำในแอป (แตะรายการแล้วกด "แก้ไข")',
].join('\n');

/** The app card as it appears under help and on request. */
function appCardFor(liffUrl: string): messagingApi.FlexMessage {
  return buildAppCard({
    liffUrl,
    heading: 'แอปบ้านเรา',
    lines: ['ปฏิทินนัดหมาย บอร์ดงาน รายรับ-รายจ่าย ลิสต์ซื้อของ บิล ยา เวรบ้าน — ทุกอย่างของบ้านในที่เดียว'],
  });
}

export async function handleEvent(event: WebhookEvent, deps: WebhookDeps): Promise<void> {
  switch (event.type) {
    case 'join':
      return handleJoin(event, deps);
    case 'memberJoined':
      return handleMemberJoined(event, deps);
    case 'message':
      return handleMessage(event, deps);
    case 'postback':
      return handlePostback(event, deps);
    default:
      return;
  }
}

/** The group id is the family id as far as this bot is concerned. */
function groupIdOf(event: WebhookEvent): string | null {
  const source = event.source;
  if (source.type === 'group') return source.groupId;
  if (source.type === 'room') return source.roomId;
  return null;
}

/** True when this text message @-mentions the bot itself, not just anyone. */
function mentionsBot(message: { mention?: { mentionees: Array<{ type: string; isSelf?: boolean }> } }): boolean {
  return message.mention?.mentionees.some((m) => m.type === 'user' && m.isSelf === true) ?? false;
}

async function resolveFamily(deps: WebhookDeps, lineGroupId: string) {
  return deps.prisma.family.upsert({
    where: { lineGroupId },
    create: { lineGroupId, timezone: deps.defaultTimezone },
    update: {},
  });
}

/**
 * Members register themselves the first time they say anything, so nobody has
 * to run a setup step before the bot is useful.
 */
async function resolveMember(
  deps: WebhookDeps,
  familyId: string,
  lineGroupId: string,
  lineUserId: string | undefined,
): Promise<{ id: string; displayName: string } | null> {
  if (!lineUserId) return null;

  const existing = await deps.prisma.member.findUnique({
    where: { familyId_lineUserId: { familyId, lineUserId } },
    select: { id: true, displayName: true },
  });
  if (existing) return existing;

  let displayName = 'สมาชิก';
  try {
    const profile = await deps.api.getGroupMemberProfile(lineGroupId, lineUserId);
    displayName = profile.displayName;
  } catch {
    // Profile is unavailable when the member has not added the bot as a
    // friend. A placeholder name is better than refusing to record them.
  }

  return deps.prisma.member.create({
    data: { familyId, lineUserId, displayName },
    select: { id: true, displayName: true },
  });
}

async function handleJoin(
  event: Extract<WebhookEvent, { type: 'join' }>,
  deps: WebhookDeps,
): Promise<void> {
  const groupId = groupIdOf(event);
  if (!groupId) return;
  await resolveFamily(deps, groupId);

  await deps.api.replyMessage({
    replyToken: event.replyToken,
    messages: [
      { type: 'text', text: `สวัสดีครับ ผมพร้อมช่วยจัดการเรื่องบ้านแล้ว\n\n${HELP_TEXT}` },
      ...(deps.liffUrl ? [appCardFor(deps.liffUrl)] : []),
    ],
  });
}

async function handleMemberJoined(
  event: Extract<WebhookEvent, { type: 'memberJoined' }>,
  deps: WebhookDeps,
): Promise<void> {
  const groupId = groupIdOf(event);
  if (!groupId) return;
  const family = await resolveFamily(deps, groupId);

  const names: string[] = [];
  for (const member of event.joined.members) {
    if (member.type === 'user') {
      const row = await resolveMember(deps, family.id, groupId, member.userId);
      if (row && row.displayName !== 'สมาชิก') names.push(row.displayName);
    }
  }

  // Someone new has no idea the bot has an app, let alone where its link went.
  // Tell them the moment they arrive — a reply, so it costs nothing.
  if (deps.liffUrl && event.replyToken) {
    await deps.api.replyMessage({
      replyToken: event.replyToken,
      messages: [
        buildAppCard({
          liffUrl: deps.liffUrl,
          heading: names.length > 0 ? `ยินดีต้อนรับ ${names.join(', ')} 👋` : 'ยินดีต้อนรับครับ 👋',
          lines: [
            'กลุ่มนี้มีบอทช่วยจำนัดหมาย บิล ยา เวรบ้าน และรายรับ-รายจ่ายของบ้าน',
            'เปิดแอปเพื่อดูปฏิทินและทุกอย่างของบ้าน หรือพิมพ์คุยกับบอทในกลุ่มได้เลย เช่น "พรุ่งนี้มีนัดอะไรบ้าง"',
            'พิมพ์ "ช่วย" เพื่อดูว่าสั่งอะไรได้บ้าง',
          ],
        }),
      ],
    });
  }
}

async function handleMessage(
  event: Extract<WebhookEvent, { type: 'message' }>,
  deps: WebhookDeps,
): Promise<void> {
  if (event.message.type === 'image') return handleImageMessage(event, deps);
  if (event.message.type !== 'text') return;

  const groupId = groupIdOf(event);
  if (!groupId) return;

  const text = event.message.text.trim();
  const family = await resolveFamily(deps, groupId);
  const member = await resolveMember(deps, family.id, groupId, event.source.userId);

  if (/^(help|ช่วย|วิธีใช้|คำสั่ง)$/i.test(text)) {
    await deps.api.replyMessage({
      replyToken: event.replyToken,
      messages: [
        { type: 'text', text: HELP_TEXT },
        ...(deps.liffUrl ? [appCardFor(deps.liffUrl)] : []),
      ],
    });
    return;
  }

  if (deps.liffUrl && ASK_FOR_APP.test(text)) {
    await deps.api.replyMessage({
      replyToken: event.replyToken,
      messages: [appCardFor(deps.liffUrl)],
    });
    return;
  }

  // Direct commands (กินยาแล้ว, ทำแล้ว, ข้อมูลฉุกเฉิน, ...) bypass the confirm
  // card entirely — they acknowledge something specific and pending rather
  // than create a new, ambiguous record.
  const direct = await tryDirectCommand(text, {
    prisma: deps.prisma,
    familyId: family.id,
    memberId: member?.id ?? null,
    now: DateTime.now().setZone(family.timezone),
  });
  if (direct) {
    await deps.api.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: direct.reply }],
    });
    return;
  }

  const [memberNames, categoryNames] = await Promise.all([
    deps.prisma.member
      .findMany({ where: { familyId: family.id }, select: { displayName: true } })
      .then((rows) => rows.map((r) => r.displayName)),
    deps.prisma.category
      .findMany({ where: { familyId: family.id }, select: { name: true } })
      .then((rows) => rows.map((r) => r.name)),
  ]);

  const ctx: FamilyContext = {
    familyId: family.id,
    timezone: family.timezone,
    now: DateTime.now().setZone(family.timezone),
    memberNames,
    categoryNames,
  };

  const result = await deps.parser.parse(text, ctx);

  if (result.kind !== 'unknown' && result.confidence >= RULE_CONFIDENT) {
    return replyWithDraft(event.replyToken, deps, family, member?.id ?? null, result);
  }

  // The rules could not read it. Ask ChatGPT what was meant — in the bot's
  // own words, so whatever it says is carried out by the same handlers.
  let chatter = false;
  if (deps.rewriter) {
    const cmdCtx = {
      prisma: deps.prisma,
      familyId: family.id,
      memberId: member?.id ?? null,
      now: ctx.now,
    };
    const outcome = await tryRewrite(event.replyToken, text, deps, family, cmdCtx, ctx);
    if (outcome === 'handled') return;
    chatter = outcome === 'chatter';
  }

  if (result.kind === 'unknown' || chatter) {
    // Staying quiet on ordinary chatter is deliberate — a bot that answers
    // every message in a family group gets muted within a day. The one
    // exception is being directly addressed: someone who @-mentioned the bot
    // and got nothing back reads that as broken, not polite, so that case
    // alone gets a card instead of silence.
    if (mentionsBot(event.message)) {
      await deps.api.replyMessage({
        replyToken: event.replyToken,
        messages: [buildClarifyCard()],
      });
    }
    return;
  }

  // A hesitant rule reading, and nothing better from ChatGPT — still worth a
  // card, since the card is where a wrong guess gets corrected.
  return replyWithDraft(event.replyToken, deps, family, member?.id ?? null, result);
}

async function replyWithDraft(
  replyToken: string,
  deps: WebhookDeps,
  family: { id: string; timezone: string },
  memberId: string | null,
  result: Exclude<ParseResult, { kind: 'unknown' }>,
): Promise<void> {
  const token = deps.drafts.put({
    draft: result.draft,
    familyId: family.id,
    memberId,
    source: result.source,
    confidence: result.confidence,
  });

  deps.log?.('draft created', { source: result.source, kind: result.kind });

  await deps.api.replyMessage({
    replyToken,
    messages: [
      buildConfirmCard({
        draft: result.draft,
        draftToken: token,
        timezone: family.timezone,
        source: result.source,
        confidence: result.confidence,
      }),
    ],
  });
}

/**
 * Carry out ChatGPT's reading of a message, by the effect of the command it
 * produced:
 *   read   → answered now, with the command shown so people learn it
 *   act    → shown with a "✅ ยืนยัน" button that sends the command as a
 *            message; the tap is the confirmation, and the command then runs
 *            through tryDirectCommand like anything typed
 *   record → parsed by the rules into a draft, onto the usual confirm card
 * 'chatter' means ChatGPT judged the message was not meant for the bot at all;
 * 'nothing' means there was no usable reading, so the caller carries on.
 */
async function tryRewrite(
  replyToken: string,
  text: string,
  deps: WebhookDeps,
  family: { id: string; timezone: string },
  cmdCtx: Parameters<typeof tryDirectCommand>[1],
  ctx: FamilyContext,
): Promise<'handled' | 'chatter' | 'nothing'> {
  const rewriter = deps.rewriter;
  if (!rewriter) return 'nothing';

  const rewrite = await rewriter.rewrite(text, await rewriteContext(deps.prisma, ctx));
  if (rewrite.kind === 'chatter') return 'chatter';
  if (rewrite.kind === 'unavailable') return 'nothing';

  const { command, confidence } = rewrite;
  const effect = classifyCommand(command);
  // The message itself stays out of the log; what it became is enough to debug.
  deps.log?.('rewritten', { effect: effect ?? 'record', confidence });

  if (effect === 'read') {
    if (confidence < REWRITE_READ_CONFIDENT) return 'nothing';
    const answer = await tryDirectCommand(command, cmdCtx);
    if (!answer) return 'nothing';

    await deps.api.replyMessage({
      replyToken,
      messages: [{ type: 'text', text: `${answer.reply}\n\n💬 ครั้งหน้าพิมพ์ "${command}" ก็ได้ครับ` }],
    });
    return 'handled';
  }

  if (confidence < REWRITE_CHANGE_CONFIDENT) return 'nothing';

  if (effect === 'act') {
    await deps.api.replyMessage({
      replyToken,
      messages: [
        {
          type: 'text',
          text: `จะทำตามนี้นะครับ\n👉 ${command}\n\nถูกต้องกด "✅ ยืนยัน" ด้านล่าง`,
          quickReply: {
            items: [{ type: 'action', action: { type: 'message', label: '✅ ยืนยัน', text: command } }],
          },
        },
      ],
    });
    return 'handled';
  }

  const parsed = await deps.parser.parse(command, ctx);
  if (parsed.kind === 'unknown') return 'nothing';

  await replyWithDraft(replyToken, deps, family, cmdCtx.memberId, {
    ...parsed,
    source: 'llm',
    // The card should look only as sure as the least sure of the two readings.
    confidence: Math.min(parsed.confidence, confidence),
  });
  return 'handled';
}

/** The names ChatGPT may refer to, so it picks "กายภาพแม่" rather than inventing one. */
async function rewriteContext(prisma: PrismaClient, ctx: FamilyContext): Promise<RewriteContext> {
  const [events, bills, tasks, chores] = await Promise.all([
    prisma.event.findMany({
      where: {
        familyId: ctx.familyId,
        OR: [
          { rrule: { not: null } },
          {
            startAt: {
              gte: ctx.now.minus({ days: 1 }).toJSDate(),
              lte: ctx.now.plus({ days: 45 }).toJSDate(),
            },
          },
        ],
      },
      select: { title: true },
      orderBy: { startAt: 'asc' },
      take: 40,
    }),
    prisma.bill.findMany({ where: { familyId: ctx.familyId, active: true }, select: { name: true } }),
    prisma.task.findMany({
      where: { familyId: ctx.familyId, status: { not: 'DONE' } },
      select: { title: true },
    }),
    prisma.chore.findMany({ where: { familyId: ctx.familyId, active: true }, select: { name: true } }),
  ]);

  // Medication names are deliberately not sent: "กินยาแล้ว" works without one,
  // and health details are the last thing that needs to leave the server.
  return {
    now: ctx.now,
    timezone: ctx.timezone,
    memberNames: ctx.memberNames,
    categoryNames: ctx.categoryNames,
    eventTitles: events.map((e) => e.title),
    billNames: bills.map((b) => b.name),
    taskTitles: tasks.map((t) => t.title),
    choreNames: chores.map((c) => c.name),
  };
}

/**
 * A photo in the group — checked against VisionParser as a possible receipt.
 * Silent on anything that is not one: a bot that comments on every family
 * photo is a bot that gets muted, and a slip that fails to read is far more
 * likely to be a birthday-party snapshot than a genuine OCR miss.
 */
async function handleImageMessage(
  event: Extract<WebhookEvent, { type: 'message' }>,
  deps: WebhookDeps,
): Promise<void> {
  if (event.message.type !== 'image') return;

  const groupId = groupIdOf(event);
  if (!groupId) return;

  const family = await resolveFamily(deps, groupId);
  const member = await resolveMember(deps, family.id, groupId, event.source.userId);

  // A photo the bot asked for beats reading it as a receipt: the person was
  // told to send this one, so guessing at it would be perverse.
  const awaiting = member && deps.photoTargets ? deps.photoTargets.take(member.id) : null;
  if (awaiting) {
    await deps.prisma.document.updateMany({
      where: { id: awaiting.documentId, familyId: family.id },
      data: { fileId: event.message.id },
    });

    await deps.api.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `📎 เก็บรูป "${awaiting.documentName}" ไว้ให้แล้วครับ` }],
    });
    return;
  }

  if (!deps.visionParser || !deps.blobApi) return;

  const chunks: Buffer[] = [];
  try {
    const stream = await deps.blobApi.getMessageContent(event.message.id);
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    deps.log?.('failed to download image content', { err: String(err) });
    return;
  }
  if (chunks.length === 0) return;

  const base64 = Buffer.concat(chunks).toString('base64');
  const ctx: FamilyContext = {
    familyId: family.id,
    timezone: family.timezone,
    now: DateTime.now().setZone(family.timezone),
    memberNames: [],
    categoryNames: await deps.prisma.category
      .findMany({ where: { familyId: family.id }, select: { name: true } })
      .then((rows) => rows.map((r) => r.name)),
  };

  // LINE's Messaging API serves photo message content as JPEG.
  const result = await deps.visionParser.parseReceipt(base64, 'image/jpeg', ctx);
  if (result.kind === 'unknown') return;

  // Remember which photo this came from, so the saved expense can point back
  // at the slip it was read out of.
  const draft =
    result.draft.kind === 'expense'
      ? { ...result.draft, receiptFileId: event.message.id }
      : result.draft;

  const token = deps.drafts.put({
    draft,
    familyId: family.id,
    memberId: member?.id ?? null,
    source: result.source,
    confidence: result.confidence,
  });

  deps.log?.('draft created from receipt image', { kind: result.kind });

  await deps.api.replyMessage({
    replyToken: event.replyToken,
    messages: [
      buildConfirmCard({
        draft,
        draftToken: token,
        timezone: family.timezone,
        source: result.source,
        confidence: result.confidence,
      }),
    ],
  });
}

async function handlePostback(
  event: Extract<WebhookEvent, { type: 'postback' }>,
  deps: WebhookDeps,
): Promise<void> {
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');
  const token = params.get('token');

  if (action === 'edit' && token) {
    const pending = deps.drafts.peek(token);
    await deps.api.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: pending
            ? 'พิมพ์ใหม่ได้เลยครับ เดี๋ยวผมสร้างการ์ดให้ใหม่'
            : 'การ์ดนี้หมดอายุแล้ว พิมพ์ใหม่อีกครั้งนะครับ',
        },
      ],
    });
    return;
  }

  if (action !== 'confirm' || !token) return;

  const pending = deps.drafts.take(token);
  if (!pending) {
    await deps.api.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'การ์ดนี้หมดอายุหรือถูกยืนยันไปแล้วครับ' }],
    });
    return;
  }

  const family = await deps.prisma.family.findUnique({
    where: { id: pending.familyId },
    select: { timezone: true },
  });
  const zone = family?.timezone ?? deps.defaultTimezone;

  try {
    const { summary, photoTarget } = await persistDraft(pending.draft, {
      prisma: deps.prisma,
      familyId: pending.familyId,
      memberId: pending.memberId,
      now: DateTime.now().setZone(zone),
    });

    // A document can keep a picture of itself, but an image message carries no
    // caption — so the bot has to ask, then remember what the next photo is for.
    let followUp = '';
    if (photoTarget && pending.memberId && deps.photoTargets) {
      deps.photoTargets.expect(pending.memberId, photoTarget.documentId, photoTarget.documentName);
      followUp = '\n\n📷 ส่งรูปเอกสารมาได้เลยครับ เดี๋ยวเก็บไว้ให้ (ภายใน 15 นาที)';
    }

    await deps.api.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: `✅ ${summary}${followUp}` }],
    });
  } catch (err) {
    deps.log?.('persist failed', { err: String(err) });
    await deps.api.replyMessage({
      replyToken: event.replyToken,
      messages: [{ type: 'text', text: 'บันทึกไม่สำเร็จครับ ลองใหม่อีกครั้งนะ' }],
    });
  }
}
