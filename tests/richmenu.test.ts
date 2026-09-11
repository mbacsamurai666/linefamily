import { describe, expect, it } from 'vitest';
import { cellBounds, renderRichMenuImage, RICH_MENU_GRID, RICH_MENU_SIZE } from '../src/line/richmenuImage.js';

const SIX_CELLS = [
  { label: 'ช่วยเหลือ', sublabel: 'วิธีใช้' },
  { label: 'ฉุกเฉิน', sublabel: 'กรุ๊ปเลือด/แพ้ยา' },
  { label: 'กินยาแล้ว', sublabel: 'บันทึกโดสล่าสุด' },
  { label: 'ทำแล้ว', sublabel: 'เวรวันนี้' },
  { label: 'เปิดแอป' },
  { label: 'ซื้อของ', sublabel: 'เพิ่มลิสต์' },
];

describe('cellBounds', () => {
  it('tiles the full image with no gaps and no overlaps', () => {
    const cells = [];
    for (let row = 0; row < RICH_MENU_GRID.rows; row++) {
      for (let col = 0; col < RICH_MENU_GRID.cols; col++) {
        cells.push(cellBounds(col, row));
      }
    }

    const totalArea = cells.reduce((sum, c) => sum + c.width * c.height, 0);
    expect(totalArea).toBe(RICH_MENU_SIZE.width * RICH_MENU_SIZE.height);

    // Rounding remainder must land in the last column/row, not disappear.
    const rightEdge = Math.max(...cells.map((c) => c.x + c.width));
    const bottomEdge = Math.max(...cells.map((c) => c.y + c.height));
    expect(rightEdge).toBe(RICH_MENU_SIZE.width);
    expect(bottomEdge).toBe(RICH_MENU_SIZE.height);
  });
});

describe('renderRichMenuImage', () => {
  it('rejects a cell count that does not fill the grid', () => {
    expect(() => renderRichMenuImage(SIX_CELLS.slice(0, 5))).toThrow(/expected 6 cells/);
  });

  it('produces a PNG at the exact LINE-required dimensions', () => {
    const png = renderRichMenuImage(SIX_CELLS);
    // PNG IHDR: bytes 16-19 = width, 20-23 = height, big-endian.
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect({ width, height }).toEqual(RICH_MENU_SIZE);
  });

  it('actually draws the labels, not a blank cell', () => {
    // Regression test: @napi-rs/canvas has no bundled fonts and fillText on
    // an unregistered family silently draws nothing — a solid green image
    // with zero labels compressed to ~20KB the first time this ran. Text
    // pushes the PNG well past that once a real font is registered.
    const withText = renderRichMenuImage(SIX_CELLS);
    const blank = renderRichMenuImage(SIX_CELLS.map((c) => ({ label: '', sublabel: '' })));
    expect(withText.length).toBeGreaterThan(blank.length * 1.5);
  });
});
