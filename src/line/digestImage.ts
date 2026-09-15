import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import type { DateTime } from 'luxon';
import type { JobKind, ReminderJob } from '../reminders/ports.js';
import { SECTION_LABEL, SECTION_ORDER } from './flex/digest.js';
import { FONTS, registerAppFonts } from './fonts.js';
import { formatThaiDate } from './format.js';

/**
 * The twice-daily digest, drawn as a picture.
 *
 * A wall of text in a family group is skimmed and forgotten; the same list on
 * the house's own board, with the two of them standing under it, gets looked
 * at. Same content, same palette as the LIFF app (liff/src/styles.css), so the
 * message in the chat and the page it opens are recognisably one thing.
 *
 * The text message still goes with it — an image alone shows up as "[รูปภาพ]"
 * in the phone's notification, which is exactly where the digest earns its
 * keep. See prisma-stores.ts.
 */

const WIDTH = 1040;
const PAD = 48;

const COLORS = {
  bg: '#fdeaf0',
  dot: '#ffffff',
  wood: '#b6804f',
  woodDark: '#8f6039',
  woodEdge: '#cf9c67',
  board: '#33503f',
  boardEdge: '#23382c',
  chalk: '#f4f7f4',
  chalkMuted: '#b9cbbe',
  brand: '#d6488b',
  text: '#4a3640',
  bubble: '#ffffff',
} as const;

/** A dot per kind, so the eye can tell a bill from a doctor's appointment. */
const KIND_COLOR: Record<JobKind, string> = {
  MEDICATION: '#f0857d',
  EVENT: '#6fb7ef',
  TASK: '#f5c86b',
  BILL: '#f2a25c',
  LOAN_DUE: '#c79bea',
  DOCUMENT: '#8fd0a5',
  CHORE: '#9fd4e8',
  BUDGET_ALERT: '#f0857d',
  MONTH_SUMMARY: '#d7c2f0',
  BIRTHDAY: '#f6a8c6',
};

const ASSETS = join(process.cwd(), 'assets');

/** An appointment coming up, already worded for the board: "พ. 16 ก.ย. 15:00". */
export interface UpcomingLine {
  when: string;
  title: string;
}

export interface DigestImageInput {
  jobs: ReminderJob[];
  /** The digest slot, in the family's zone — morning or evening decides the mood. */
  slot: DateTime;
  /**
   * The week ahead, shown on a day with nothing due so the daily digest still
   * says something worth reading.
   */
  upcoming?: UpcomingLine[];
}

export async function renderDigestImage({
  jobs,
  slot,
  upcoming = [],
}: DigestImageInput): Promise<Buffer> {
  registerAppFonts();

  const morning = slot.hour < 12;
  const heading = morning ? 'สรุปเช้านี้' : 'สรุปเย็นนี้';
  const greeting = morning
    ? jobs.length > 0
      ? 'อรุณสวัสดิ์ครับ วันนี้มีแบบนี้'
      : 'อรุณสวัสดิ์ครับ วันนี้สบาย ๆ'
    : jobs.length > 0
      ? 'ก่อนนอน เช็กอีกรอบนะครับ'
      : 'คืนนี้สบาย ๆ ฝันดีครับ';
  const mood = morning ? 'wave' : 'sleepy';

  // Measuring needs a context, and the canvas needs the height measuring
  // produces — so lay the board out on a throwaway canvas first.
  const scratch = createCanvas(WIDTH, 10).getContext('2d');
  const lines = jobs.length > 0 ? layoutBoard(scratch, jobs) : layoutQuietDay(upcoming);

  const boardTop = 250;
  const boardHeight = Math.max(220, 64 + lines.length * 46 + 40);
  const mascotHeight = 300;
  const height = boardTop + boardHeight + 80 + mascotHeight + PAD;

  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');

  drawBackdrop(ctx, height);
  drawSign(ctx, heading, `${formatThaiDate(slot)} · ${slot.toFormat('HH:mm')} น.`);
  const summary = jobs.length > 0 ? `ทั้งหมด ${jobs.length} รายการ` : `${morning ? 'วันนี้' : 'คืนนี้'}ไม่มีอะไรต้องเตือน`;
  drawBoard(ctx, lines, boardTop, boardHeight, summary);
  await drawMascots(ctx, height - PAD, greeting, mood);

  return canvas.toBuffer('image/png');
}

interface BoardLine {
  text: string;
  /** Section headings have no colour; items carry their kind's. */
  color?: string;
  heading?: boolean;
}

/**
 * A day with nothing due: the week ahead instead, so the morning message is
 * still worth opening. Seven lines at most — it is a glance, not the calendar.
 */
function layoutQuietDay(upcoming: UpcomingLine[]): BoardLine[] {
  if (upcoming.length === 0) return [{ text: 'สัปดาห์นี้ยังว่างทั้งสัปดาห์ครับ', heading: true }];

  const lines: BoardLine[] = [{ text: '7 วันข้างหน้า', heading: true }];
  for (const item of upcoming.slice(0, 7)) {
    lines.push({ text: `${item.when}  ${item.title}`, color: KIND_COLOR.EVENT });
  }
  if (upcoming.length > 7) {
    lines.push({ text: `…และอีก ${upcoming.length - 7} นัด — เปิดแอปดูได้`, heading: true });
  }
  return lines;
}

/** Sections in the same order as the Flex digest, wrapped to the board's width. */
function layoutBoard(ctx: SKRSContext2D, jobs: ReminderJob[]): BoardLine[] {
  const grouped = new Map<JobKind, ReminderJob[]>();
  for (const job of jobs) {
    const bucket = grouped.get(job.kind);
    if (bucket) bucket.push(job);
    else grouped.set(job.kind, [job]);
  }

  const lines: BoardLine[] = [];
  const maxWidth = WIDTH - PAD * 2 - 100;

  for (const kind of SECTION_ORDER) {
    const inKind = grouped.get(kind);
    if (!inKind) continue;

    lines.push({ text: `${SECTION_LABEL[kind]} (${inKind.length})`, heading: true });
    for (const job of inKind) {
      ctx.font = `30px ${FONTS.body}`;
      const [first, ...rest] = wrap(ctx, job.payload.text, maxWidth, 2);
      lines.push({ text: first ?? '', color: KIND_COLOR[kind] });
      for (const more of rest) lines.push({ text: more });
    }
  }

  // Nine lines is where the board stops being readable on a phone.
  if (lines.length > 18) {
    const kept = lines.slice(0, 17);
    kept.push({ text: `…และอีก ${lines.length - 17} บรรทัด — เปิดแอปดูได้`, heading: true });
    return kept;
  }
  return lines;
}

function wrap(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  if (ctx.measureText(text).width <= maxWidth) return [text];

  const out: string[] = [];
  let line = '';
  const flush = () => {
    out.push(line);
    line = '';
  };

  // Thai runs words together, but these lines are built by the bot and do have
  // spaces between their parts — so break there, and only split inside a word
  // when one word is wider than the board.
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) flush();
    if (out.length === maxLines) break;

    line = word;
    while (ctx.measureText(line).width > maxWidth) {
      let cut = line.length;
      while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut -= 1;
      const head = line.slice(0, cut);
      line = line.slice(cut);
      out.push(head);
      if (out.length === maxLines) return ellipsise(out, maxLines);
    }
  }
  if (line) flush();
  return ellipsise(out, maxLines);
}

/** Cut to the line budget, marking that something was left off. */
function ellipsise(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${(kept[maxLines - 1] as string).slice(0, -1)}…`;
  return kept;
}

function drawBackdrop(ctx: SKRSContext2D, height: number): void {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, WIDTH, height);

  ctx.fillStyle = COLORS.dot;
  ctx.globalAlpha = 0.55;
  for (let y = 24; y < height; y += 40) {
    for (let x = 24 + ((y / 40) % 2) * 20; x < WIDTH; x += 40) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/** The wooden sign over the board, same as the app's dashboard. */
function drawSign(ctx: SKRSContext2D, title: string, subtitle: string): void {
  const w = WIDTH - PAD * 2;
  ctx.fillStyle = COLORS.woodDark;
  roundRect(ctx, PAD, PAD + 6, w, 150, 26);
  ctx.fillStyle = COLORS.wood;
  roundRect(ctx, PAD, PAD, w, 150, 26);
  ctx.fillStyle = COLORS.woodEdge;
  roundRect(ctx, PAD + 14, PAD + 14, w - 28, 6, 3);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff8f0';
  ctx.font = `56px ${FONTS.display}`;
  ctx.fillText(title, WIDTH / 2, PAD + 92);
  ctx.font = `28px ${FONTS.body}`;
  ctx.globalAlpha = 0.9;
  ctx.fillText(subtitle, WIDTH / 2, PAD + 132);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function drawBoard(
  ctx: SKRSContext2D,
  lines: BoardLine[],
  top: number,
  height: number,
  summary: string,
): void {
  const w = WIDTH - PAD * 2;
  ctx.fillStyle = COLORS.boardEdge;
  roundRect(ctx, PAD, top, w, height, 22);
  ctx.fillStyle = COLORS.board;
  roundRect(ctx, PAD + 10, top + 10, w - 20, height - 20, 16);

  ctx.font = `26px ${FONTS.bodyBold}`;
  ctx.fillStyle = COLORS.chalkMuted;
  ctx.fillText(summary, PAD + 44, top + 54);

  let y = top + 104;
  for (const line of lines) {
    if (line.heading) {
      ctx.font = `26px ${FONTS.bodyBold}`;
      ctx.fillStyle = COLORS.chalkMuted;
      ctx.fillText(line.text, PAD + 44, y);
    } else {
      if (line.color) {
        ctx.fillStyle = line.color;
        ctx.beginPath();
        ctx.arc(PAD + 54, y - 10, 8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.font = `30px ${FONTS.body}`;
      ctx.fillStyle = COLORS.chalk;
      ctx.fillText(line.text, PAD + 78, y);
    }
    y += 46;
  }

  if (lines.length === 0) {
    ctx.font = `32px ${FONTS.body}`;
    ctx.fillStyle = COLORS.chalk;
    ctx.fillText('วันนี้ไม่มีอะไรค้างครับ', PAD + 44, top + 120);
  }
}

async function drawMascots(
  ctx: SKRSContext2D,
  baseline: number,
  greeting: string,
  mood: 'wave' | 'sleepy',
): Promise<void> {
  // The desk they stand on, as in the app's room scene.
  ctx.fillStyle = COLORS.wood;
  roundRect(ctx, PAD, baseline - 26, WIDTH - PAD * 2, 26, 12);

  const height = 260;
  const width = (height * 200) / 260;
  const pair: Array<['boy' | 'girl', number]> = [
    ['boy', WIDTH / 2 - width - 30],
    ['girl', WIDTH / 2 + 30],
  ];
  for (const [who, x] of pair) {
    const file = join(ASSETS, 'mascots', `${who}-${mood}.svg`);
    if (!existsSync(file)) continue;
    const image = await loadImage(file);
    // +10 so their shoes sit on the desk rather than hovering over it.
    ctx.drawImage(image, x, baseline - height + 10, width, height);
  }

  drawBubble(ctx, greeting, baseline - height - 50);
}

function drawBubble(ctx: SKRSContext2D, text: string, bottom: number): void {
  ctx.font = `30px ${FONTS.body}`;
  const w = ctx.measureText(text).width + 64;
  const h = 72;
  const x = (WIDTH - w) / 2;
  const y = bottom - h;

  ctx.fillStyle = COLORS.bubble;
  roundRect(ctx, x, y, w, h, 24);
  // The tail, pointing down at the two of them.
  ctx.beginPath();
  ctx.moveTo(WIDTH / 2 - 14, y + h - 2);
  ctx.lineTo(WIDTH / 2 + 14, y + h - 2);
  ctx.lineTo(WIDTH / 2, y + h + 22);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = COLORS.brand;
  ctx.textAlign = 'center';
  ctx.fillText(text, WIDTH / 2, y + 46);
  ctx.textAlign = 'left';
}
