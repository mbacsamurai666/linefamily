import { describe, expect, it } from 'vitest';
import { CATEGORY_LABEL, guessEventCategory } from '../src/intent/categories.js';

/** The four kinds the family asked to see apart: โรงเรียน, เที่ยว, งาน, นัด. */
describe('guessEventCategory', () => {
  it.each([
    // The school notice from the group, line by line.
    ['เริ่มเก็บคะแนนในคาบเรียน', 'SCHOOL'],
    ['สอบปลายภาค', 'SCHOOL'],
    ['หยุด อ่านหนังสือ', 'SCHOOL'],
    ['กิจกรรมลูกเสือ', 'SCHOOL'],
    ['ปิดภาคเรียน', 'SCHOOL'],
    ['October Course', 'SCHOOL'],
    ['เลิกเรียน 16.00 น.', 'SCHOOL'],
    ['ประเมินพัฒนาการระดับปฐมวัย', 'SCHOOL'],
    ['น้องเอ ขึ้นบ้านใหม่', 'SOCIAL'],
    // Trips.
    ['เที่ยว จูไห', 'TRAVEL'],
    ['ทริปเชียงใหม่', 'TRAVEL'],
    ['บินไปญี่ปุ่น', 'TRAVEL'],
    ['ไปทะเลหัวหิน', 'TRAVEL'],
    // Work.
    ['ประชุมลูกค้า', 'WORK'],
    // Errands stay errands, even with a passport in them.
    ['ทำพาสปอร์ต', 'GOVERNMENT'],
    ['พาไป กรมที่ดิน', 'GOVERNMENT'],
    // Everything else is simply an appointment.
    ['ไหว้เจ้าที่ หัวหมู', 'OTHER'],
    ['สั่งเหล็ก', 'OTHER'],
  ])('%s → %s', (title, kind) => {
    expect(guessEventCategory(title)).toBe(kind);
  });

  it('calls the catch-all "นัด", not "อื่นๆ"', () => {
    expect(CATEGORY_LABEL.OTHER).toBe('นัด');
    expect(CATEGORY_LABEL.TRAVEL).toBe('เที่ยว');
  });
});
