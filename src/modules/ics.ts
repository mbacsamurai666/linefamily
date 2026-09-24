import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { CATEGORY_LABEL, type EventCategory } from '../intent/categories.js';

/**
 * The family's appointments as an iCalendar feed, so the same calendar can be
 * subscribed to from Google Calendar or a phone's own calendar app.
 *
 * Read-only by design: the bot and the app remain the only places an
 * appointment is created or changed, and a subscribed calendar cannot write
 * back. Repeating appointments are handed over as their RRULE rather than
 * expanded, so a subscriber sees the rule the family actually set.
 */

/** RFC 5545 §3.1: lines are folded at 75 octets, continued with a space. */
function fold(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out: string[] = [];
  let current = '';
  for (const char of line) {
    // Fold on characters, not bytes, so a Thai letter is never cut in half.
    if (Buffer.byteLength(current + char, 'utf8') > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
    }
    current += char;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** RFC 5545 §3.3.11: backslash, semicolon, comma and newlines carry meaning. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

const stamp = (dt: DateTime) => dt.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
const dateOnly = (dt: DateTime) => dt.toFormat('yyyyLLdd');

export async function buildFamilyIcs(
  prisma: PrismaClient,
  familyId: string,
  now: DateTime,
): Promise<string> {
  const family = await prisma.family.findUniqueOrThrow({
    where: { id: familyId },
    select: { timezone: true },
  });
  const zone = family.timezone;

  // A year back is enough for anyone scrolling their phone's calendar; the
  // future is open, since a repeating appointment has no end.
  const events = await prisma.event.findMany({
    where: { familyId, OR: [{ startAt: { gte: now.minus({ years: 1 }).toJSDate() } }, { rrule: { not: null } }] },
    include: { attendees: { include: { member: { select: { displayName: true } } } } },
    orderBy: { startAt: 'asc' },
    take: 1000,
  });

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FamilysManagement//TH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText('ปฏิทินบ้านเรา')}`,
    `X-WR-TIMEZONE:${zone}`,
  ];

  for (const event of events) {
    const start = DateTime.fromJSDate(event.startAt, { zone });
    const end = event.endAt ? DateTime.fromJSDate(event.endAt, { zone }) : null;
    const who = event.attendees.map((a) => a.member.displayName);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.id}@familys-management`);
    lines.push(`DTSTAMP:${stamp(now)}`);

    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(start)}`);
      // DTEND is exclusive: a trip ending on the 7th runs until the 8th.
      lines.push(`DTEND;VALUE=DATE:${dateOnly((end ?? start).plus({ days: 1 }))}`);
    } else {
      lines.push(`DTSTART:${stamp(start)}`);
      lines.push(`DTEND:${stamp(end ?? start.plus({ hours: 1 }))}`);
    }

    if (event.rrule) lines.push(`RRULE:${event.rrule}`);
    if (event.exdates.length > 0) {
      const dates = event.exdates.map((d) => {
        const at = DateTime.fromJSDate(d, { zone });
        return event.allDay ? dateOnly(at) : stamp(at);
      });
      lines.push(event.allDay ? `EXDATE;VALUE=DATE:${dates.join(',')}` : `EXDATE:${dates.join(',')}`);
    }

    lines.push(`SUMMARY:${escapeText(event.title)}`);
    lines.push(`CATEGORIES:${escapeText(CATEGORY_LABEL[event.category as EventCategory] ?? '')}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);

    const description = [event.note, who.length > 0 ? `สำหรับ ${who.join(', ')}` : '']
      .filter(Boolean)
      .join('\n');
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);

    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
