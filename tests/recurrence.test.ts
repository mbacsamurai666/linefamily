import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { matchRecurrence, recurrenceLabel } from '../src/thai/recurrence.js';
import { holidayOn, isNonWorkingDay, nextBusinessDay } from '../src/thai/holidays.js';
import { parseThaiDateTime } from '../src/thai/date.js';

describe('Thai repeat phrases', () => {
  it.each([
    ['ทุกวัน', 'FREQ=DAILY'],
    ['ทุกวันจันทร์', 'FREQ=WEEKLY;BYDAY=MO'],
    ['ทุกวันพฤหัสบดี', 'FREQ=WEEKLY;BYDAY=TH'],
    ['ทุกวันอาทิตย์', 'FREQ=WEEKLY;BYDAY=SU'],
    ['ทุกสัปดาห์', 'FREQ=WEEKLY'],
    ['ทุกเดือน', 'FREQ=MONTHLY'],
    ['ทุกวันที่ 15', 'FREQ=MONTHLY;BYMONTHDAY=15'],
    ['ทุกปี', 'FREQ=YEARLY'],
  ])('%s -> %s', (text, rrule) => {
    expect(matchRecurrence(text)?.rrule).toBe(rrule);
  });

  it('reads a bare "ทุกอาทิตย์" as every week, not every Sunday', () => {
    // The same trap thai/date.ts handles for "อาทิตย์หน้า".
    expect(matchRecurrence('ทุกอาทิตย์')?.rrule).toBe('FREQ=WEEKLY');
    expect(matchRecurrence('ทุกวันอาทิตย์')?.rrule).toBe('FREQ=WEEKLY;BYDAY=SU');
  });

  it('does not mistake a bill due day for a daily repeat', () => {
    expect(matchRecurrence('ทุกวันที่ 5')?.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=5');
  });

  it('leaves ordinary text alone', () => {
    expect(matchRecurrence('พรุ่งนี้บ่าย 3 หาหมอ')).toBeNull();
  });

  it('turns back into Thai for the confirm card', () => {
    expect(recurrenceLabel('FREQ=WEEKLY;BYDAY=MO')).toBe('ทุกวันจันทร์');
    expect(recurrenceLabel('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('ทุกวันที่ 15');
    expect(recurrenceLabel('FREQ=DAILY')).toBe('ทุกวัน');
  });
});

describe('Thai public holidays', () => {
  it('knows the dates that never move', () => {
    expect(holidayOn(DateTime.fromISO('2026-12-05'))).toBe('วันพ่อแห่งชาติ');
    expect(holidayOn(DateTime.fromISO('2026-04-13'))).toBe('วันสงกรานต์');
    expect(holidayOn(DateTime.fromISO('2026-01-01'))).toBe('วันขึ้นปีใหม่');
  });

  it('says nothing about an ordinary day', () => {
    expect(holidayOn(DateTime.fromISO('2026-09-15'))).toBeNull();
  });

  it('counts weekends as non-working without calling them holidays', () => {
    const saturday = DateTime.fromISO('2026-09-12');
    expect(saturday.weekday).toBe(6);
    expect(isNonWorkingDay(saturday)).toBe(true);
    expect(holidayOn(saturday)).toBeNull();
  });

  it('skips the weekend to the next open day', () => {
    // Friday 11 Sep 2026 -> Monday 14 Sep
    const next = nextBusinessDay(DateTime.fromISO('2026-09-11'));
    expect(next.toFormat('yyyy-MM-dd')).toBe('2026-09-14');
  });

  it('skips a holiday that lands on a weekday', () => {
    // Thu 10 Dec 2026 is วันรัฐธรรมนูญ, so Wed 9th rolls to Fri 11th.
    const next = nextBusinessDay(DateTime.fromISO('2026-12-09'));
    expect(next.toFormat('yyyy-MM-dd')).toBe('2026-12-11');
  });

  it('is reachable from chat as "วันทำการถัดไป"', () => {
    const friday = DateTime.fromISO('2026-09-11T10:00', { zone: 'Asia/Bangkok' });
    const when = parseThaiDateTime('ยื่นเอกสาร วันทำการถัดไป', friday);
    expect(when?.start.toFormat('yyyy-MM-dd')).toBe('2026-09-14');
  });
});
