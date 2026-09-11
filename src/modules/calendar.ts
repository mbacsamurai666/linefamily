import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { expandOccurrences } from '../reminders/occurrences.js';
import { holidayOn } from '../thai/holidays.js';

/**
 * What the calendar board draws: appointments on the day they actually happen,
 * and the public holidays around them.
 *
 * The month grid used to plot NotificationJob rows, which are *reminder* times —
 * an appointment on the 20th put dots on the 13th, the 19th and the 20th, and
 * nothing at all once its reminders had gone out. Events are read directly
 * here, and a repeating one appears on every day it repeats, not only the day
 * it was first entered.
 */

/** A 6-week month grid is 42 days; a little slack for the timezone edges. */
export const MAX_RANGE_DAYS = 45;

/** Enough for a daily repeat across the widest range, and no more. */
const MAX_OCCURRENCES_PER_EVENT = MAX_RANGE_DAYS + 1;

export interface CalendarEntry {
  /** The Event id — the same for every occurrence of a repeating appointment. */
  id: string;
  title: string;
  category: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  location: string | null;
  repeats: boolean;
}

export interface CalendarHoliday {
  /** "yyyy-MM-dd" in the family's zone. */
  date: string;
  name: string;
}

export async function listCalendar(
  prisma: PrismaClient,
  familyId: string,
  from: DateTime,
  to: DateTime,
  zone: string,
): Promise<{ items: CalendarEntry[]; holidays: CalendarHoliday[] }> {
  const events = await prisma.event.findMany({
    where: {
      familyId,
      OR: [
        { startAt: { gte: from.toJSDate(), lte: to.toJSDate() } },
        // A repeating appointment first entered months ago still lands here.
        { rrule: { not: null }, startAt: { lt: from.toJSDate() } },
      ],
    },
    orderBy: { startAt: 'asc' },
    take: 300,
  });

  const items: CalendarEntry[] = [];

  for (const event of events) {
    const base = {
      id: event.id,
      title: event.title,
      category: event.category,
      allDay: event.allDay,
      location: event.location,
      repeats: event.rrule !== null,
    };
    const durationMs = event.endAt ? event.endAt.getTime() - event.startAt.getTime() : null;

    let starts: DateTime[];
    if (!event.rrule) {
      starts = [DateTime.fromJSDate(event.startAt, { zone })];
    } else {
      try {
        starts = expandOccurrences(
          event.startAt,
          event.rrule,
          zone,
          from,
          to,
          MAX_OCCURRENCES_PER_EVENT,
        );
      } catch {
        // A malformed rule still shows the appointment it belongs to.
        starts = [DateTime.fromJSDate(event.startAt, { zone })];
      }
    }

    for (const start of starts) {
      if (start < from || start > to) continue;
      items.push({
        ...base,
        startAt: start.toUTC().toISO() ?? '',
        endAt: durationMs === null ? null : start.plus({ milliseconds: durationMs }).toUTC().toISO(),
      });
    }
  }

  items.sort((a, b) => a.startAt.localeCompare(b.startAt));

  const holidays: CalendarHoliday[] = [];
  const lastDay = to.setZone(zone).startOf('day');
  for (let day = from.setZone(zone).startOf('day'); day <= lastDay; day = day.plus({ days: 1 })) {
    const name = holidayOn(day);
    if (name) holidays.push({ date: day.toFormat('yyyy-MM-dd'), name });
  }

  return { items, holidays };
}
