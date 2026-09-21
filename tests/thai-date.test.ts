import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { parseThaiDateTime, stripMatched, toGregorianYear } from '../src/thai/date.js';
import {
  COMBINED,
  DATE_ONLY,
  NO_MATCH,
  NOW_ISO,
  TIME_ONLY,
  type DateTimeFixture,
} from './fixtures/thai-datetime.fixtures.js';

const NOW = DateTime.fromISO(NOW_ISO, { zone: 'Asia/Bangkok' });

function label(f: DateTimeFixture): string {
  return f.note ? `${f.input}  (${f.note})` : f.input;
}

function run(f: DateTimeFixture) {
  const result = parseThaiDateTime(f.input, NOW);

  if (f.expect === null) {
    expect(result, `expected no date/time in "${f.input}"`).toBeNull();
    return;
  }

  expect(result, `expected a match in "${f.input}"`).not.toBeNull();
  const hit = result!;

  expect(hit.start.toFormat("yyyy-MM-dd'T'HH:mm")).toBe(f.expect);

  if (f.allDay !== undefined) expect(hit.allDay).toBe(f.allDay);
  if (f.title !== undefined) expect(stripMatched(f.input, hit.matched)).toBe(f.title);
}

describe('parseThaiDateTime', () => {
  it('anchors on a Friday, which several weekday fixtures depend on', () => {
    expect(NOW.weekday).toBe(5);
    expect(NOW.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-09-04 10:00');
  });

  describe('dates without a time', () => {
    for (const f of DATE_ONLY) it(label(f), () => run(f));
  });

  describe('times without a date', () => {
    for (const f of TIME_ONLY) it(label(f), () => run(f));
  });

  describe('date and time together', () => {
    for (const f of COMBINED) it(label(f), () => run(f));
  });

  describe('messages that are not appointments', () => {
    for (const f of NO_MATCH) it(label(f), () => run(f));
  });

  describe('hasExplicitDate', () => {
    it('is true when a date word is actually named', () => {
      const hit = parseThaiDateTime('พรุ่งนี้บ่าย 3', NOW);
      expect(hit?.hasExplicitDate).toBe(true);
    });

    it('is true for a date-only match (no time)', () => {
      const hit = parseThaiDateTime('5 ก.ย.', NOW);
      expect(hit?.hasExplicitDate).toBe(true);
    });

    it('is false for a bare time with no date word at all', () => {
      const hit = parseThaiDateTime('บ่าย 3', NOW);
      expect(hit?.hasExplicitDate).toBe(false);
    });

    it('is false when the date word is misspelled and never actually matches', () => {
      const hit = parseThaiDateTime('พรุ้งนี้บ่าย 3', NOW);
      expect(hit?.hasExplicitDate).toBe(false);
    });
  });
});

describe('toGregorianYear', () => {
  it.each([
    [2569, 2026],
    [2026, 2026],
    [69, 2026],
    [26, 2026],
    [2600, 2057],
  ])('%i -> %i', (input, expected) => {
    expect(toGregorianYear(input)).toBe(expected);
  });
});

/** "เที่ยวจูไห่ 1-7 ต.ค." is one trip across seven days, not the 7th alone. */
describe('date spans', () => {
  const at = DateTime.fromISO('2026-09-21T10:00', { zone: 'Asia/Bangkok' });
  const span = (input: string) => {
    const hit = parseThaiDateTime(input, at);
    return hit && {
      start: hit.start.toFormat("yyyy-MM-dd'T'HH:mm"),
      end: hit.end?.toFormat("yyyy-MM-dd'T'HH:mm") ?? null,
      allDay: hit.allDay,
      title: stripMatched(input, hit.matched),
    };
  };

  it.each([
    ['เที่ยว จูไห 1-7 ต.ค.', '2026-10-01T00:00', '2026-10-07T00:00', 'เที่ยว จูไห'],
    ['เที่ยว จูไห 1 - 7 ตุลาคม 2569', '2026-10-01T00:00', '2026-10-07T00:00', 'เที่ยว จูไห'],
    ['ไปเที่ยว วันที่ 10-12 ต.ค.', '2026-10-10T00:00', '2026-10-12T00:00', 'ไปเที่ยว'],
    ['ค่ายลูก 28 ก.ย. - 3 ต.ค.', '2026-09-28T00:00', '2026-10-03T00:00', 'ค่ายลูก'],
    ['ปีใหม่ 30 ธ.ค. ถึง 2 ม.ค.', '2026-12-30T00:00', '2027-01-02T00:00', 'ปีใหม่'],
    ['ทริป 1-5 ก.ย.', '2027-09-01T00:00', '2027-09-05T00:00', 'ทริป'],
  ])('%s', (input, start, end, title) => {
    expect(span(input)).toEqual({ start, end, allDay: true, title });
  });

  it('keeps a time on the first day of a timed span', () => {
    expect(span('ประชุม 1-3 ต.ค. 09:00')).toEqual({
      start: '2026-10-01T09:00',
      end: '2026-10-03T09:00',
      allDay: false,
      title: 'ประชุม',
    });
  });

  it('leaves a single date alone', () => {
    expect(span('หาหมอ 5 ต.ค. 14:00')?.end).toBeNull();
  });

  it('refuses a span that ends before it starts', () => {
    expect(span('ทริป 7-1 ต.ค.')?.end ?? null).toBeNull();
  });
});
