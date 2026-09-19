import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { boardText, renderDigestImage } from '../src/line/digestImage.js';
import type { JobKind, ReminderJob } from '../src/reminders/ports.js';

const ZONE = 'Asia/Bangkok';
const MORNING = DateTime.fromISO('2026-09-12T07:00', { zone: ZONE });
const EVENING = DateTime.fromISO('2026-09-12T20:00', { zone: ZONE });

function job(kind: JobKind, text: string, i = 0): ReminderJob {
  return {
    id: `${kind}-${i}`,
    familyId: 'fam',
    kind,
    refId: 'ref',
    dueAt: MORNING.toJSDate(),
    lane: 'DIGEST',
    payload: { text },
  };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** PNG carries its pixel size in the IHDR chunk, right after the magic. */
function size(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('the digest picture', () => {
  it('draws a PNG the group can actually load', async () => {
    const png = await renderDigestImage({
      jobs: [job('EVENT', '[หมอ] พาแม่ไปหาหมอ พฤ. 17 ก.ย. 69 15:00 น. (วันนี้) — แม่ @ ศิริราช')],
      slot: MORNING,
    });

    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(size(png).width).toBe(1040);
    // LINE rejects an image message over 10MB; this is nowhere near it.
    expect(png.length).toBeLessThan(1_000_000);
  });

  it('grows with the list rather than cutting it off mid-board', async () => {
    const few = await renderDigestImage({ jobs: [job('BILL', 'ค่าไฟ 800 บาท')], slot: MORNING });
    const many = await renderDigestImage({
      jobs: Array.from({ length: 6 }, (_, i) => job('EVENT', `นัดที่ ${i + 1}`, i)),
      slot: MORNING,
    });

    expect(size(many).height).toBeGreaterThan(size(few).height);
  });

  it('stops growing for a day with far too much on it', async () => {
    const png = await renderDigestImage({
      jobs: Array.from({ length: 40 }, (_, i) => job('TASK', `งานที่ ${i + 1}`, i)),
      slot: MORNING,
    });

    // Eighteen lines of board, however many jobs there were.
    expect(size(png).height).toBeLessThan(1700);
  });

  it('draws the empty day without falling over', async () => {
    const png = await renderDigestImage({ jobs: [], slot: EVENING });
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
  });

  it('is a different picture in the evening — the mascots are asleep by then', async () => {
    const jobs = [job('CHORE', 'ล้างจาน วันนี้ — ตาของพ่อ')];
    const morning = await renderDigestImage({ jobs, slot: MORNING });
    const evening = await renderDigestImage({ jobs, slot: EVENING });

    expect(morning.equals(evening)).toBe(false);
  });
});

describe('boardText', () => {
  it('leaves out emoji the board font cannot draw', () => {
    expect(boardText('สอบว่ายน้ำ ❌ห้ามลืม❌ — Yui💋')).toBe('สอบว่ายน้ำ ห้ามลืม — Yui');
    expect(boardText('ซ่อมบ้าน คุณพิษณุ')).toBe('ซ่อมบ้าน คุณพิษณุ');
  });
});
