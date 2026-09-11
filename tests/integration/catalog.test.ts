import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { createTestDb, type TestDb } from './harness.js';
import { COMMAND_CATALOG } from '../../src/intent/commandCatalog.js';
import { RuleIntentParser } from '../../src/intent/RuleIntentParser.js';
import { classifyCommand, tryDirectCommand } from '../../src/modules/commands.js';
import { generateMedicationJobs } from '../../src/reminders/generate.js';

/**
 * The promise behind the ChatGPT path: every phrase the model is taught must be
 * one the deterministic bot already understands, with the effect the catalog
 * claims. If an example here fails, the model would be teaching the family a
 * command that does nothing — fix the example or the handler, never the test.
 */

const ZONE = 'Asia/Bangkok';
const NOW = DateTime.fromISO('2026-09-11T10:00', { zone: ZONE }); // a Friday

let db: TestDb;
let familyId: string;
let memberId: string;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

/** A household with one of everything the examples refer to by name. */
beforeEach(async () => {
  await db.reset();
  const family = await db.prisma.family.create({ data: { lineGroupId: 'G_catalog', timezone: ZONE } });
  familyId = family.id;
  memberId = (
    await db.prisma.member.create({ data: { familyId, lineUserId: 'U_mom', displayName: 'แม่' } })
  ).id;
  const others = ['พ่อ', 'พี่เอ', 'น้องพร'];
  for (const [i, name] of others.entries()) {
    await db.prisma.member.create({ data: { familyId, lineUserId: `U_${i}`, displayName: name } });
  }

  const power = await db.prisma.category.create({ data: { familyId, name: 'ค่าไฟ', kind: 'OUT' } });
  await db.prisma.transaction.create({
    data: { familyId, amount: 80000, direction: 'OUT', categoryId: power.id, occurredAt: NOW.toJSDate() },
  });
  await db.prisma.event.create({
    data: {
      familyId,
      title: 'กายภาพแม่',
      category: 'MEDICAL',
      startAt: DateTime.fromISO('2026-08-31T09:00', { zone: ZONE }).toJSDate(),
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    },
  });
  await db.prisma.event.create({
    data: { familyId, title: 'หมอฟัน', startAt: NOW.plus({ days: 5 }).toJSDate() },
  });
  await db.prisma.bill.create({ data: { familyId, name: 'ค่าไฟ', dueDay: 5, amount: 80000 } });
  await db.prisma.bill.create({ data: { familyId, name: 'ค่าเน็ต', dueDay: 10 } });
  await db.prisma.task.create({ data: { familyId, title: 'โทรหาช่าง' } });
  await db.prisma.chore.create({
    data: {
      familyId,
      name: 'ล้างจาน',
      cadence: 'DAILY',
      rotationMemberIds: [memberId],
      nextDueAt: NOW.toJSDate(),
    },
  });
  await db.prisma.shoppingItem.create({ data: { familyId, name: 'นม' } });

  // A dose due five minutes before NOW, still waiting for "กินยาแล้ว".
  const med = await db.prisma.medication.create({
    data: { memberId, name: 'ยาความดัน', times: ['09:55'], escalateAfterMin: 45 },
  });
  await generateMedicationJobs(db.prisma, med.id, NOW.minus({ hours: 1 }), 1);
});

function ctx() {
  return { prisma: db.prisma, familyId, memberId, now: NOW };
}

const commands = COMMAND_CATALOG.filter((e) => e.effect !== 'record');
const records = COMMAND_CATALOG.filter((e) => e.effect === 'record');

describe('catalog commands the bot answers or acts on directly', () => {
  it.each(commands.map((e) => [e.example, e.effect] as const))(
    '"%s" is a %s command the bot carries out',
    async (example, effect) => {
      expect(classifyCommand(example)).toBe(effect);

      const result = await tryDirectCommand(example, ctx());
      expect(result, `the bot ignored "${example}"`).not.toBeNull();
      // Understood, and not "I couldn't find that" — the seeded household has
      // everything each example names.
      expect(result?.reply).not.toMatch(/ไม่พบ|ระบุ.*ด้วย|อ่าน.*ไม่ออก/);
    },
  );
});

describe('catalog records that go to a confirm card', () => {
  const parser = new RuleIntentParser();

  // Any draft will do: a rewritten record goes to its card whatever the rules'
  // confidence (webhook.ts tryRewrite), and the card is where it gets checked.
  it.each(records.map((e) => [e.example] as const))('"%s" becomes a draft', async (example) => {
    // Nothing may intercept it on the way: it has to reach the parser.
    expect(classifyCommand(example)).toBeNull();
    expect(await tryDirectCommand(example, ctx())).toBeNull();

    const result = await parser.parse(example, {
      familyId,
      timezone: ZONE,
      now: NOW,
      memberNames: ['แม่', 'พ่อ', 'พี่เอ', 'น้องพร'],
      categoryNames: ['ค่าไฟ', 'ค่าข้าว'],
    });
    expect(result.kind, `the parser could not read "${example}"`).not.toBe('unknown');
  });
});
