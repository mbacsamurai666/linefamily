import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { PrismaClient } from '@prisma/client';
import { buildFamilyIcs } from '../src/modules/ics.js';

const ZONE = 'Asia/Bangkok';
const NOW = DateTime.fromISO('2026-09-24T10:00', { zone: ZONE });

/** Just the two reads buildFamilyIcs makes. */
function fakePrisma(events: unknown[]): PrismaClient {
  return {
    family: { findUniqueOrThrow: async () => ({ timezone: ZONE }) },
    event: { findMany: async () => events },
  } as unknown as PrismaClient;
}

const event = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  title: 'สอบปลายภาค',
  category: 'SCHOOL',
  startAt: DateTime.fromISO('2026-09-25T09:00', { zone: ZONE }).toJSDate(),
  endAt: null,
  allDay: false,
  location: null,
  note: null,
  rrule: null,
  exdates: [],
  attendees: [],
  ...over,
});

describe('buildFamilyIcs', () => {
  it('writes a timed appointment as an instant, with its kind and place', async () => {
    const ics = await buildFamilyIcs(fakePrisma([event({ location: 'โรงเรียน' })]), 'f', NOW);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('UID:e1@familys-management');
    expect(ics).toContain('DTSTART:20260925T020000Z'); // 09:00 in Bangkok
    expect(ics).toContain('DTEND:20260925T030000Z'); // an hour, for want of one
    expect(ics).toContain('SUMMARY:สอบปลายภาค');
    expect(ics).toContain('CATEGORIES:โรงเรียน');
    expect(ics).toContain('LOCATION:โรงเรียน');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('ends an all-day span the day after its last, as iCalendar counts it', async () => {
    const ics = await buildFamilyIcs(
      fakePrisma([
        event({
          title: 'เที่ยวจูไห่',
          allDay: true,
          startAt: DateTime.fromISO('2026-10-01T00:00', { zone: ZONE }).toJSDate(),
          endAt: DateTime.fromISO('2026-10-07T00:00', { zone: ZONE }).toJSDate(),
        }),
      ]),
      'f',
      NOW,
    );
    expect(ics).toContain('DTSTART;VALUE=DATE:20261001');
    expect(ics).toContain('DTEND;VALUE=DATE:20261008');
  });

  it('hands over a repeat as its rule, with the dates skipped', async () => {
    const ics = await buildFamilyIcs(
      fakePrisma([
        event({
          title: 'กายภาพแม่',
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          exdates: [DateTime.fromISO('2026-09-28T09:00', { zone: ZONE }).toJSDate()],
        }),
      ]),
      'f',
      NOW,
    );
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
    expect(ics).toContain('EXDATE:20260928T020000Z');
  });

  it('escapes what iCalendar reads as punctuation, and folds a long line', async () => {
    // Folding splits long lines, continuing them with a space; a reader joins them back up.
    const unfold = (text: string) => text.replace(new RegExp(`${String.fromCharCode(13, 10)} `, 'g'), '');
    const ics = await buildFamilyIcs(
      fakePrisma([event({ title: 'ซื้อของ, จ่ายบิล; แล้วกลับบ้าน', note: 'ดินสอ\nยางลบ' })]),
      'f',
      NOW,
    );
    expect(unfold(ics)).toContain(`SUMMARY:ซื้อของ\\, จ่ายบิล\\; แล้วกลับบ้าน`);
    expect(unfold(ics)).toContain(`DESCRIPTION:ดินสอ\\nยางลบ`);
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
  });
});
