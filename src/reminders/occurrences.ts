import { DateTime } from 'luxon';
// rrule ships CommonJS, so Node's ESM loader cannot see its named exports —
// a named import typechecks and then throws at boot. The default import is
// the whole module.exports.
import rrulePkg from 'rrule';

const { rrulestr } = rrulePkg;

/**
 * The occurrences of a repeating appointment between `from` and `to`.
 *
 * rrule evaluates BYDAY and BYMONTHDAY against the UTC calendar. Bangkok is
 * UTC+7, so anything before 07:00 local sits on the *previous* UTC day — and
 * "ทุกวันจันทร์ 6 โมงเช้า" came out as every Tuesday. The library's documented
 * way round this is floating time: hand it the family's wall-clock time dressed
 * up as UTC, expand, then read each result back as wall time in the real zone.
 *
 * Throws on a malformed rule; callers decide what a broken rule should mean.
 */
export function expandOccurrences(
  startAt: Date,
  rrule: string,
  zone: string,
  from: DateTime,
  to: DateTime,
  max: number,
): DateTime[] {
  const rule = rrulestr(`RRULE:${rrule}`, {
    dtstart: floating(DateTime.fromJSDate(startAt, { zone })),
  });

  return rule
    .between(floating(from.setZone(zone)), floating(to.setZone(zone)), true)
    .slice(0, max)
    .map((d) => unfloat(d, zone));
}

function floating(dt: DateTime): Date {
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second));
}

function unfloat(d: Date, zone: string): DateTime {
  return DateTime.fromObject(
    {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    },
    { zone },
  );
}
