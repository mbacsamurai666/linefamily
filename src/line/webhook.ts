import type { PrismaClient } from '@prisma/client';
import type { messagingApi, WebhookEvent } from '@line/bot-sdk';
import { DateTime } from 'luxon';
import type { FamilyContext, IntentParser } from '../intent/types.js';
import type { VisionParser } from '../intent/VisionParser.js';
import { tryDirectCommand } from '../modules/commands.js';
import { persistDraft } from '../modules/persist.js';
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
}

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
  '',
  'บันทึกผิด แก้ได้:',
  '• "ยกเลิกล่าสุด" — ลบสิ่งที่เพิ่งบันทึกไปล่าสุด',
  '• "ลบนัด <ชื่อ>" / "ลบบิล <ชื่อ>" / "ลบยา <ชื่อ>" / "ลบเวร <ชื่อ>"',
  '• "ลบเอกสาร / ลบเงินกู้ / ลบทรัพย์สิน / ลบเงินฝาก / ลบของ <ชื่อ>"',
  '• แก้ไขรายละเอียด ทำในแอป (แตะรายการแล้วกด "แก้ไข")',
].join('\n');

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
    messages: [{ type: 'text', text: `สวัสดีครับ ผมพร้อมช่วยจัดการเรื่องบ้านแล้ว\n\n${HELP_TEXT}` }],
  });
}

async function handleMemberJoined(
  event: Extract<WebhookEvent, { type: 'memberJoined' }>,
  deps: WebhookDeps,
): Promise<void> {
  const groupId = groupIdOf(event);
  if (!groupId) return;
  const family = await resolveFamily(deps, groupId);

  for (const member of event.joined.members) {
    if (member.type === 'user') {
      await resolveMember(deps, family.id, groupId, member.userId);
    }
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
      messages: [{ type: 'text', text: HELP_TEXT }],
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

  if (result.kind === 'unknown') {
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

  const token = deps.drafts.put({
    draft: result.draft,
    familyId: family.id,
    memberId: member?.id ?? null,
    source: result.source,
    confidence: result.confidence,
  });

  deps.log?.('draft created', { source: result.source, kind: result.kind });

  await deps.api.replyMessage({
    replyToken: event.replyToken,
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
