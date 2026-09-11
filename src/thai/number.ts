/**
 * Thai numeral handling.
 *
 * Two separate jobs live here:
 *  - digit normalisation (๐-๙ -> 0-9), needed before any regex touches the text
 *  - spelled-out cardinals, needed for spoken clock times ("บ่ายสาม", "สามทุ่ม")
 *    and for amounts people type in words ("ห้าร้อย")
 */

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

/** ๑๕ -> 15. Safe to run on any text; non-Thai digits pass through. */
export function normalizeThaiDigits(input: string): string {
  return input.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
}

/** Single-word cardinals. "เอ็ด" only ever appears in the ones place of 11-91. */
const ONES: Record<string, number> = {
  ศูนย์: 0,
  หนึ่ง: 1,
  เอ็ด: 1,
  สอง: 2,
  ยี่: 2,
  สาม: 3,
  สี่: 4,
  ห้า: 5,
  หก: 6,
  เจ็ด: 7,
  แปด: 8,
  เก้า: 9,
};

const SCALES: Record<string, number> = {
  สิบ: 10,
  ร้อย: 100,
  พัน: 1_000,
  หมื่น: 10_000,
  แสน: 100_000,
  ล้าน: 1_000_000,
};

/**
 * Parse a fully spelled-out Thai cardinal, e.g. "สามร้อยยี่สิบห้า" -> 325.
 * Returns null when the string is not entirely consumed as a number, so callers
 * can fall back to digits rather than acting on a partial read.
 */
export function parseThaiCardinal(input: string): number | null {
  const s = input.trim();
  if (s.length === 0) return null;

  let total = 0; // completed groups (everything above the current scale)
  let current = 0; // value being accumulated for the pending scale
  let sawAny = false;
  let i = 0;

  while (i < s.length) {
    let matched = false;

    // Scales are checked first so that "สิบ" in "สิบเอ็ด" binds as a scale.
    for (const [word, value] of Object.entries(SCALES)) {
      if (!s.startsWith(word, i)) continue;

      if (value === 1_000_000) {
        // ล้าน closes every pending group: "สองล้าน" -> 2_000_000.
        total = (total + current || 1) * value;
        current = 0;
      } else {
        // A bare scale means one of it: "สิบ" -> 10, "ร้อย" -> 100.
        current = (current || 1) * value;
        total += current;
        current = 0;
      }

      sawAny = true;
      matched = true;
      i += word.length;
      break;
    }
    if (matched) continue;

    for (const [word, value] of Object.entries(ONES)) {
      if (!s.startsWith(word, i)) continue;
      current += value;
      sawAny = true;
      matched = true;
      i += word.length;
      break;
    }

    // Anything we cannot consume means this is not a pure number.
    if (!matched) return null;
  }

  return sawAny ? total + current : null;
}

/**
 * Read a number that may be Thai digits, Arabic digits with separators, or
 * spelled out. Used by both the clock parser and the expense parser.
 */
export function parseThaiNumber(input: string): number | null {
  const s = normalizeThaiDigits(input).trim();
  if (s.length === 0) return null;

  const digits = s.replace(/,/g, '');
  if (/^\d+(\.\d+)?$/.test(digits)) return Number(digits);

  return parseThaiCardinal(s);
}

/**
 * Money is stored as satang everywhere in this project, so amounts are parsed
 * straight into satang to keep float rounding out of the database.
 * "1,250.50" -> 125050, "ห้าร้อย" -> 50000.
 */
export function parseAmountToSatang(input: string): number | null {
  const value = parseThaiNumber(input);
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** 125050 -> "1,250.50". Trailing ".00" is dropped, which is how people write it. */
export function formatSatang(satang: number): string {
  const baht = satang / 100;
  const hasSubunit = satang % 100 !== 0;
  return baht.toLocaleString('en-US', {
    minimumFractionDigits: hasSubunit ? 2 : 0,
    maximumFractionDigits: 2,
  });
}
