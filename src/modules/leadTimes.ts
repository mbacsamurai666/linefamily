import type { PrismaClient } from '@prisma/client';
import type { DateTime } from 'luxon';
import {
  generateBillJobs,
  generateDocumentJobs,
  generateEventJobs,
  generateTaskJobs,
} from '../reminders/generate.js';

/**
 * How far ahead each kind of thing is reminded about. The family sets this
 * once per kind; every item carries its own copy in reminderOffsets, which is
 * what the job generators read.
 */

export const LEAD_KINDS = ['event', 'bill', 'document', 'task'] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];

export type LeadTimes = Record<LeadKind, number[]>;

export async function familyLeadTimes(prisma: PrismaClient, familyId: string): Promise<LeadTimes> {
  const f = await prisma.family.findUniqueOrThrow({
    where: { id: familyId },
    select: { eventLeadMinutes: true, billLeadMinutes: true, documentLeadMinutes: true, taskLeadMinutes: true },
  });
  return {
    event: f.eventLeadMinutes,
    bill: f.billLeadMinutes,
    document: f.documentLeadMinutes,
    task: f.taskLeadMinutes,
  };
}

/** Longest first — the order reminders come in, and the order they read in. */
export const normaliseLeads = (minutes: number[]) => [...new Set(minutes)].sort((a, b) => b - a);

/**
 * Save a kind's lead times and bring everything of that kind already on
 * record into line, so the change means the same for last month's
 * appointment as for tomorrow's.
 */
export async function applyLeadTimes(
  prisma: PrismaClient,
  familyId: string,
  kind: LeadKind,
  minutes: number[],
  now: DateTime,
): Promise<void> {
  const offsets = normaliseLeads(minutes);
  const at = now.toJSDate();

  switch (kind) {
    case 'event': {
      await prisma.family.update({ where: { id: familyId }, data: { eventLeadMinutes: offsets } });
      await prisma.event.updateMany({ where: { familyId }, data: { reminderOffsets: offsets } });
      // Past one-offs have nothing left to remind about; a repeating one might.
      const rows = await prisma.event.findMany({
        where: { familyId, OR: [{ startAt: { gte: at } }, { rrule: { not: null } }] },
        select: { id: true },
      });
      for (const r of rows) await generateEventJobs(prisma, r.id, now);
      return;
    }
    case 'bill': {
      await prisma.family.update({ where: { id: familyId }, data: { billLeadMinutes: offsets } });
      await prisma.bill.updateMany({ where: { familyId }, data: { reminderOffsets: offsets } });
      const rows = await prisma.bill.findMany({ where: { familyId, active: true }, select: { id: true } });
      for (const r of rows) await generateBillJobs(prisma, r.id, now);
      return;
    }
    case 'document': {
      await prisma.family.update({ where: { id: familyId }, data: { documentLeadMinutes: offsets } });
      await prisma.document.updateMany({ where: { familyId }, data: { reminderOffsets: offsets } });
      const rows = await prisma.document.findMany({
        where: { familyId, expiresAt: { gte: at } },
        select: { id: true },
      });
      for (const r of rows) await generateDocumentJobs(prisma, r.id, now);
      return;
    }
    case 'task': {
      await prisma.family.update({ where: { id: familyId }, data: { taskLeadMinutes: offsets } });
      await prisma.task.updateMany({ where: { familyId }, data: { reminderOffsets: offsets } });
      const rows = await prisma.task.findMany({
        where: { familyId, status: { not: 'DONE' }, dueAt: { not: null } },
        select: { id: true },
      });
      for (const r of rows) await generateTaskJobs(prisma, r.id, now);
      return;
    }
  }
}
