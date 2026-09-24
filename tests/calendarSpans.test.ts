import { describe, expect, it } from 'vitest';
import { weekSpans } from '../liff/src/spans.js';
import type { EventSummary } from '../liff/src/api.js';

/**
 * A trip is one bar across the days it covers, the way a wall calendar draws
 * it — not one chip per day, which is what the family was looking at.
 */

const ev = (id: string, title: string): EventSummary => ({
  id,
  title,
  category: 'TRAVEL',
  startAt: '',
  endAt: null,
  allDay: true,
  location: null,
  repeats: false,
});

/** A week of the October 2026 board: Sun 4 Oct … Sat 10 Oct. */
const week = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'].map(
  (key) => ({ key }),
);

const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

describe('weekSpans', () => {
  it('runs a trip straight across the days it covers', () => {
    const [bar] = weekSpans(week, [{ ev: ev('trip', 'เที่ยวจูไห่'), days: days('2026-10-05', '2026-10-08') }]);
    expect(bar).toMatchObject({ from: 1, to: 4, isStart: true, isEnd: true, lane: 0 });
  });

  it('cuts a longer trip at the week it crosses into', () => {
    const [bar] = weekSpans(week, [{ ev: ev('term', 'ปิดภาคเรียน'), days: days('2026-10-01', '2026-10-25') }]);
    // The whole row, open at both ends.
    expect(bar).toMatchObject({ from: 0, to: 6, isStart: false, isEnd: false });
  });

  it('stacks trips that overlap, and reuses a lane once one has ended', () => {
    const bars = weekSpans(week, [
      { ev: ev('a', 'ทริป A'), days: days('2026-10-04', '2026-10-06') },
      { ev: ev('b', 'ทริป B'), days: days('2026-10-05', '2026-10-08') },
      { ev: ev('c', 'ทริป C'), days: days('2026-10-08', '2026-10-10') },
    ]);
    expect(bars.map((b) => [b.ev.id, b.from, b.to, b.lane])).toEqual([
      ['a', 0, 2, 0],
      ['b', 1, 4, 1],
      ['c', 4, 6, 0],
    ]);
  });

  it('leaves out a trip that is not in this week at all', () => {
    expect(weekSpans(week, [{ ev: ev('x', 'ค่าย'), days: days('2026-10-12', '2026-10-14') }])).toEqual([]);
  });
});
