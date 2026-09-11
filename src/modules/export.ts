import type { PrismaClient } from '@prisma/client';

/**
 * Everything this family has told the bot, as one JSON file.
 *
 * The database is a free Supabase project: fine for a household, but the only
 * copy. A family that loses it loses every appointment, bill and record it
 * entered, and nothing about that is recoverable from the chat. This is the
 * copy they can keep.
 *
 * Two things are left out on purpose:
 *  - LINE user ids. They identify people outside this file, and the bot
 *    re-learns them the moment someone speaks in the group.
 *  - Reminder jobs and digest pictures: both are derived, and regenerate.
 */

export interface FamilyExport {
  exportedAt: string;
  format: number;
  [section: string]: unknown;
}

export async function exportFamily(
  prisma: PrismaClient,
  familyId: string,
  now: Date,
): Promise<FamilyExport> {
  const [
    family,
    members,
    categories,
    events,
    transactions,
    budgets,
    bills,
    documents,
    medications,
    chores,
    shopping,
    loans,
    assets,
    deposits,
  ] = await Promise.all([
    prisma.family.findUniqueOrThrow({
      where: { id: familyId },
      select: { timezone: true, createdAt: true },
    }),
    prisma.member.findMany({
      where: { familyId },
      select: {
        id: true,
        displayName: true,
        role: true,
        birthDate: true,
        bloodType: true,
        allergies: true,
        conditions: true,
      },
    }),
    prisma.category.findMany({ where: { familyId }, select: { id: true, name: true, kind: true } }),
    prisma.event.findMany({
      where: { familyId },
      include: { attendees: { include: { member: { select: { displayName: true } } } } },
    }),
    prisma.transaction.findMany({
      where: { familyId },
      include: {
        category: { select: { name: true } },
        paidBy: { select: { displayName: true } },
        splits: { include: { member: { select: { displayName: true } } } },
      },
    }),
    prisma.budget.findMany({ where: { familyId }, include: { category: { select: { name: true } } } }),
    prisma.bill.findMany({ where: { familyId } }),
    prisma.document.findMany({ where: { familyId } }),
    prisma.medication.findMany({
      where: { member: { familyId } },
      include: { member: { select: { displayName: true } } },
    }),
    prisma.chore.findMany({ where: { familyId } }),
    prisma.shoppingItem.findMany({ where: { familyId } }),
    prisma.loan.findMany({ where: { familyId } }),
    prisma.asset.findMany({ where: { familyId } }),
    prisma.deposit.findMany({ where: { familyId } }),
  ]);

  const nameById = new Map(members.map((m) => [m.id, m.displayName]));

  return {
    exportedAt: now.toISOString(),
    format: 1,
    family: { timezone: family.timezone, since: family.createdAt.toISOString() },
    members: members.map(({ id: _id, ...rest }) => rest),
    categories: categories.map(({ id: _id, ...rest }) => rest),
    events: events.map((e) => ({
      title: e.title,
      category: e.category,
      startAt: e.startAt.toISOString(),
      endAt: e.endAt?.toISOString() ?? null,
      allDay: e.allDay,
      location: e.location,
      note: e.note,
      rrule: e.rrule,
      exdates: e.exdates.map((d) => d.toISOString()),
      reminderOffsets: e.reminderOffsets,
      owner: e.ownerId ? (nameById.get(e.ownerId) ?? null) : null,
      attendees: e.attendees.map((a) => a.member.displayName),
    })),
    transactions: transactions.map((t) => ({
      amountSatang: t.amount,
      direction: t.direction,
      category: t.category?.name ?? null,
      paidBy: t.paidBy?.displayName ?? null,
      occurredAt: t.occurredAt.toISOString(),
      note: t.note,
      splits: t.splits.map((s) => ({ member: s.member.displayName, shareSatang: s.share })),
    })),
    budgets: budgets.map((b) => ({
      category: b.category.name,
      yearMonth: b.yearMonth,
      limitSatang: b.limitAmount,
    })),
    bills: bills.map((b) => ({
      name: b.name,
      amountSatang: b.amount,
      dueDay: b.dueDay,
      active: b.active,
      autoCreateTx: b.autoCreateTx,
    })),
    documents: documents.map((d) => ({
      name: d.name,
      type: d.type,
      expiresAt: d.expiresAt.toISOString(),
      owner: d.ownerId ? (nameById.get(d.ownerId) ?? null) : null,
    })),
    medications: medications.map((m) => ({
      name: m.name,
      dosage: m.dosage,
      times: m.times,
      active: m.active,
      owner: m.member.displayName,
    })),
    chores: chores.map((c) => ({
      name: c.name,
      cadence: c.cadence,
      active: c.active,
      nextDueAt: c.nextDueAt.toISOString(),
      rotation: c.rotationMemberIds.map((id) => nameById.get(id) ?? '?'),
      rotationCursor: c.rotationCursor,
    })),
    shopping: shopping.map((s) => ({
      name: s.name,
      qty: s.qty,
      boughtAt: s.boughtAt?.toISOString() ?? null,
    })),
    loans: loans.map((l) => ({
      borrowerName: l.borrowerName,
      principalSatang: l.principalSatang,
      repaidSatang: l.repaidSatang,
      lentAt: l.lentAt.toISOString(),
      dueAt: l.dueAt?.toISOString() ?? null,
      note: l.note,
      active: l.active,
    })),
    assets: assets.map((a) => ({
      name: a.name,
      category: a.category,
      valueSatang: a.valueSatang,
      acquiredAt: a.acquiredAt?.toISOString() ?? null,
      note: a.note,
      active: a.active,
    })),
    deposits: deposits.map((d) => ({
      name: d.name,
      balanceSatang: d.balanceSatang,
      note: d.note,
      active: d.active,
    })),
  };
}
