import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  amountOn,
  billOccurrences,
  isLumpy,
  splitEvenly,
  timesPerYear,
  toDateColumn,
  type BillShape,
} from '../src/modules/billOccurrences.js';

const ZONE = 'Asia/Bangkok';
const day = (iso: string) => DateTime.fromISO(iso, { zone: ZONE });
const bill = (over: Partial<BillShape> = {}): BillShape => ({
  id: 'b',
  amount: 100_000,
  estimateAmount: null,
  dueDay: 15,
  everyMonths: 1,
  dueMonth: null,
  frequency: 'MONTHLY',
  interval: 1,
  startsOn: null,
  endsOn: null,
  ...over,
});
const dates = (b: BillShape, from: string, to: string) =>
  billOccurrences(b, day(from), day(to), ZONE).map((o) => o.dueOn.toISODate());

describe('billOccurrences', () => {
  it('lays a monthly bill on its day every month', () => {
    expect(dates(bill(), '2026-01-01', '2026-04-30')).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
  });

  it('puts "the 31st" on the last day of a short month, leap years included', () => {
    const b = bill({ dueDay: 31 });
    expect(dates(b, '2027-01-01', '2027-04-30')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
    expect(dates(b, '2028-02-01', '2028-02-29')).toEqual(['2028-02-29']); // 2028 is a leap year
  });

  it('keeps a yearly premium in its own month, across the turn of a year', () => {
    const b = bill({ everyMonths: 12, dueMonth: 1, amount: 2_400_000 });
    expect(dates(b, '2026-06-01', '2028-06-01')).toEqual(['2027-01-15', '2028-01-15']);
  });

  it('counts a term twice a year from the month it starts', () => {
    const b = bill({ everyMonths: 6, dueMonth: 5, dueDay: 5 });
    expect(dates(b, '2026-01-01', '2026-12-31')).toEqual(['2026-05-05', '2026-11-05']);
  });

  it('counts an uneven cycle from its start date, not from January', () => {
    const b = bill({ everyMonths: 5, startsOn: toDateColumn(day('2026-03-10')), dueDay: 10 });
    expect(dates(b, '2026-01-01', '2027-06-30')).toEqual(['2026-03-10', '2026-08-10', '2027-01-10', '2027-06-10']);
  });

  it('steps weekly and daily from the first day, whatever window is asked for', () => {
    const weekly = bill({ frequency: 'WEEKLY', startsOn: toDateColumn(day('2026-09-07')) }); // a Monday
    expect(dates(weekly, '2026-09-20', '2026-10-06')).toEqual(['2026-09-21', '2026-09-28', '2026-10-05']);

    const everyThreeDays = bill({ frequency: 'DAILY', interval: 3, startsOn: toDateColumn(day('2026-09-01')) });
    expect(dates(everyThreeDays, '2026-09-05', '2026-09-12')).toEqual(['2026-09-07', '2026-09-10']);
  });

  it('puts a one-off on its day only', () => {
    const repair = bill({ frequency: 'ONCE', startsOn: toDateColumn(day('2026-10-12')) });
    expect(dates(repair, '2026-10-01', '2026-10-31')).toEqual(['2026-10-12']);
    expect(dates(repair, '2026-11-01', '2026-11-30')).toEqual([]);
  });

  it('stops at its end date and starts at its start date', () => {
    const loan = bill({ startsOn: toDateColumn(day('2026-03-01')), endsOn: toDateColumn(day('2026-05-31')) });
    expect(dates(loan, '2026-01-01', '2026-12-31')).toEqual(['2026-03-15', '2026-04-15', '2026-05-15']);
  });

  it('cannot run away on a bad interval', () => {
    const b = bill({ frequency: 'DAILY', interval: 0, startsOn: toDateColumn(day('2026-01-01')) });
    expect(dates(b, '2026-01-01', '2026-01-05')).toHaveLength(5);
  });
});

describe('amountOn', () => {
  it('takes the latest change on or before the day, else the bill’s own amount', () => {
    const tuition = bill({
      amount: 6_000_000,
      amounts: [
        { effectiveFrom: toDateColumn(day('2027-05-01')), amount: 6_500_000 },
        { effectiveFrom: toDateColumn(day('2028-05-01')), amount: 7_000_000 },
      ],
    });
    expect(amountOn(tuition, day('2026-11-05'), ZONE).amount).toBe(6_000_000);
    expect(amountOn(tuition, day('2027-05-01'), ZONE).amount).toBe(6_500_000);
    expect(amountOn(tuition, day('2029-01-01'), ZONE).amount).toBe(7_000_000);
  });

  it('falls back to an estimate, and says it is one', () => {
    expect(amountOn(bill({ amount: null, estimateAmount: 250_000 }), day('2026-01-01'), ZONE)).toEqual({
      amount: 250_000,
      estimated: true,
    });
    expect(amountOn(bill({ amount: null }), day('2026-01-01'), ZONE).amount).toBeNull();
  });
});

describe('reserve arithmetic', () => {
  it('splits a total into shares that add back up to the satang', () => {
    expect(splitEvenly(2_400_000, 12)).toEqual(Array(12).fill(200_000));
    const odd = splitEvenly(100_001, 12);
    expect(odd.reduce((a, b) => a + b, 0)).toBe(100_001);
    expect(Math.max(...odd) - Math.min(...odd)).toBeLessThanOrEqual(1);
  });

  it('knows which bills are saved up for and how often each comes', () => {
    expect(isLumpy(bill({ everyMonths: 12 }))).toBe(true);
    expect(isLumpy(bill({ frequency: 'ONCE' }))).toBe(true);
    expect(isLumpy(bill())).toBe(false);
    expect(isLumpy(bill({ frequency: 'WEEKLY' }))).toBe(false);
    expect(timesPerYear(bill({ everyMonths: 6 }))).toBe(2);
    expect(timesPerYear(bill({ frequency: 'WEEKLY', interval: 2 }))).toBe(26);
  });
});
