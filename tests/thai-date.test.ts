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
