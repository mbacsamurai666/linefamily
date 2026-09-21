/**
 * Every command the ChatGPT path is allowed to produce, as it should be written.
 *
 * This is the model's whole vocabulary: it is shown these examples and asked to
 * rewrite a family member's message into one of them. Nothing it writes is
 * executed on its say-so — the rewritten text goes back through the same
 * deterministic handlers a person typing it would hit. So this list is also a
 * promise, and tests/integration/catalog.test.ts holds it: every example here
 * must be understood by those handlers, or the model would be taught a phrase
 * the bot cannot act on.
 *
 *  - read:   answered straight away (nothing changes)
 *  - act:    changes something; the bot shows the command and waits for a tap
 *  - record: creates something; goes to the usual confirm card
 */

export type CommandEffect = 'read' | 'act' | 'record';

export interface CatalogEntry {
  example: string;
  means: string;
  effect: CommandEffect;
}

export const COMMAND_CATALOG: readonly CatalogEntry[] = [
  // --------------------------------------------------------------- read
  { example: 'นัดวันนี้', means: 'ดูนัดวันนี้', effect: 'read' },
  { example: 'นัดพรุ่งนี้', means: 'ดูนัดพรุ่งนี้', effect: 'read' },
  { example: 'นัดสัปดาห์นี้', means: 'ดูนัดที่เหลือของสัปดาห์นี้', effect: 'read' },
  { example: 'นัดสัปดาห์หน้า', means: 'ดูนัดสัปดาห์หน้า', effect: 'read' },
  { example: 'นัดวันที่ 21 ก.ย.', means: 'ดูนัดของวันที่ระบุ', effect: 'read' },
  { example: 'ลิสต์ซื้อของ', means: 'ดูของที่ยังต้องซื้อ', effect: 'read' },
  { example: 'สรุปเดือนนี้', means: 'รายจ่ายเดือนนี้แยกตามหมวด', effect: 'read' },
  { example: 'สรุปเดือนที่แล้ว', means: 'รายจ่ายเดือนที่แล้วแยกตามหมวด', effect: 'read' },
  { example: 'สรุป ส.ค.', means: 'รายจ่ายของเดือนที่ระบุ', effect: 'read' },
  {
    example: 'ค่าไฟเดือนนี้',
    means: 'ยอดของหมวดเดียว — ชื่อหมวดต้องเป็นหมวดที่บ้านนี้มีอยู่แล้ว ตามด้วยเดือน',
    effect: 'read',
  },
  { example: 'ค่าไฟเดือนที่แล้ว', means: 'ยอดของหมวดเดียวเมื่อเดือนที่แล้ว', effect: 'read' },
  { example: 'เทียบกับเดือนที่แล้ว', means: 'เดือนนี้ใช้มากหรือน้อยกว่าเดือนที่แล้ว', effect: 'read' },
  { example: 'สรุปหนี้', means: 'ใครติดใครเท่าไหร่จากรายจ่ายที่หารกัน', effect: 'read' },
  { example: 'สรุปเงินกู้', means: 'เงินที่ให้คนอื่นยืมและยังไม่คืน', effect: 'read' },
  { example: 'สรุปทรัพย์สิน', means: 'รายการทรัพย์สิน', effect: 'read' },
  { example: 'สรุปเงินฝาก', means: 'บัญชีเงินฝาก', effect: 'read' },
  { example: 'สรุปฐานะการเงิน', means: 'ทรัพย์สิน เงินฝาก เงินให้ยืม รวมกัน', effect: 'read' },
  { example: 'บอร์ดงาน', means: 'งานที่ยังค้างอยู่', effect: 'read' },
  { example: 'ข้อมูลฉุกเฉิน', means: 'กรุ๊ปเลือด แพ้ยา โรคประจำตัว ของทุกคน', effect: 'read' },
  { example: 'สถานะระบบ', means: 'บอทยังเตือนปกติไหม', effect: 'read' },

  // ---------------------------------------------------------------- act
  { example: 'ข้ามนัด กายภาพแม่ 21 ก.ย.', means: 'งดนัดที่เกิดซ้ำเฉพาะวันนั้น', effect: 'act' },
  { example: 'จ่ายบิลแล้ว ค่าไฟ', means: 'บิลนี้จ่ายแล้ว ตัดเป็นรายจ่าย', effect: 'act' },
  { example: 'ปิดงาน โทรหาช่าง', means: 'งานนี้เสร็จแล้ว', effect: 'act' },
  { example: 'ทำแล้ว ล้างจาน', means: 'เวรนี้ทำแล้ว หมุนไปคนถัดไป', effect: 'act' },
  { example: 'กินยาแล้ว', means: 'คนที่พิมพ์กินยาโดสล่าสุดแล้ว', effect: 'act' },
  { example: 'ตั้งงบ ค่าไฟ 1000 บาท', means: 'งบรายเดือนของหมวด', effect: 'act' },
  { example: 'วันเกิด น้องพร 5 ม.ค. 2560', means: 'บันทึกวันเกิด เตือนทุกปี', effect: 'act' },
  { example: 'ลบนัด หมอฟัน', means: 'ลบนัด (ถ้าเป็นนัดซ้ำจะลบทุกครั้ง)', effect: 'act' },
  { example: 'ลบบิล ค่าเน็ต', means: 'เลิกติดตามบิลนี้', effect: 'act' },
  { example: 'ลบของ นม', means: 'เอาของออกจากลิสต์ซื้อของ', effect: 'act' },
  { example: 'ยกเลิกล่าสุด', means: 'ลบสิ่งที่เพิ่งบันทึกไป', effect: 'act' },
  { example: 'กรุ๊ปเลือดฉัน O', means: 'ตั้งกรุ๊ปเลือดของคนที่พิมพ์', effect: 'act' },
  { example: 'แพ้ยา เพนิซิลลิน', means: 'ตั้งข้อมูลแพ้ยาของคนที่พิมพ์', effect: 'act' },
  { example: 'โรคประจำตัว เบาหวาน', means: 'ตั้งโรคประจำตัวของคนที่พิมพ์', effect: 'act' },

  // ------------------------------------------------------------- record
  { example: 'พาแม่ไปหาหมอ 19 ก.ย. 14:00', means: 'นัดหมาย (เรื่อง วัน เวลา)', effect: 'record' },
  { example: 'ประชุมผู้ปกครอง 25 ก.ย.', means: 'นัดทั้งวัน ไม่ระบุเวลา', effect: 'record' },
  { example: 'เที่ยวจูไห่ 1-7 ต.ค.', means: 'นัดหลายวัน (วันเริ่ม-วันสุดท้าย)', effect: 'record' },
  { example: 'น้องพร สอบปลายภาค 22 ก.ย. 09:00', means: 'นัดของลูก ชื่อนำหน้า', effect: 'record' },
  { example: 'ทุกวันจันทร์ 09:00 กายภาพแม่', means: 'นัดที่เกิดซ้ำ', effect: 'record' },
  { example: 'ค่าข้าว 250', means: 'รายจ่าย (หมวด จำนวนบาท)', effect: 'record' },
  { example: 'ค่าข้าว 300 หารกับ พี่เอ', means: 'รายจ่ายที่หารกัน', effect: 'record' },
  { example: 'เงินเดือน 30000', means: 'รายรับ', effect: 'record' },
  { example: 'ซื้อของ: นม, ไข่', means: 'เพิ่มของในลิสต์ซื้อของ', effect: 'record' },
  { example: 'ตั้งบิล ค่าไฟ 800 ทุกวันที่ 5', means: 'บิลประจำเดือน', effect: 'record' },
  { example: 'ใบขับขี่ หมดอายุ 15 มี.ค. 2570', means: 'เอกสารที่ต้องต่ออายุ', effect: 'record' },
  { example: 'ตั้งยา ยาความดัน เวลา 08:00, 20:00', means: 'เตือนกินยา', effect: 'record' },
  { example: 'ตั้งเวร ล้างจาน ทุกวัน หมุนกับ แม่ พ่อ', means: 'เวรงานบ้าน', effect: 'record' },
  { example: 'เพิ่มงาน โทรหาช่าง 12 ก.ย. ให้พ่อทำ', means: 'งานบนบอร์ด', effect: 'record' },
  { example: 'ให้ยืมเงิน พี่เอ 5000 คืน 5 ต.ค.', means: 'เงินที่ให้คนอื่นยืม', effect: 'record' },
  { example: 'เพิ่มทรัพย์สิน บ้านสวน 3000000', means: 'ทรัพย์สิน', effect: 'record' },
  { example: 'เพิ่มบัญชีเงินฝาก ออมทรัพย์ SCB 50000', means: 'บัญชีเงินฝาก', effect: 'record' },
];
