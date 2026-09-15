import type { PrismaClient } from '@prisma/client';
import { Hono } from 'hono';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { EXPORT_LINK_TTL_MINUTES, type ExportLinkStore } from './exportLinks.js';
import { listCalendar, MAX_RANGE_DAYS } from '../modules/calendar.js';
import { computeMoneyOverview, computeTaskCounts, computeUpcoming } from '../modules/dashboard.js';
import { computeExpenseSummary } from '../modules/expenseSummary.js';
import {
  computeNetWorth,
  listAssets,
  listDeposits,
  listLoans,
} from '../modules/loanAssetDeposit.js';
import { persistDraft, resolveRotation } from '../modules/persist.js';
import { computeSetupStatus } from '../modules/setup.js';
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
  detachOccurrence,
  skipOccurrence,
  updateAsset,
  updateBill,
  updateChore,
  updateDeposit,
  updateDocument,
  updateEvent,
  updateLoan,
  updateMedication,
  updateTask,
  updateTransaction,
  type RecordContext,
} from '../modules/records.js';
import type { VerifiedLiffUser } from './liffAuth.js';

/**
 * REST API for the LIFF app.
 *
 * This is the one place in the codebase where a Draft is persisted without a
 * confirm-card tap — a LIFF form submission *is* the confirmation, the same
 * way tapping "save" in any app is. Everything still goes through
 * modules/persist.ts, so job generation and idempotency rules are identical
 * to the chat path.
 */

export interface ApiDeps {
  prisma: PrismaClient;
  defaultTimezone: string;
  /** Omit both to run without the backup download. */
  exportLinks?: ExportLinkStore;
  publicBaseUrl?: string;
  /** Injectable so tests never make a real network call to LINE. */
  verifyToken: (idToken: string) => Promise<VerifiedLiffUser | null>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

interface AuthedMember {
  familyId: string;
  memberId: string;
  displayName: string;
  timezone: string;
  lineUserId: string;
  /** How many families this LINE account belongs to — more than 1 shows a switcher. */
  familyCount: number;
}

type Vars = { member: AuthedMember };

/**
 * The member behind a verified LIFF token, in the family the app asked for.
 *
 * One LINE account is a separate Member row in every group the bot shares with
 * it. LINE no longer tells a LIFF page which group opened it, so the page says
 * which family it wants (x-family-id, remembered on the phone) and gets its
 * first family otherwise. The requested id is only honoured if this person
 * really is a member there — it picks between their own families, it can never
 * reach someone else's.
 */
async function resolveMember(
  deps: ApiDeps,
  idToken: string,
  requestedFamilyId: string | undefined,
): Promise<AuthedMember | null> {
  const verified = await deps.verifyToken(idToken);
  if (!verified) {
    deps.log?.('liff auth failed: id token did not verify');
    return null;
  }

  const memberships = await deps.prisma.member.findMany({
    where: { lineUserId: verified.lineUserId },
    select: { id: true, displayName: true, family: { select: { id: true, timezone: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const member =
    memberships.find((m) => m.family.id === requestedFamilyId) ?? memberships[0];
  if (!member) {
    deps.log?.('liff auth failed: no Member row for this LINE user id', {
      lineUserId: verified.lineUserId,
    });
    return null;
  }

  return {
    familyId: member.family.id,
    memberId: member.id,
    displayName: member.displayName,
    timezone: member.family.timezone,
    lineUserId: verified.lineUserId,
    familyCount: memberships.length,
  };
}

const expenseBody = z.object({
  amountBaht: z.number().positive(),
  direction: z.enum(['IN', 'OUT']).default('OUT'),
  categoryName: z.string().min(1).optional(),
  note: z.string().optional(),
});

const shoppingBody = z.object({
  items: z
    .array(z.object({ name: z.string().min(1), qty: z.string().optional() }))
    .min(1),
});

const documentType = z.enum([
  'ID_CARD',
  'PASSPORT',
  'DRIVER_LICENSE',
  'VEHICLE_TAX',
  'INSURANCE',
  'VISA',
  'OTHER',
]);

const eventCategory = z.enum(['MEDICAL', 'SCHOOL', 'GOVERNMENT', 'SOCIAL', 'WORK', 'OTHER']);

const eventBody = z.object({
  title: z.string().min(1),
  /** ISO date/time string, local to the family's timezone. */
  startAt: z.string(),
  allDay: z.boolean().default(false),
  category: eventCategory.default('OTHER'),
  location: z.string().optional(),
  note: z.string().optional(),
  attendeeName: z.string().optional(),
  /** RRULE body, e.g. "FREQ=WEEKLY;BYDAY=MO". Empty means it happens once. */
  rrule: z.string().optional(),
});

const billBody = z.object({
  name: z.string().min(1),
  amountBaht: z.number().positive().optional(),
  dueDay: z.number().int().min(1).max(31),
});

const documentBody = z.object({
  name: z.string().min(1),
  type: documentType.default('OTHER'),
  expiresAt: z.string(),
});

const medicationBody = z.object({
  name: z.string().min(1),
  dosage: z.string().optional(),
  times: z.array(z.string().regex(/^\d{1,2}:\d{2}$/)).min(1),
});

const choreBody = z.object({
  name: z.string().min(1),
  cadence: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  rotationNames: z.array(z.string().min(1)).default([]),
});

const assetCategory = z.enum(['PROPERTY', 'VEHICLE', 'ELECTRONICS', 'JEWELRY', 'INVESTMENT', 'OTHER']);

const loanBody = z.object({
  borrowerName: z.string().min(1),
  principalAmountBaht: z.number().positive(),
  /** ISO date/time string, local to the family's timezone. */
  dueAt: z.string().optional(),
  note: z.string().optional(),
});

const repayBody = z.object({ amountBaht: z.number().positive() });

const assetBody = z.object({
  name: z.string().min(1),
  category: assetCategory.default('OTHER'),
  valueBaht: z.number().positive(),
  /** ISO date string, local to the family's timezone. */
  acquiredAt: z.string().optional(),
  note: z.string().optional(),
});

const assetValueBody = z.object({ valueBaht: z.number().positive() });

const depositBody = z.object({
  name: z.string().min(1),
  balanceBaht: z.number().nonnegative(),
  note: z.string().optional(),
});

const depositAdjustBody = z.object({ amountBaht: z.number() });

/** "07:00" — digest times are chosen on the half hour in the app. */
const clockTime = z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/);
const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const digestSettingsBody = z
  .object({
    morningAt: clockTime.optional(),
    eveningAt: clockTime.optional(),
    morningOn: z.boolean().optional(),
    eveningOn: z.boolean().optional(),
    everyMorning: z.boolean().optional(),
  })
  .strict();

const emergencyBody = z.object({
  bloodType: z.string().max(8).nullable().optional(),
  allergies: z.string().max(300).nullable().optional(),
  conditions: z.string().max(300).nullable().optional(),
});

const eventPatchBody = z.object({
  title: z.string().min(1).optional(),
  startAt: z.string().optional(),
  allDay: z.boolean().optional(),
  category: eventCategory.optional(),
  location: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  attendeeName: z.string().nullable().optional(),
  /** Empty string clears the repeat. */
  rrule: z.string().nullable().optional(),
});

const transactionPatchBody = z.object({
  amountBaht: z.number().positive().optional(),
  direction: z.enum(['IN', 'OUT']).optional(),
  categoryName: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  occurredAt: z.string().optional(),
});

const billPatchBody = z.object({
  name: z.string().min(1).optional(),
  amountBaht: z.number().positive().nullable().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  active: z.boolean().optional(),
});

const documentPatchBody = z.object({
  name: z.string().min(1).optional(),
  type: documentType.optional(),
  expiresAt: z.string().optional(),
});

const medicationPatchBody = z.object({
  name: z.string().min(1).optional(),
  dosage: z.string().nullable().optional(),
  times: z.array(z.string().regex(/^\d{1,2}:\d{2}$/)).min(1).optional(),
  active: z.boolean().optional(),
});

const chorePatchBody = z.object({
  name: z.string().min(1).optional(),
  cadence: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']).optional(),
  active: z.boolean().optional(),
  rotationNames: z.array(z.string().min(1)).optional(),
});

const loanPatchBody = z.object({
  borrowerName: z.string().min(1).optional(),
  principalAmountBaht: z.number().positive().optional(),
  repaidAmountBaht: z.number().nonnegative().optional(),
  dueAt: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

const assetPatchBody = z.object({
  name: z.string().min(1).optional(),
  category: assetCategory.optional(),
  valueBaht: z.number().positive().optional(),
  acquiredAt: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

const taskStatus = z.enum(['TODO', 'DOING', 'DONE']);

const taskBody = z.object({
  title: z.string().min(1),
  dueAt: z.string().optional(),
  assigneeName: z.string().optional(),
  note: z.string().optional(),
});

const taskPatchBody = z.object({
  title: z.string().min(1).optional(),
  status: taskStatus.optional(),
  assigneeName: z.string().nullable().optional(),
  dueAt: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const depositPatchBody = z.object({
  name: z.string().min(1).optional(),
  balanceBaht: z.number().nonnegative().optional(),
  note: z.string().nullable().optional(),
});

/**
 * Drops keys whose value is undefined. Zod types every optional field as
 * `T | undefined`, which under exactOptionalPropertyTypes is not the same as
 * "absent" — and "absent" is what a patch means by "leave this alone".
 */
function definedOnly<T extends object>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

export function createApiRouter(deps: ApiDeps) {
  const app = new Hono<{ Variables: Vars }>();

  app.use('*', async (c, next) => {
    const idToken = c.req.header('x-liff-id-token');
    if (!idToken) return c.json({ error: 'missing x-liff-id-token header' }, 401);

    const member = await resolveMember(deps, idToken, c.req.header('x-family-id'));
    if (!member) return c.json({ error: 'unauthorized' }, 401);

    c.set('member', member);
    await next();
  });

  app.get('/me', async (c) => {
    const { lineUserId, familyCount, ...member } = c.get('member');
    if (familyCount < 2) return c.json({ ...member, families: [] });

    // Families have no names of their own, so each is labelled by who else is
    // in it — "แม่, พ่อ, น้องพร" is how anyone would tell two groups apart.
    const memberships = await deps.prisma.member.findMany({
      where: { lineUserId },
      orderBy: { createdAt: 'asc' },
      select: {
        family: {
          select: {
            id: true,
            members: {
              where: { lineUserId: { not: lineUserId } },
              select: { displayName: true },
              orderBy: { createdAt: 'asc' },
              take: 3,
            },
          },
        },
      },
    });

    return c.json({
      ...member,
      families: memberships.map((m) => ({
        familyId: m.family.id,
        label: m.family.members.map((o) => o.displayName).join(', ') || 'กลุ่มที่มีแค่คุณ',
      })),
    });
  });

  /**
   * When the digests go out. Family-wide, since the digest goes to the whole
   * group; any member may change it, the same as any other shared record.
   */
  app.get('/family/digest', async (c) => {
    const member = c.get('member');
    const f = await deps.prisma.family.findUniqueOrThrow({
      where: { id: member.familyId },
      select: {
        digestMorningAt: true,
        digestEveningAt: true,
        digestMorningOn: true,
        digestEveningOn: true,
        digestEveryMorning: true,
      },
    });
    return c.json({
      morningAt: toClock(f.digestMorningAt),
      eveningAt: toClock(f.digestEveningAt),
      morningOn: f.digestMorningOn,
      eveningOn: f.digestEveningOn,
      everyMorning: f.digestEveryMorning,
    });
  });

  app.patch('/family/digest', async (c) => {
    const member = c.get('member');
    const parsed = digestSettingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'เวลาต้องเป็นแบบ 07:00 หรือ 07:30' }, 400);

    const current = await deps.prisma.family.findUniqueOrThrow({
      where: { id: member.familyId },
      select: { digestMorningAt: true, digestEveningAt: true, digestMorningOn: true, digestEveningOn: true },
    });
    const next = {
      morningAt: parsed.data.morningAt ? toMinutes(parsed.data.morningAt) : current.digestMorningAt,
      eveningAt: parsed.data.eveningAt ? toMinutes(parsed.data.eveningAt) : current.digestEveningAt,
      morningOn: parsed.data.morningOn ?? current.digestMorningOn,
      eveningOn: parsed.data.eveningOn ?? current.digestEveningOn,
    };

    // Reminders only ever leave through a digest. With both switched off they
    // would pile up unsent while /health went red — refuse rather than allow it.
    if (!next.morningOn && !next.eveningOn) {
      return c.json({ error: 'ต้องเปิดไว้อย่างน้อย 1 รอบ ไม่อย่างนั้นการเตือนจะไม่ถูกส่งเลย' }, 400);
    }
    // The digest calls itself "เช้า" or "เย็น" by the hour it goes out.
    if (next.morningAt >= 12 * 60) {
      return c.json({ error: 'สรุปเช้าต้องก่อนเที่ยง' }, 400);
    }
    if (next.eveningAt < 12 * 60) {
      return c.json({ error: 'สรุปเย็นต้องหลังเที่ยง' }, 400);
    }

    await deps.prisma.family.update({
      where: { id: member.familyId },
      data: {
        digestMorningAt: next.morningAt,
        digestEveningAt: next.eveningAt,
        digestMorningOn: next.morningOn,
        digestEveningOn: next.eveningOn,
        ...(parsed.data.everyMorning !== undefined
          ? { digestEveryMorning: parsed.data.everyMorning }
          : {}),
      },
    });
    return c.json({ ok: true });
  });

  /** What the family has not set up yet — the checklist on the dashboard. */
  app.get('/setup', async (c) => {
    const member = c.get('member');
    return c.json(await computeSetupStatus(deps.prisma, member.familyId, member.memberId));
  });

  /**
   * Emergency details belong to the person they are about: this only ever
   * writes the caller's own row, exactly like the chat command does.
   */
  app.patch('/me/emergency', async (c) => {
    const member = c.get('member');
    const parsed = emergencyBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const trimmed = (v: string | null | undefined) =>
      v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim();

    await deps.prisma.member.update({
      where: { id: member.memberId },
      data: definedOnly({
        bloodType: trimmed(parsed.data.bloodType),
        allergies: trimmed(parsed.data.allergies),
        conditions: trimmed(parsed.data.conditions),
      }),
    });
    return c.json({ ok: true });
  });

  app.get('/me/emergency', async (c) => {
    const member = c.get('member');
    const row = await deps.prisma.member.findUniqueOrThrow({
      where: { id: member.memberId },
      select: { bloodType: true, allergies: true, conditions: true },
    });
    return c.json(row);
  });

  /**
   * A link to this family's backup file, good for a few minutes. The app opens
   * it in the real browser, which is the only place a download reliably lands.
   */
  app.post('/export/link', async (c) => {
    const member = c.get('member');
    if (!deps.exportLinks || !deps.publicBaseUrl) {
      return c.json({ error: 'การสำรองข้อมูลยังไม่เปิดใช้บนเซิร์ฟเวอร์นี้' }, 503);
    }
    const token = deps.exportLinks.issue(member.familyId);
    return c.json({
      url: `${deps.publicBaseUrl.replace(/\/+$/, '')}/export/${token}`,
      expiresInMinutes: EXPORT_LINK_TTL_MINUTES,
    });
  });

  app.get('/agenda', async (c) => {
    const member = c.get('member');
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 30), 1), 90);
    const now = DateTime.now().setZone(member.timezone);

    const jobs = await deps.prisma.notificationJob.findMany({
      where: {
        familyId: member.familyId,
        status: 'PENDING',
        dueAt: { gte: now.toJSDate(), lte: now.plus({ days }).toJSDate() },
      },
      orderBy: { dueAt: 'asc' },
      take: 200,
    });

    return c.json({
      items: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        dueAt: j.dueAt.toISOString(),
        text: (j.payload as { text?: string }).text ?? '',
        // Id of the originating row (Event.id for kind EVENT, etc.) — lets the
        // LIFF calendar fetch full detail for an item without a second lookup.
        refId: j.refId,
      })),
    });
  });

  app.get('/events', async (c) => {
    const member = c.get('member');
    const from = DateTime.fromISO(c.req.query('from') ?? '', { zone: member.timezone });
    const to = DateTime.fromISO(c.req.query('to') ?? '', { zone: member.timezone });
    if (!from.isValid || !to.isValid) return c.json({ error: 'from and to must be ISO dates' }, 400);

    // The widest caller is the month board's 6-week grid — cap the range so
    // nobody can ask for the whole family's history in one request.
    if (to.diff(from, 'days').days > MAX_RANGE_DAYS) {
      return c.json({ error: 'range too wide' }, 400);
    }

    return c.json(await listCalendar(deps.prisma, member.familyId, from, to, member.timezone));
  });

  app.get('/events/:id', async (c) => {
    const member = c.get('member');
    const id = c.req.param('id');

    const event = await deps.prisma.event.findFirst({
      where: { id, familyId: member.familyId },
      include: { attendees: { include: { member: { select: { displayName: true } } } } },
    });
    if (!event) return c.json({ error: 'not found' }, 404);

    return c.json({
      id: event.id,
      title: event.title,
      category: event.category,
      startAt: event.startAt.toISOString(),
      endAt: event.endAt ? event.endAt.toISOString() : null,
      allDay: event.allDay,
      location: event.location,
      note: event.note,
      rrule: event.rrule,
      attendeeNames: event.attendees.map((a) => a.member.displayName),
    });
  });

  app.post('/events', async (c) => {
    const member = c.get('member');
    const parsed = eventBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const startAt = DateTime.fromISO(parsed.data.startAt, { zone: member.timezone });
    if (!startAt.isValid) return c.json({ error: 'invalid startAt' }, 400);

    const now = DateTime.now().setZone(member.timezone);
    const result = await persistDraft(
      {
        kind: 'event',
        title: parsed.data.title,
        startAt,
        allDay: parsed.data.allDay,
        category: parsed.data.category,
        ...(parsed.data.location !== undefined ? { location: parsed.data.location } : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
        ...(parsed.data.attendeeName !== undefined ? { attendeeName: parsed.data.attendeeName } : {}),
        ...(parsed.data.rrule ? { rrule: parsed.data.rrule } : {}),
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.get('/expenses/summary', async (c) => {
    const member = c.get('member');
    const month = c.req.query('month') ?? DateTime.now().setZone(member.timezone).toFormat('yyyy-MM');

    const summary = await computeExpenseSummary(deps.prisma, member.familyId, month, member.timezone);
    if (!summary) return c.json({ error: 'month must be YYYY-MM' }, 400);

    return c.json(summary);
  });

  app.post('/expenses', async (c) => {
    const member = c.get('member');
    const parsed = expenseBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const amount = Math.round(parsed.data.amountBaht * 100);
    const now = DateTime.now().setZone(member.timezone);

    const result = await persistDraft(
      {
        kind: 'expense',
        amount,
        direction: parsed.data.direction,
        occurredAt: now,
        ...(parsed.data.categoryName !== undefined
          ? { categoryName: parsed.data.categoryName }
          : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.get('/dashboard', async (c) => {
    const member = c.get('member');
    const now = DateTime.now().setZone(member.timezone);
    const month = now.toFormat('yyyy-MM');

    const [upcoming, money, netWorth, tasks] = await Promise.all([
      computeUpcoming(deps.prisma, member.familyId, now, member.timezone),
      // month is always a valid "yyyy-MM" here (derived from `now`), so this
      // never actually returns null.
      computeMoneyOverview(deps.prisma, member.familyId, month, member.timezone),
      computeNetWorth(deps.prisma, member.familyId),
      computeTaskCounts(deps.prisma, member.familyId, now, member.timezone),
    ]);

    return c.json({ upcoming, money, netWorth, tasks });
  });

  app.get('/loans', async (c) => {
    const member = c.get('member');
    return c.json({ items: await listLoans(deps.prisma, member.familyId) });
  });

  app.post('/loans', async (c) => {
    const member = c.get('member');
    const parsed = loanBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = DateTime.now().setZone(member.timezone);
    let dueAt: DateTime | undefined;
    if (parsed.data.dueAt !== undefined) {
      dueAt = DateTime.fromISO(parsed.data.dueAt, { zone: member.timezone });
      if (!dueAt.isValid) return c.json({ error: 'invalid dueAt' }, 400);
    }

    const result = await persistDraft(
      {
        kind: 'loan',
        borrowerName: parsed.data.borrowerName,
        principalSatang: Math.round(parsed.data.principalAmountBaht * 100),
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.post('/loans/:id/repay', async (c) => {
    const member = c.get('member');
    const id = c.req.param('id');
    const parsed = repayBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const loan = await deps.prisma.loan.findFirst({ where: { id, familyId: member.familyId } });
    if (!loan) return c.json({ error: 'not found' }, 404);

    await deps.prisma.loan.update({
      where: { id },
      data: { repaidSatang: loan.repaidSatang + Math.round(parsed.data.amountBaht * 100) },
    });

    return c.json({ ok: true });
  });

  app.get('/assets', async (c) => {
    const member = c.get('member');
    return c.json({ items: await listAssets(deps.prisma, member.familyId) });
  });

  app.post('/assets', async (c) => {
    const member = c.get('member');
    const parsed = assetBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = DateTime.now().setZone(member.timezone);
    let acquiredAt: DateTime | undefined;
    if (parsed.data.acquiredAt !== undefined) {
      // A pure calendar date (@db.Date) has no time-of-day — parsed as UTC so
      // the stored day never shifts under a local timezone's UTC offset.
      acquiredAt = DateTime.fromISO(parsed.data.acquiredAt, { zone: 'utc' });
      if (!acquiredAt.isValid) return c.json({ error: 'invalid acquiredAt' }, 400);
    }

    const result = await persistDraft(
      {
        kind: 'asset',
        name: parsed.data.name,
        category: parsed.data.category,
        valueSatang: Math.round(parsed.data.valueBaht * 100),
        ...(acquiredAt !== undefined ? { acquiredAt } : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.post('/assets/:id/value', async (c) => {
    const member = c.get('member');
    const id = c.req.param('id');
    const parsed = assetValueBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const updated = await deps.prisma.asset.updateMany({
      where: { id, familyId: member.familyId },
      data: { valueSatang: Math.round(parsed.data.valueBaht * 100) },
    });
    if (updated.count === 0) return c.json({ error: 'not found' }, 404);

    return c.json({ ok: true });
  });

  app.get('/deposits', async (c) => {
    const member = c.get('member');
    return c.json({ items: await listDeposits(deps.prisma, member.familyId) });
  });

  app.post('/deposits', async (c) => {
    const member = c.get('member');
    const parsed = depositBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = DateTime.now().setZone(member.timezone);
    const result = await persistDraft(
      {
        kind: 'deposit',
        name: parsed.data.name,
        balanceSatang: Math.round(parsed.data.balanceBaht * 100),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.post('/deposits/:id/adjust', async (c) => {
    const member = c.get('member');
    const id = c.req.param('id');
    const parsed = depositAdjustBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const deposit = await deps.prisma.deposit.findFirst({ where: { id, familyId: member.familyId } });
    if (!deposit) return c.json({ error: 'not found' }, 404);

    await deps.prisma.deposit.update({
      where: { id },
      data: { balanceSatang: deposit.balanceSatang + Math.round(parsed.data.amountBaht * 100) },
    });

    return c.json({ ok: true });
  });

  app.get('/shopping', async (c) => {
    const member = c.get('member');
    const items = await deps.prisma.shoppingItem.findMany({
      where: { familyId: member.familyId, boughtAt: null },
      orderBy: { createdAt: 'asc' },
      include: { addedBy: { select: { displayName: true } } },
    });

    return c.json({
      items: items.map((i) => ({
        id: i.id,
        name: i.name,
        qty: i.qty,
        addedBy: i.addedBy?.displayName ?? null,
      })),
    });
  });

  app.post('/shopping', async (c) => {
    const member = c.get('member');
    const parsed = shoppingBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = DateTime.now().setZone(member.timezone);
    const result = await persistDraft(
      {
        kind: 'shopping',
        items: parsed.data.items.map((i) => ({
          name: i.name,
          ...(i.qty !== undefined ? { qty: i.qty } : {}),
        })),
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.post('/shopping/:id/bought', async (c) => {
    const member = c.get('member');
    const id = c.req.param('id');

    const updated = await deps.prisma.shoppingItem.updateMany({
      where: { id, familyId: member.familyId, boughtAt: null },
      data: { boughtAt: new Date() },
    });
    if (updated.count === 0) return c.json({ error: 'not found' }, 404);

    return c.json({ ok: true });
  });

  // -------------------------------------------------------------- editing
  //
  // Everything above records; everything below corrects. Each handler hands
  // off to modules/records.ts, which owns the family scoping and the reminder
  // cleanup — a route that deleted a row itself would leave its reminders to
  // fire for something that no longer exists.

  const recordCtx = (member: AuthedMember): RecordContext => ({
    prisma: deps.prisma,
    familyId: member.familyId,
    now: DateTime.now().setZone(member.timezone),
  });

  app.patch('/events/:id', async (c) => {
    const member = c.get('member');
    const parsed = eventPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { startAt, ...rest } = parsed.data;
    let startAtDt: DateTime | undefined;
    if (startAt !== undefined) {
      startAtDt = DateTime.fromISO(startAt, { zone: member.timezone });
      if (!startAtDt.isValid) return c.json({ error: 'invalid startAt' }, 400);
    }

    const ok = await updateEvent(recordCtx(member), c.req.param('id'), {
      ...definedOnly(rest),
      ...(startAtDt !== undefined ? { startAt: startAtDt } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  /** One date of a repeating appointment: `occurrence` is its start, as the board listed it. */
  const occurrenceBody = z.object({ occurrence: z.string() });

  app.post('/events/:id/skip', async (c) => {
    const member = c.get('member');
    const parsed = occurrenceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const occurrence = DateTime.fromISO(parsed.data.occurrence, { zone: member.timezone });
    if (!occurrence.isValid) return c.json({ error: 'invalid occurrence' }, 400);

    const ok = await skipOccurrence(recordCtx(member), c.req.param('id'), occurrence);
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.post('/events/:id/detach', async (c) => {
    const member = c.get('member');
    const parsed = eventPatchBody
      .extend({ occurrence: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { occurrence: occurrenceIso, startAt, ...rest } = parsed.data;
    const occurrence = DateTime.fromISO(occurrenceIso, { zone: member.timezone });
    if (!occurrence.isValid) return c.json({ error: 'invalid occurrence' }, 400);
    let startAtDt: DateTime | undefined;
    if (startAt !== undefined) {
      startAtDt = DateTime.fromISO(startAt, { zone: member.timezone });
      if (!startAtDt.isValid) return c.json({ error: 'invalid startAt' }, 400);
    }

    const newId = await detachOccurrence(recordCtx(member), c.req.param('id'), occurrence, {
      ...definedOnly(rest),
      ...(startAtDt !== undefined ? { startAt: startAtDt } : {}),
    });
    return newId ? c.json({ ok: true, id: newId }, 201) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/events/:id', async (c) => {
    const ok = await deleteEvent(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/transactions', async (c) => {
    const member = c.get('member');
    const month = c.req.query('month') ?? DateTime.now().setZone(member.timezone).toFormat('yyyy-MM');
    const start = DateTime.fromFormat(month, 'yyyy-MM', { zone: member.timezone });
    if (!start.isValid) return c.json({ error: 'month must be YYYY-MM' }, 400);

    const rows = await deps.prisma.transaction.findMany({
      where: {
        familyId: member.familyId,
        occurredAt: { gte: start.toJSDate(), lte: start.endOf('month').toJSDate() },
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
      include: {
        category: { select: { name: true } },
        paidBy: { select: { displayName: true } },
      },
    });

    return c.json({
      items: rows.map((t) => ({
        id: t.id,
        amountSatang: t.amount,
        direction: t.direction,
        categoryName: t.category?.name ?? null,
        note: t.note,
        occurredAt: t.occurredAt.toISOString(),
        paidBy: t.paidBy?.displayName ?? null,
      })),
    });
  });

  app.patch('/transactions/:id', async (c) => {
    const member = c.get('member');
    const parsed = transactionPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { amountBaht, occurredAt, ...rest } = parsed.data;
    let occurredAtDt: DateTime | undefined;
    if (occurredAt !== undefined) {
      occurredAtDt = DateTime.fromISO(occurredAt, { zone: member.timezone });
      if (!occurredAtDt.isValid) return c.json({ error: 'invalid occurredAt' }, 400);
    }

    const ok = await updateTransaction(recordCtx(member), c.req.param('id'), {
      ...definedOnly(rest),
      ...(amountBaht !== undefined ? { amount: Math.round(amountBaht * 100) } : {}),
      ...(occurredAtDt !== undefined ? { occurredAt: occurredAtDt } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/transactions/:id', async (c) => {
    const ok = await deleteTransaction(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/bills', async (c) => {
    const member = c.get('member');
    const rows = await deps.prisma.bill.findMany({
      where: { familyId: member.familyId },
      orderBy: { dueDay: 'asc' },
    });

    return c.json({
      items: rows.map((b) => ({
        id: b.id,
        name: b.name,
        amountSatang: b.amount,
        dueDay: b.dueDay,
        active: b.active,
      })),
    });
  });

  app.post('/bills', async (c) => {
    const member = c.get('member');
    const parsed = billBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = DateTime.now().setZone(member.timezone);
    const result = await persistDraft(
      {
        kind: 'bill',
        name: parsed.data.name,
        dueDay: parsed.data.dueDay,
        ...(parsed.data.amountBaht !== undefined
          ? { amount: Math.round(parsed.data.amountBaht * 100) }
          : {}),
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.patch('/bills/:id', async (c) => {
    const parsed = billPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { amountBaht, ...rest } = parsed.data;
    const ok = await updateBill(recordCtx(c.get('member')), c.req.param('id'), {
      ...definedOnly(rest),
      ...(amountBaht !== undefined
        ? { amount: amountBaht === null ? null : Math.round(amountBaht * 100) }
        : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/bills/:id', async (c) => {
    const ok = await deleteBill(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/documents', async (c) => {
    const member = c.get('member');
    const rows = await deps.prisma.document.findMany({
      where: { familyId: member.familyId },
      orderBy: { expiresAt: 'asc' },
      include: { owner: { select: { displayName: true } } },
    });

    return c.json({
      items: rows.map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        expiresAt: d.expiresAt.toISOString(),
        owner: d.owner?.displayName ?? null,
      })),
    });
  });

  app.post('/documents', async (c) => {
    const member = c.get('member');
    const parsed = documentBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const expiresAt = DateTime.fromISO(parsed.data.expiresAt, { zone: member.timezone });
    if (!expiresAt.isValid) return c.json({ error: 'invalid expiresAt' }, 400);

    const now = DateTime.now().setZone(member.timezone);
    const result = await persistDraft(
      { kind: 'document', name: parsed.data.name, type: parsed.data.type, expiresAt },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.patch('/documents/:id', async (c) => {
    const member = c.get('member');
    const parsed = documentPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { expiresAt, ...rest } = parsed.data;
    let expiresAtDt: DateTime | undefined;
    if (expiresAt !== undefined) {
      expiresAtDt = DateTime.fromISO(expiresAt, { zone: member.timezone });
      if (!expiresAtDt.isValid) return c.json({ error: 'invalid expiresAt' }, 400);
    }

    const ok = await updateDocument(recordCtx(member), c.req.param('id'), {
      ...definedOnly(rest),
      ...(expiresAtDt !== undefined ? { expiresAt: expiresAtDt } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/documents/:id', async (c) => {
    const ok = await deleteDocument(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/medications', async (c) => {
    const member = c.get('member');
    const rows = await deps.prisma.medication.findMany({
      where: { member: { familyId: member.familyId } },
      include: { member: { select: { displayName: true } } },
    });

    return c.json({
      items: rows.map((m) => ({
        id: m.id,
        name: m.name,
        dosage: m.dosage,
        times: m.times,
        active: m.active,
        owner: m.member.displayName,
      })),
    });
  });

  app.post('/medications', async (c) => {
    const member = c.get('member');
    const parsed = medicationBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = DateTime.now().setZone(member.timezone);
    const result = await persistDraft(
      {
        kind: 'med',
        name: parsed.data.name,
        times: parsed.data.times,
        ...(parsed.data.dosage !== undefined ? { dosage: parsed.data.dosage } : {}),
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.patch('/medications/:id', async (c) => {
    const parsed = medicationPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const ok = await updateMedication(
      recordCtx(c.get('member')),
      c.req.param('id'),
      definedOnly(parsed.data),
    );
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/medications/:id', async (c) => {
    const ok = await deleteMedication(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/chores', async (c) => {
    const member = c.get('member');
    const rows = await deps.prisma.chore.findMany({
      where: { familyId: member.familyId },
      orderBy: { nextDueAt: 'asc' },
    });

    const memberNames = new Map(
      (
        await deps.prisma.member.findMany({
          where: { familyId: member.familyId },
          select: { id: true, displayName: true },
        })
      ).map((m) => [m.id, m.displayName]),
    );

    return c.json({
      items: rows.map((ch) => ({
        id: ch.id,
        name: ch.name,
        cadence: ch.cadence,
        active: ch.active,
        nextDueAt: ch.nextDueAt.toISOString(),
        nextAssignee:
          ch.rotationMemberIds.length > 0
            ? (memberNames.get(
                ch.rotationMemberIds[ch.rotationCursor % ch.rotationMemberIds.length] as string,
              ) ?? null)
            : null,
        // Listed from whoever is up next, so the edit form can show the
        // rotation the way the family thinks about it — and saving it
        // unchanged keeps the turn where it is.
        rotationNames: ch.rotationMemberIds.map(
          (_, i, ids) =>
            memberNames.get(ids[(ch.rotationCursor + i) % ids.length] as string) ?? '?',
        ),
      })),
    });
  });

  app.post('/chores', async (c) => {
    const member = c.get('member');
    const parsed = choreBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = DateTime.now().setZone(member.timezone);
    const result = await persistDraft(
      {
        kind: 'chore',
        name: parsed.data.name,
        cadence: parsed.data.cadence,
        rotationNames: parsed.data.rotationNames,
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.patch('/chores/:id', async (c) => {
    const member = c.get('member');
    const parsed = chorePatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { rotationNames, ...rest } = parsed.data;
    let rotationMemberIds: string[] | undefined;
    if (rotationNames !== undefined) {
      const resolved = await resolveRotation(deps.prisma, member.familyId, rotationNames);
      // Refuse rather than drop: a silently shortened rotation would quietly
      // take someone's turn away.
      if (resolved.unresolved.length > 0) {
        return c.json({ error: `ไม่พบชื่อในบ้าน: ${resolved.unresolved.join(', ')}` }, 400);
      }
      rotationMemberIds = resolved.memberIds;
    }

    const ok = await updateChore(recordCtx(member), c.req.param('id'), {
      ...definedOnly(rest),
      ...(rotationMemberIds !== undefined ? { rotationMemberIds } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/chores/:id', async (c) => {
    const ok = await deleteChore(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/loans/:id', async (c) => {
    const member = c.get('member');
    const parsed = loanPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { principalAmountBaht, repaidAmountBaht, dueAt, ...rest } = parsed.data;
    let dueAtDt: DateTime | null | undefined;
    if (dueAt !== undefined) {
      if (dueAt === null) dueAtDt = null;
      else {
        dueAtDt = DateTime.fromISO(dueAt, { zone: member.timezone });
        if (!dueAtDt.isValid) return c.json({ error: 'invalid dueAt' }, 400);
      }
    }

    const ok = await updateLoan(recordCtx(member), c.req.param('id'), {
      ...definedOnly(rest),
      ...(principalAmountBaht !== undefined
        ? { principalSatang: Math.round(principalAmountBaht * 100) }
        : {}),
      ...(repaidAmountBaht !== undefined
        ? { repaidSatang: Math.round(repaidAmountBaht * 100) }
        : {}),
      ...(dueAtDt !== undefined ? { dueAt: dueAtDt } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/loans/:id', async (c) => {
    const ok = await deleteLoan(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/assets/:id', async (c) => {
    const parsed = assetPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { valueBaht, acquiredAt, ...rest } = parsed.data;
    let acquiredAtDt: DateTime | null | undefined;
    if (acquiredAt !== undefined) {
      if (acquiredAt === null) acquiredAtDt = null;
      else {
        // Date-only column: parsed as UTC so the stored day never shifts.
        acquiredAtDt = DateTime.fromISO(acquiredAt, { zone: 'utc' });
        if (!acquiredAtDt.isValid) return c.json({ error: 'invalid acquiredAt' }, 400);
      }
    }

    const ok = await updateAsset(recordCtx(c.get('member')), c.req.param('id'), {
      ...definedOnly(rest),
      ...(valueBaht !== undefined ? { valueSatang: Math.round(valueBaht * 100) } : {}),
      ...(acquiredAtDt !== undefined ? { acquiredAt: acquiredAtDt } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/assets/:id', async (c) => {
    const ok = await deleteAsset(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.patch('/deposits/:id', async (c) => {
    const parsed = depositPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { balanceBaht, ...rest } = parsed.data;
    const ok = await updateDeposit(recordCtx(c.get('member')), c.req.param('id'), {
      ...definedOnly(rest),
      ...(balanceBaht !== undefined ? { balanceSatang: Math.round(balanceBaht * 100) } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/deposits/:id', async (c) => {
    const ok = await deleteDeposit(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/shopping/:id', async (c) => {
    const ok = await deleteShoppingItem(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  // -------------------------------------------------------------- task board

  app.get('/tasks', async (c) => {
    const member = c.get('member');
    const now = DateTime.now().setZone(member.timezone);

    const rows = await deps.prisma.task.findMany({
      where: {
        familyId: member.familyId,
        // Finished cards pile up forever otherwise; the board only needs the
        // recent ones to show what got done.
        OR: [
          { status: { in: ['TODO', 'DOING'] } },
          { status: 'DONE', doneAt: { gte: now.minus({ days: 14 }).toJSDate() } },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      include: { assignee: { select: { displayName: true } } },
    });

    return c.json({
      items: rows.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignee: t.assignee?.displayName ?? null,
        dueAt: t.dueAt ? t.dueAt.toISOString() : null,
        note: t.note,
        doneAt: t.doneAt ? t.doneAt.toISOString() : null,
        sortOrder: t.sortOrder,
      })),
    });
  });

  app.post('/tasks', async (c) => {
    const member = c.get('member');
    const parsed = taskBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const now = DateTime.now().setZone(member.timezone);
    let dueAt: DateTime | undefined;
    if (parsed.data.dueAt !== undefined) {
      dueAt = DateTime.fromISO(parsed.data.dueAt, { zone: member.timezone });
      if (!dueAt.isValid) return c.json({ error: 'invalid dueAt' }, 400);
    }

    const result = await persistDraft(
      {
        kind: 'task',
        title: parsed.data.title,
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(parsed.data.assigneeName !== undefined
          ? { assigneeName: parsed.data.assigneeName }
          : {}),
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      },
      { prisma: deps.prisma, familyId: member.familyId, memberId: member.memberId, now },
    );

    return c.json(result, 201);
  });

  app.patch('/tasks/:id', async (c) => {
    const member = c.get('member');
    const parsed = taskPatchBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

    const { dueAt, ...rest } = parsed.data;
    let dueAtDt: DateTime | null | undefined;
    if (dueAt !== undefined) {
      if (dueAt === null) dueAtDt = null;
      else {
        dueAtDt = DateTime.fromISO(dueAt, { zone: member.timezone });
        if (!dueAtDt.isValid) return c.json({ error: 'invalid dueAt' }, 400);
      }
    }

    const ok = await updateTask(recordCtx(member), c.req.param('id'), {
      ...definedOnly(rest),
      ...(dueAtDt !== undefined ? { dueAt: dueAtDt } : {}),
    });
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.delete('/tasks/:id', async (c) => {
    const ok = await deleteTask(recordCtx(c.get('member')), c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  return app;
}
