/** Mirrors the DocumentType enum in the schema. */
export type DocumentType =
  | 'ID_CARD'
  | 'PASSPORT'
  | 'DRIVER_LICENSE'
  | 'VEHICLE_TAX'
  | 'INSURANCE'
  | 'VISA'
  | 'OTHER';

/**
 * Keyword hints for auto-categorising a document. Same trade-off as
 * guessEventCategory in categories.ts — small and approximate, because a
 * wrong guess is corrected on the confirm card rather than avoided upfront.
 */
const HINTS: Array<[DocumentType, RegExp]> = [
  ['ID_CARD', /บัตรประชาชน|บัตรปชช/],
  ['PASSPORT', /พาสปอร์ต|หนังสือเดินทาง/],
  ['DRIVER_LICENSE', /ใบขับขี่|ใบขับรถ|ใบอนุญาตขับรถ/],
  ['VEHICLE_TAX', /พ\.ร\.บ\.|พรบ|ต่อทะเบียน|ภาษีรถ|ทะเบียนรถ/],
  ['INSURANCE', /ประกัน/],
  ['VISA', /วีซ่า/],
];

export function guessDocumentType(text: string): DocumentType {
  for (const [type, re] of HINTS) {
    if (re.test(text)) return type;
  }
  return 'OTHER';
}

/** Thai labels for display in Flex cards and digests. */
export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  ID_CARD: 'บัตรประชาชน',
  PASSPORT: 'พาสปอร์ต',
  DRIVER_LICENSE: 'ใบขับขี่',
  VEHICLE_TAX: 'พ.ร.บ./ทะเบียนรถ',
  INSURANCE: 'ประกัน',
  VISA: 'วีซ่า',
  OTHER: 'เอกสาร',
};
