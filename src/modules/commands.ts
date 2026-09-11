import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { computeNetBalances } from './debts.js';
import { computeNetWorth, listAssets, listDeposits, listLoans } from './loanAssetDeposit.js';
import {
  deleteAsset,
  deleteBill,
  deleteChore,
  deleteDeposit,
  deleteDocument,
  deleteEvent,
  deleteLoan,
  deleteMedication,
  deleteShoppingItem,
  deleteTask,
  deleteTransaction,
  updateTask,
} from './records.js';
import { markChoreDone, markMedicationTaken } from '../reminders/generate.js';
import { ASSET_CATEGORY_LABEL } from '../intent/assetTypes.js';
import { formatThaiDate, formatThaiTime } from '../line/format.js';
import { parseAmountToSatang, formatSatang } from '../thai/number.js';

/**
 * Direct commands — actions that skip the confirm-card pipeline entirely.
 *
 * Everything that goes through IntentParser exists because the interpretation
 * is ambiguous enough to need a human glance before it is saved. These do not:
 * "กินยาแล้ว" acknowledges a specific pending dose, "ทำแล้ว" retires a specific
 * pending chore occurrence — both are idempotent, low-risk, and time-sensitive
 * enough that a confirm tap would defeat the point.
 */

export interface CommandContext {
  prisma: PrismaClient;
  familyId: string;
  memberId: string | null;
  now: DateTime;
}

export interface CommandResult {
  reply: string;
}

const TAKEN_MED = /^(?:กินยาแล้ว|กินแล้ว)(?:\s+(.+))?$/;
const CHORE_DONE = /^ทำแล้ว(?:\s+(.+))?$/;
const EMERGENCY_INFO = /^(?:ข้อมูลฉุกเฉิน|emergency)$/i;
const SET_BLOOD_TYPE = /^กรุ๊ปเลือด(?:ฉัน)?\s+(.+)$/;
const SET_ALLERGIES = /^แพ้ยา\s+(.+)$/;
const SET_CONDITIONS = /^โรคประจำตัว\s+(.+)$/;
const SET_BUDGET = /^ตั้งงบ\s+(.+?)\s+([\d,๐-๙]+(?:\.\d{1,2})?)\s*(?:บาท)?(?:\s*\/\s*เดือน)?$/;
const DEBT_SUMMARY = /^(?:สรุปหนี้|ใครติดใคร|สรุปยอดหักลบ)$/;
const LOAN_SUMMARY = /^สรุปเงินกู้$/;
const ASSET_SUMMARY = /^สรุปทรัพย์สิน$/;
const DEPOSIT_SUMMARY = /^สรุปเงินฝาก$/;
const NET_WORTH_SUMMARY = /^(?:สรุปฐานะการเงิน|ทรัพย์สินสุทธิ)$/;
const UNDO_LAST = /^(?:ยกเลิกล่าสุด|ลบล่าสุด|ยกเลิกรายการล่าสุด)$/;
const DELETE_BY_NAME = /^ลบ(นัด|บิล|เอกสาร|ยา|เวร|เงินกู้|ทรัพย์สิน|เงินฝาก|ของ|งาน)\s+(.+)$/;
const CLOSE_TASK = /^(?:ปิดงาน|งานเสร็จ)\s+(.+)$/;
const TASK_BOARD = /^(?:บอร์ดงาน|งานค้าง|สรุปงาน)$/;

/** Returns null when the text does not match any direct command. */
export async function tryDirectCommand(
  text: string,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  const taken = text.match(TAKEN_MED);
  if (taken) return handleMedTaken(ctx, taken[1]?.trim());

  const done = text.match(CHORE_DONE);
  if (done) return handleChoreDone(ctx, done[1]?.trim());

  if (EMERGENCY_INFO.test(text)) return handleEmergencyInfo(ctx);

  const blood = text.match(SET_BLOOD_TYPE);
  if (blood) return setMemberField(ctx, 'bloodType', blood[1] as string, 'กรุ๊ปเลือด');

  const allergies = text.match(SET_ALLERGIES);
  if (allergies) return setMemberField(ctx, 'allergies', allergies[1] as string, 'ข้อมูลแพ้ยา');

  const conditions = text.match(SET_CONDITIONS);
  if (conditions) return setMemberField(ctx, 'conditions', conditions[1] as string, 'โรคประจำตัว');

  const budget = text.match(SET_BUDGET);
  if (budget) return handleSetBudget(ctx, budget[1] as string, budget[2] as string);

  if (DEBT_SUMMARY.test(text)) return handleDebtSummary(ctx);
  if (LOAN_SUMMARY.test(text)) return handleLoanSummary(ctx);
  if (ASSET_SUMMARY.test(text)) return handleAssetSummary(ctx);
  if (DEPOSIT_SUMMARY.test(text)) return handleDepositSummary(ctx);
  if (NET_WORTH_SUMMARY.test(text)) return handleNetWorthSummary(ctx);

  if (UNDO_LAST.test(text)) return handleUndoLast(ctx);

  const closeTask = text.match(CLOSE_TASK);
  if (closeTask) return handleCloseTask(ctx, (closeTask[1] as string).trim());

  if (TASK_BOARD.test(text)) return handleTaskBoard(ctx);

  const del = text.match(DELETE_BY_NAME);
  if (del) return handleDeleteByName(ctx, del[1] as DeletableDomain, (del[2] as string).trim());

  return null;
}

async function handleMedTaken(ctx: CommandContext, nameHint?: string): Promise<CommandResult> {
  if (ctx.memberId === null) {
    return { reply: 'ไม่ทราบว่าเป็นยาของใคร กรุณาพิมพ์ในกลุ่มด้วยบัญชี LINE ของตัวเอง' };
  }

  const result = await markMedicationTaken(
    ctx.prisma,
    ctx.memberId,
    ctx.now,
    nameHint && nameHint.length > 0 ? nameHint : undefined,
  );

  if (!result) {
    return { reply: 'ไม่พบรายการยาที่รอกินอยู่ตอนนี้ครับ' };
  }

  return {
    reply: `✅ บันทึกว่ากินยา ${result.medicationName} เวลา ${formatThaiTime(result.scheduledAt)} แล้ว`,
  };
}

async function handleChoreDone(ctx: CommandContext, nameHint?: string): Promise<CommandResult> {
  if (!nameHint || nameHint.length === 0) {
    const active = await ctx.prisma.chore.findMany({
      where: { familyId: ctx.familyId, active: true },
      select: { id: true, name: true },
    });
    if (active.length === 0) return { reply: 'ยังไม่มีเวรที่ตั้งไว้ครับ' };
    if (active.length > 1) {
      return {
        reply: `มีหลายเวร ระบุชื่อด้วยนะ เช่น "ทำแล้ว ${active[0]?.name}"`,
      };
    }
    return finishChore(ctx, (active[0] as { id: string; name: string }).id);
  }

  const chore = await ctx.prisma.chore.findFirst({
    where: { familyId: ctx.familyId, active: true, name: { contains: nameHint } },
  });
  if (!chore) return { reply: `ไม่พบเวรชื่อ "${nameHint}" ครับ` };

  return finishChore(ctx, chore.id);
}

async function finishChore(ctx: CommandContext, choreId: string): Promise<CommandResult> {
  const result = await markChoreDone(ctx.prisma, choreId, ctx.now);
  if (!result) return { reply: 'ไม่พบเวรนี้ครับ' };

  const handoff = result.nextAssignee ? ` ตาต่อไปคือ ${result.nextAssignee} ครับ` : '';
  return { reply: `✅ ทำ "${result.name}" แล้ว${handoff}` };
}

async function handleEmergencyInfo(ctx: CommandContext): Promise<CommandResult> {
  const members = await ctx.prisma.member.findMany({
    where: { familyId: ctx.familyId },
    select: { displayName: true, bloodType: true, allergies: true, conditions: true },
  });

  if (members.length === 0) {
    return { reply: 'ยังไม่มีข้อมูลสมาชิกในบ้านครับ' };
  }

  const lines = members.map((m) => {
    const parts = [
      `กรุ๊ปเลือด ${m.bloodType ?? '-'}`,
      `แพ้ยา ${m.allergies ?? '-'}`,
      `โรคประจำตัว ${m.conditions ?? '-'}`,
    ];
    return `${m.displayName}\n  ${parts.join(' / ')}`;
  });

  return { reply: `ข้อมูลฉุกเฉินในบ้าน\n\n${lines.join('\n\n')}` };
}

async function setMemberField(
  ctx: CommandContext,
  field: 'bloodType' | 'allergies' | 'conditions',
  value: string,
  label: string,
): Promise<CommandResult> {
  if (ctx.memberId === null) {
    return { reply: 'พิมพ์ในกลุ่มด้วยบัญชี LINE ของตัวเองก่อนนะครับ ระบบจะได้รู้ว่าเป็นข้อมูลของใคร' };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return { reply: `พิมพ์${label}ต่อท้ายด้วยนะครับ` };

  await ctx.prisma.member.update({
    where: { id: ctx.memberId },
    data: { [field]: trimmed },
  });

  return { reply: `บันทึก${label}: ${trimmed} แล้วครับ` };
}

async function handleSetBudget(
  ctx: CommandContext,
  categoryName: string,
  amountRaw: string,
): Promise<CommandResult> {
  const name = categoryName.trim();
  const limitAmount = parseAmountToSatang(amountRaw);
  if (name.length === 0 || limitAmount === null || limitAmount <= 0) {
    return { reply: 'พิมพ์แบบนี้นะครับ "ตั้งงบ ค่าไฟ 1000 บาท"' };
  }

  const category = await ctx.prisma.category.upsert({
    where: { familyId_name_kind: { familyId: ctx.familyId, name, kind: 'OUT' } },
    create: { familyId: ctx.familyId, name, kind: 'OUT' },
    update: {},
  });

  const yearMonth = ctx.now.toFormat('yyyy-MM');
  // Resetting alertedPercent lets a raised limit alert again this month —
  // otherwise crossing 80% once would suppress every future alert even
  // after the family agreed to spend more.
  await ctx.prisma.budget.upsert({
    where: { familyId_categoryId_yearMonth: { familyId: ctx.familyId, categoryId: category.id, yearMonth } },
    create: { familyId: ctx.familyId, categoryId: category.id, yearMonth, limitAmount },
    update: { limitAmount, alertedPercent: 0 },
  });

  return {
    reply: `ตั้งงบ "${name}" เดือนนี้ที่ ${formatSatang(limitAmount)} บาท แล้วครับ (ใช้ต่อไปทุกเดือนจนกว่าจะเปลี่ยน)`,
  };
}

async function handleDebtSummary(ctx: CommandContext): Promise<CommandResult> {
  const yearMonth = ctx.now.toFormat('yyyy-MM');
  const balances = await computeNetBalances(
    ctx.prisma,
    ctx.familyId,
    yearMonth,
    ctx.now.zoneName ?? 'Asia/Bangkok',
  );

  if (balances.length === 0) {
    return { reply: 'เดือนนี้ยังไม่มีรายการที่หารกันครับ' };
  }

  const lines = balances.map((b) =>
    b.balanceSatang > 0
      ? `${b.displayName}: มีคนติดอยู่ ${formatSatang(b.balanceSatang)} บาท`
      : `${b.displayName}: ติดคนอื่นอยู่ ${formatSatang(Math.abs(b.balanceSatang))} บาท`,
  );

  return { reply: `สรุปยอดหักลบเดือนนี้\n\n${lines.join('\n')}` };
}

async function handleLoanSummary(ctx: CommandContext): Promise<CommandResult> {
  const loans = await listLoans(ctx.prisma, ctx.familyId);
  const outstanding = loans.filter((l) => l.principalSatang > l.repaidSatang);
  if (outstanding.length === 0) return { reply: 'ตอนนี้ไม่มีเงินให้ใครยืมค้างอยู่ครับ' };

  const lines = outstanding.map((l) => {
    const left = l.principalSatang - l.repaidSatang;
    return `${l.borrowerName}: ค้าง ${formatSatang(left)} จาก ${formatSatang(l.principalSatang)} บาท`;
  });
  const total = outstanding.reduce((sum, l) => sum + (l.principalSatang - l.repaidSatang), 0);

  return { reply: `สรุปเงินให้ยืม\n\n${lines.join('\n')}\n\nรวมค้างคืน ${formatSatang(total)} บาท` };
}

async function handleAssetSummary(ctx: CommandContext): Promise<CommandResult> {
  const assets = await listAssets(ctx.prisma, ctx.familyId);
  if (assets.length === 0) return { reply: 'ยังไม่มีทรัพย์สินบันทึกไว้ครับ' };

  const lines = assets.map(
    (a) => `${a.name} (${ASSET_CATEGORY_LABEL[a.category as keyof typeof ASSET_CATEGORY_LABEL]}): ${formatSatang(a.valueSatang)} บาท`,
  );
  const total = assets.reduce((sum, a) => sum + a.valueSatang, 0);

  return { reply: `สรุปทรัพย์สิน\n\n${lines.join('\n')}\n\nรวมมูลค่า ${formatSatang(total)} บาท` };
}

async function handleDepositSummary(ctx: CommandContext): Promise<CommandResult> {
  const deposits = await listDeposits(ctx.prisma, ctx.familyId);
  if (deposits.length === 0) return { reply: 'ยังไม่มีบัญชีเงินฝากบันทึกไว้ครับ' };

  const lines = deposits.map((d) => `${d.name}: ${formatSatang(d.balanceSatang)} บาท`);
  const total = deposits.reduce((sum, d) => sum + d.balanceSatang, 0);

  return { reply: `สรุปเงินฝาก\n\n${lines.join('\n')}\n\nรวม ${formatSatang(total)} บาท` };
}

/**
 * "ยกเลิกล่าสุด" — removes whatever this family recorded most recently, within
 * the last day only. An undo that can reach back a week is a data-loss trap
 * rather than a convenience, and the reply always names what went, so a
 * mistaken undo is obvious immediately.
 */
async function handleUndoLast(ctx: CommandContext): Promise<CommandResult> {
  const where = {
    familyId: ctx.familyId,
    createdAt: { gte: ctx.now.minus({ hours: 24 }).toJSDate() },
  };
  const newest = { createdAt: 'desc' } as const;

  const [event, tx, bill, doc, chore, loan, asset, deposit, item, task] = await Promise.all([
    ctx.prisma.event.findFirst({ where, orderBy: newest }),
    ctx.prisma.transaction.findFirst({ where, orderBy: newest }),
    ctx.prisma.bill.findFirst({ where, orderBy: newest }),
    ctx.prisma.document.findFirst({ where, orderBy: newest }),
    ctx.prisma.chore.findFirst({ where, orderBy: newest }),
    ctx.prisma.loan.findFirst({ where, orderBy: newest }),
    ctx.prisma.asset.findFirst({ where, orderBy: newest }),
    ctx.prisma.deposit.findFirst({ where, orderBy: newest }),
    ctx.prisma.shoppingItem.findFirst({ where, orderBy: newest }),
    ctx.prisma.task.findFirst({ where, orderBy: newest }),
  ]);

  const candidates: Array<{
    createdAt: Date;
    label: string;
    remove: () => Promise<boolean>;
  }> = [];

  if (event) {
    candidates.push({
      createdAt: event.createdAt,
      label: `นัด "${event.title}"`,
      remove: () => deleteEvent(ctx, event.id),
    });
  }
  if (tx) {
    candidates.push({
      createdAt: tx.createdAt,
      label: `รายการเงิน ${formatSatang(tx.amount)} บาท`,
      remove: () => deleteTransaction(ctx, tx.id),
    });
  }
  if (bill) {
    candidates.push({
      createdAt: bill.createdAt,
      label: `บิล "${bill.name}"`,
      remove: () => deleteBill(ctx, bill.id),
    });
  }
  if (doc) {
    candidates.push({
      createdAt: doc.createdAt,
      label: `เอกสาร "${doc.name}"`,
      remove: () => deleteDocument(ctx, doc.id),
    });
  }
  if (chore) {
    candidates.push({
      createdAt: chore.createdAt,
      label: `เวร "${chore.name}"`,
      remove: () => deleteChore(ctx, chore.id),
    });
  }
  if (loan) {
    candidates.push({
      createdAt: loan.createdAt,
      label: `เงินให้ "${loan.borrowerName}" ยืม`,
      remove: () => deleteLoan(ctx, loan.id),
    });
  }
  if (asset) {
    candidates.push({
      createdAt: asset.createdAt,
      label: `ทรัพย์สิน "${asset.name}"`,
      remove: () => deleteAsset(ctx, asset.id),
    });
  }
  if (deposit) {
    candidates.push({
      createdAt: deposit.createdAt,
      label: `บัญชีเงินฝาก "${deposit.name}"`,
      remove: () => deleteDeposit(ctx, deposit.id),
    });
  }
  if (item) {
    candidates.push({
      createdAt: item.createdAt,
      label: `รายการซื้อของ "${item.name}"`,
      remove: () => deleteShoppingItem(ctx, item.id),
    });
  }
  if (task) {
    candidates.push({
      createdAt: task.createdAt,
      label: `งาน "${task.title}"`,
      remove: () => deleteTask(ctx, task.id),
    });
  }

  if (candidates.length === 0) {
    return { reply: 'ไม่มีรายการที่บันทึกไว้ใน 24 ชั่วโมงที่ผ่านมาครับ' };
  }

  const latest = candidates.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const removed = await latest.remove();

  return {
    reply: removed
      ? `🗑️ ยกเลิก${latest.label} แล้วครับ`
      : 'ยกเลิกไม่สำเร็จครับ ลองใหม่อีกครั้ง',
  };
}

/** "ปิดงาน ล้างรถ" — moves a board card straight to เสร็จแล้ว. */
async function handleCloseTask(ctx: CommandContext, hint: string): Promise<CommandResult> {
  const open = await ctx.prisma.task.findMany({
    where: { familyId: ctx.familyId, status: { in: ['TODO', 'DOING'] }, title: { contains: hint } },
    take: 5,
    select: { id: true, title: true },
  });

  if (open.length === 0) return { reply: `ไม่พบงานที่ค้างอยู่ชื่อ "${hint}" ครับ` };
  if (open.length > 1) {
    return {
      reply: `มีหลายงานที่ตรงกับ "${hint}" ระบุให้ชัดขึ้นนะครับ\n${open
        .map((t) => `• ${t.title}`)
        .join('\n')}`,
    };
  }

  const target = open[0] as { id: string; title: string };
  await updateTask(ctx, target.id, { status: 'DONE' });

  const left = await ctx.prisma.task.count({
    where: { familyId: ctx.familyId, status: { in: ['TODO', 'DOING'] } },
  });

  return {
    reply: `✅ ปิดงาน "${target.title}" แล้วครับ${left > 0 ? ` เหลืออีก ${left} งาน` : ' หมดบอร์ดแล้ว เก่งมากครับ 🎉'}`,
  };
}

async function handleTaskBoard(ctx: CommandContext): Promise<CommandResult> {
  const tasks = await ctx.prisma.task.findMany({
    where: { familyId: ctx.familyId, status: { in: ['TODO', 'DOING'] } },
    orderBy: [{ status: 'desc' }, { sortOrder: 'asc' }],
    take: 20,
    include: { assignee: { select: { displayName: true } } },
  });

  if (tasks.length === 0) return { reply: 'บอร์ดว่างแล้วครับ ไม่มีงานค้าง 🎉' };

  const lines = tasks.map((t) => {
    const mark = t.status === 'DOING' ? '🔸' : '▫️';
    const who = t.assignee ? ` — ${t.assignee.displayName}` : '';
    const due = t.dueAt ? ` (ครบกำหนด ${formatThaiDate(DateTime.fromJSDate(t.dueAt))})` : '';
    return `${mark} ${t.title}${who}${due}`;
  });

  return { reply: `บอร์ดงานของบ้าน — ค้าง ${tasks.length} งาน\n\n${lines.join('\n')}` };
}

type DeletableDomain =
  | 'นัด'
  | 'บิล'
  | 'เอกสาร'
  | 'ยา'
  | 'เวร'
  | 'เงินกู้'
  | 'ทรัพย์สิน'
  | 'เงินฝาก'
  | 'ของ'
  | 'งาน';

/** Shared tail for every "ลบ<อะไร> <ชื่อ>": nothing found, too many, or done. */
async function finishDelete(
  found: Array<{ id: string; name: string }>,
  hint: string,
  label: string,
  remove: (id: string) => Promise<boolean>,
): Promise<CommandResult> {
  if (found.length === 0) return { reply: `ไม่พบ${label} "${hint}" ครับ` };
  if (found.length > 1) {
    // Deleting the wrong row is not recoverable, so an ambiguous name asks
    // rather than guesses.
    return {
      reply: `พบหลายรายการที่ตรงกับ "${hint}" ระบุให้ชัดขึ้นนะครับ\n${found
        .map((f) => `• ${f.name}`)
        .join('\n')}`,
    };
  }

  const target = found[0] as { id: string; name: string };
  const removed = await remove(target.id);
  return {
    reply: removed ? `🗑️ ลบ${label} "${target.name}" แล้วครับ` : 'ลบไม่สำเร็จครับ ลองใหม่อีกครั้ง',
  };
}

async function handleDeleteByName(
  ctx: CommandContext,
  domain: DeletableDomain,
  hint: string,
): Promise<CommandResult> {
  const familyId = ctx.familyId;
  const take = 5;

  switch (domain) {
    case 'นัด': {
      const rows = await ctx.prisma.event.findMany({
        where: { familyId, title: { contains: hint } },
        orderBy: { startAt: 'desc' },
        take,
        select: { id: true, title: true },
      });
      return finishDelete(
        rows.map((r) => ({ id: r.id, name: r.title })),
        hint,
        'นัด',
        (id) => deleteEvent(ctx, id),
      );
    }
    case 'บิล': {
      const rows = await ctx.prisma.bill.findMany({
        where: { familyId, name: { contains: hint } },
        take,
        select: { id: true, name: true },
      });
      return finishDelete(rows, hint, 'บิล', (id) => deleteBill(ctx, id));
    }
    case 'เอกสาร': {
      const rows = await ctx.prisma.document.findMany({
        where: { familyId, name: { contains: hint } },
        take,
        select: { id: true, name: true },
      });
      return finishDelete(rows, hint, 'เอกสาร', (id) => deleteDocument(ctx, id));
    }
    case 'ยา': {
      const rows = await ctx.prisma.medication.findMany({
        where: { member: { familyId }, name: { contains: hint } },
        take,
        select: { id: true, name: true },
      });
      return finishDelete(rows, hint, 'ยา', (id) => deleteMedication(ctx, id));
    }
    case 'เวร': {
      const rows = await ctx.prisma.chore.findMany({
        where: { familyId, name: { contains: hint } },
        take,
        select: { id: true, name: true },
      });
      return finishDelete(rows, hint, 'เวร', (id) => deleteChore(ctx, id));
    }
    case 'เงินกู้': {
      const rows = await ctx.prisma.loan.findMany({
        where: { familyId, borrowerName: { contains: hint } },
        take,
        select: { id: true, borrowerName: true },
      });
      return finishDelete(
        rows.map((r) => ({ id: r.id, name: r.borrowerName })),
        hint,
        'เงินให้ยืมของ',
        (id) => deleteLoan(ctx, id),
      );
    }
    case 'ทรัพย์สิน': {
      const rows = await ctx.prisma.asset.findMany({
        where: { familyId, name: { contains: hint } },
        take,
        select: { id: true, name: true },
      });
      return finishDelete(rows, hint, 'ทรัพย์สิน', (id) => deleteAsset(ctx, id));
    }
    case 'เงินฝาก': {
      const rows = await ctx.prisma.deposit.findMany({
        where: { familyId, name: { contains: hint } },
        take,
        select: { id: true, name: true },
      });
      return finishDelete(rows, hint, 'บัญชีเงินฝาก', (id) => deleteDeposit(ctx, id));
    }
    case 'ของ': {
      const rows = await ctx.prisma.shoppingItem.findMany({
        where: { familyId, boughtAt: null, name: { contains: hint } },
        take,
        select: { id: true, name: true },
      });
      return finishDelete(rows, hint, 'รายการซื้อของ', (id) => deleteShoppingItem(ctx, id));
    }
    case 'งาน': {
      const rows = await ctx.prisma.task.findMany({
        where: { familyId, title: { contains: hint } },
        take,
        select: { id: true, title: true },
      });
      return finishDelete(
        rows.map((r) => ({ id: r.id, name: r.title })),
        hint,
        'งาน',
        (id) => deleteTask(ctx, id),
      );
    }
  }
}

async function handleNetWorthSummary(ctx: CommandContext): Promise<CommandResult> {
  const nw = await computeNetWorth(ctx.prisma, ctx.familyId);

  return {
    reply: [
      'สรุปฐานะการเงิน',
      '',
      `เงินให้ยืม (ค้างคืน): ${formatSatang(nw.loansOutstandingSatang)} บาท`,
      `ทรัพย์สิน: ${formatSatang(nw.assetsValueSatang)} บาท`,
      `เงินฝาก: ${formatSatang(nw.depositsSatang)} บาท`,
      '',
      `รวมทั้งหมด: ${formatSatang(nw.totalSatang)} บาท`,
    ].join('\n'),
  };
}
