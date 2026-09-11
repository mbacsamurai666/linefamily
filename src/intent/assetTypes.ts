/** Mirrors the AssetCategory enum in the schema. */
export type AssetCategory = 'PROPERTY' | 'VEHICLE' | 'ELECTRONICS' | 'JEWELRY' | 'INVESTMENT' | 'OTHER';

/**
 * Keyword hints for auto-categorising an asset. Same trade-off as
 * guessEventCategory/guessDocumentType — small and approximate, corrected on
 * the confirm card rather than avoided upfront.
 */
const HINTS: Array<[AssetCategory, RegExp]> = [
  ['PROPERTY', /บ้าน|ที่ดิน|คอนโด|ห้องชุด/],
  ['VEHICLE', /รถยนต์|รถกระบะ|รถมอเตอร์ไซค์|มอไซค์|รถ(?!ไฟ)/],
  ['ELECTRONICS', /โทรศัพท์|มือถือ|คอม|โน้ตบุ๊ค|laptop|ทีวี|กล้อง/i],
  ['JEWELRY', /ทอง|เพชร|นาฬิกา|เครื่องประดับ/],
  ['INVESTMENT', /หุ้น|กองทุน|พันธบัตร|ทองคำแท่ง|คริปโต|crypto/i],
];

export function guessAssetCategory(text: string): AssetCategory {
  for (const [category, re] of HINTS) {
    if (re.test(text)) return category;
  }
  return 'OTHER';
}

/** Thai labels for display in Flex cards, LIFF, and digests. */
export const ASSET_CATEGORY_LABEL: Record<AssetCategory, string> = {
  PROPERTY: 'บ้าน/ที่ดิน',
  VEHICLE: 'รถ',
  ELECTRONICS: 'เครื่องใช้ไฟฟ้า',
  JEWELRY: 'ของมีค่า',
  INVESTMENT: 'เงินลงทุน',
  OTHER: 'อื่นๆ',
};
