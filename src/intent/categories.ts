/** Appointment categories, mirroring the EventCategory enum in the schema. */
export type EventCategory =
  | 'MEDICAL'
  | 'SCHOOL'
  | 'GOVERNMENT'
  | 'SOCIAL'
  | 'WORK'
  | 'TRAVEL'
  | 'OTHER';

/**
 * Keyword hints for auto-categorising an appointment. Deliberately small —
 * a wrong guess is corrected on the confirm card, and the goal is to save the
 * common taps, not to be exhaustive.
 */
const HINTS: Array<[EventCategory, RegExp]> = [
  // "ยา" and "หมอ" only as words: "ยางลบ" on a school supplies list made an
  // exam a doctor's visit, and ยาย, ยาว, หมอน would have done the same.
  ['MEDICAL', /หมอ(?!น)|แพทย์|คลินิก|โรงพยาบาล|รพ\.|ทันตะ|ฟัน|ตรวจสุขภาพ|ฉีดวัคซีน|วัคซีน|ผ่าตัด|(?:กิน|รับ|ซื้อ|ร้าน)ยา(?![งยวมน])|ยา(?![งยวกมน])/],
  // A school notice's own words: "ปิดภาคเรียน", "เก็บคะแนน", "กิจกรรมลูกเสือ".
  [
    'SCHOOL',
    /โรงเรียน|รร\.|ครู|สอบ|เรียน|อนุบาล|ปฐมวัย|พัฒนาการ|ผู้ปกครอง|เปิดเทอม|ปิดเทอม|ภาคเรียน|คะแนน|การบ้าน|ลูกเสือ|เนตรนารี|ยุวกาชาด|กีฬาสี|ทัศนศึกษา|ปฐมนิเทศ|อ่านหนังสือ|เรียนพิเศษ|ติว|คอร์ส|course|รับปริญญา|มหาลัย|กิจกรรมโรงเรียน/i,
  ],
  ['GOVERNMENT', /อำเภอ|เขต|ราชการ|กรม|ที่ดิน|ต่อใบขับขี่|ขนส่ง|ทะเบียนบ้าน|บัตรประชาชน|พาสปอร์ต|ตรวจคนเข้าเมือง|ศาล|สรรพากร|ภาษี/],
  // After ราชการ, so "ทำพาสปอร์ต" stays an errand and not a holiday.
  [
    'TRAVEL',
    /เที่ยว|ทริป|trip|เดินทาง|บินไป|ไฟลต์|ไฟลท์|flight|สนามบิน|โรงแรม|รีสอร์ท|รีสอร์ต|ที่พัก|พักร้อน|ต่างประเทศ|ต่างจังหวัด|กลับบ้านเกิด|ทะเล|ดอย|เกาะ|แคมป์ปิ้ง/i,
  ],
  ['WORK', /ประชุม|meeting|สัมภาษณ์|งานบริษัท|ลูกค้า|ส่งงาน|เดดไลน์|deadline/i],
  ['SOCIAL', /งานแต่ง|งานบวช|งานศพ|ขึ้นบ้านใหม่|วันเกิด|เลี้ยง|กินข้าว|ปาร์ตี้|สังสรรค์|ทำบุญ|เยี่ยม/],
];

/**
 * A kind named outright — "โรงเรียน" on a line of its own at the end of a
 * message, or "#เที่ยว" — beats any guess.
 */
export function namedEventCategory(word: string): EventCategory | null {
  const w = word.trim().replace(/^[#\[(]|[\])]$/g, '').replace(/^(?:หมวด|ประเภท)\s*/, '');
  for (const [category, label] of Object.entries(CATEGORY_LABEL) as Array<[EventCategory, string]>) {
    if (w === label) return category;
  }
  return w === 'อื่นๆ' ? 'OTHER' : null;
}

export function guessEventCategory(title: string): EventCategory {
  for (const [category, re] of HINTS) {
    if (re.test(title)) return category;
  }
  return 'OTHER';
}

/** Thai labels for display in Flex cards and digests. */
export const CATEGORY_LABEL: Record<EventCategory, string> = {
  MEDICAL: 'หมอ',
  SCHOOL: 'โรงเรียน',
  GOVERNMENT: 'ราชการ',
  SOCIAL: 'สังคม',
  WORK: 'งาน',
  TRAVEL: 'เที่ยว',
  // Whatever fits no other kind is still an appointment — "อื่นๆ" read as
  // an afterthought on a line like "[อื่นๆ] ไหว้เจ้าที่".
  OTHER: 'นัด',
};
