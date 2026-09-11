import { existsSync } from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

/**
 * Draws the rich menu image in code instead of shipping a binary asset —
 * there is no design step in this repo's build, so the artwork has to be
 * something a script can regenerate deterministically. A 2x3 grid at LINE's
 * full-size rich menu dimensions (2500x1686).
 *
 * @napi-rs/canvas ships with no bundled fonts and does not fall back to a
 * system default for missing families — fillText silently draws nothing
 * rather than erroring, which is exactly what happened the first time this
 * ran (a blank green grid, no labels). A Thai-capable font must be
 * registered by file path before any text is drawn.
 */

const FONT_FAMILY = 'RichMenuFont';
/** Windows ships Leelawadee (Thai UI font) here by default. */
const CANDIDATE_FONT_PATHS = [
  'C:\\Windows\\Fonts\\leelawad.ttf',
  'C:\\Windows\\Fonts\\tahoma.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansThai-Regular.ttf',
  '/usr/share/fonts/truetype/thai-tlwg/Garuda.ttf',
];

let fontReady = false;
function ensureFont(): void {
  if (fontReady) return;
  const path = CANDIDATE_FONT_PATHS.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      'No Thai-capable font found among the known candidate paths. ' +
        'Set one explicitly by editing CANDIDATE_FONT_PATHS in richmenuImage.ts, ' +
        'or install Noto Sans Thai and add its path.',
    );
  }
  GlobalFonts.registerFromPath(path, FONT_FAMILY);
  fontReady = true;
}

export interface RichMenuCell {
  label: string;
  sublabel?: string;
}

const WIDTH = 2500;
const HEIGHT = 1686;
const COLS = 3;
const ROWS = 2;

/**
 * Same palette as the LIFF app (liff/src/styles.css) so the menu in the chat
 * and the page it opens look like one product. Alternating tiles give the
 * grid some rhythm without needing artwork.
 */
const BACKDROP = '#fdeaf0';
const TILE = '#ffffff';
const TILE_ALT = '#fde3ef';
const BORDER = '#f5dde7';
const TEXT = '#4a3640';
const SUBTEXT = '#a08c97';
const ACCENT = '#d6488b';

export function cellBounds(col: number, row: number) {
  const colWidth = Math.floor(WIDTH / COLS);
  const rowHeight = Math.floor(HEIGHT / ROWS);
  return {
    x: col * colWidth,
    y: row * rowHeight,
    // The last column/row absorbs the rounding remainder so cells tile the
    // full image with no gap.
    width: col === COLS - 1 ? WIDTH - col * colWidth : colWidth,
    height: row === ROWS - 1 ? HEIGHT - row * rowHeight : rowHeight,
  };
}

export function renderRichMenuImage(cells: RichMenuCell[]): Buffer {
  if (cells.length !== COLS * ROWS) {
    throw new Error(`expected ${COLS * ROWS} cells, got ${cells.length}`);
  }
  ensureFont();

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BACKDROP;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  cells.forEach((cell, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const { x, y, width, height } = cellBounds(col, row);

    // Checkerboard the tiles so the six tap targets read as separate buttons
    // without needing heavy dividers.
    ctx.fillStyle = (col + row) % 2 === 0 ? TILE : TILE_ALT;
    ctx.fillRect(x, y, width, height);

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 2, y + 2, width - 4, height - 4);

    const cx = x + width / 2;
    const cy = y + height / 2;

    // A short accent rule above the label, echoing the app's pink.
    ctx.fillStyle = ACCENT;
    ctx.fillRect(cx - 54, cy - (cell.sublabel ? 140 : 100), 108, 8);

    ctx.fillStyle = TEXT;
    ctx.font = `bold 90px ${FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(cell.label, cx, cell.sublabel ? cy - 40 : cy);

    if (cell.sublabel) {
      ctx.fillStyle = SUBTEXT;
      ctx.font = `48px ${FONT_FAMILY}`;
      ctx.fillText(cell.sublabel, cx, cy + 60);
    }
  });

  return canvas.toBuffer('image/png');
}

export const RICH_MENU_SIZE = { width: WIDTH, height: HEIGHT };
export const RICH_MENU_GRID = { cols: COLS, rows: ROWS };
