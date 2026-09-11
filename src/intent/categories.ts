/** Appointment categories, mirroring the EventCategory enum in the schema. */
export type EventCategory =
  | 'MEDICAL'
  | 'SCHOOL'
  | 'GOVERNMENT'
  | 'SOCIAL'
  | 'WORK'
  | 'OTHER';

/**
 * Keyword hints for auto-categorising an appointment. Deliberately small —
 * a wrong guess is corrected on the confirm card, and the goal is to save the
 * common taps, not to be exhaustive.
 */
const HINTS: Array<[EventCategory, RegExp]> = [
  ['MEDICAL', /หมอ|แพทย์|คลินิก|โรงพยาบาล|รพ\.|ทันตะ|ฟัน|ตรวจสุขภาพ|ฉีดวัคซีน|วัคซีน|ผ่าตัด|ยา/],
  ['SCHOOL', /โรงเรียน|รร\.|ครู|สอบ|ผู้ปกครอง|เปิดเทอม|ปิดเทอม|รับปริญญา|มหาลัย|กิจกรรมโรงเรียน/],
  ['GOVERNMENT', /อำเภอ|เขต|ราชการ|ต่อใบขับขี่|ขนส่ง|ทะเบียนบ้าน|บัตรประชาชน|พาสปอร์ต|ตรวจคนเข้าเมือง|ศาล|สรรพากร|ภาษี/],
  ['WORK', /ประชุม|meeting|สัมภาษณ์|งานบริษัท|ลูกค้า|ส่งงาน|เดดไลน์|deadline/i],
  ['SOCIAL', /งานแต่ง|งานบวช|งานศพ|วันเกิด|เลี้ยง|กินข้าว|ปาร์ตี้|สังสรรค์|ทำบุญ|เยี่ยม/],
];

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
  OTHER: 'อื่นๆ',
};
