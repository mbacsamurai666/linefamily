import type { EventSummary } from './api.js';

export interface SpanBar {
  ev: EventSummary;
  /** Column this week's piece runs from, and to, both inclusive (0 = Sunday). */
  from: number;
  to: number;
  isStart: boolean;
  isEnd: boolean;
  /** Which row of bars it sits on, so two overlapping trips do not collide. */
  lane: number;
}

/**
 * The pieces of each multi-day appointment that fall in one week of the board,
 * stacked into lanes. A trip crossing a Sunday is two pieces, one per row —
 * which is how a wall calendar draws it too.
 */
export function weekSpans(
  week: Array<{ key: string } | null>,
  spans: Array<{ ev: EventSummary; days: string[] }>,
): SpanBar[] {
  const bars: SpanBar[] = [];
  const taken: string[][] = [];

  for (const { ev, days } of spans) {
    const first = days[0] as string;
    const last = days[days.length - 1] as string;
    const columns = week.map((cell) => (cell && cell.key >= first && cell.key <= last ? cell.key : null));
    const from = columns.findIndex(Boolean);
    if (from === -1) continue;
    let to = from;
    for (let i = from; i < columns.length; i++) if (columns[i]) to = i;

    // First free lane that has room for every column this piece covers.
    let lane = 0;
    while (taken[lane]?.some((_, i) => i >= from && i <= to && taken[lane]?.[i])) lane += 1;
    const row = taken[lane] ?? (taken[lane] = []);
    for (let i = from; i <= to; i++) row[i] = ev.id;

    bars.push({ ev, from, to, isStart: columns[from] === first, isEnd: columns[to] === last, lane });
  }
  return bars;
}
