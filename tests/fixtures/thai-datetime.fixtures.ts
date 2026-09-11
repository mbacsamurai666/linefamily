/**
 * Real phrasings a family would actually type into a LINE group.
 *
 * Every fixture is anchored to NOW below. When a case here fails, the parser
 * is wrong — not the fixture — unless the expectation was genuinely ambiguous
 * in Thai, in which case add a note rather than loosening the assertion.
 *
 * NOW = Friday 4 September 2026, 10:00, Asia/Bangkok.
 */
export const NOW_ISO = '2026-09-04T10:00:00.000+07:00';

export interface DateTimeFixture {
  input: string;
  /** Expected local ISO (no zone suffix), or null when nothing should match. */
  expect: string | null;
  allDay?: boolean;
  /** Expected leftover text after the date/time is stripped. */
  title?: string;
  note?: string;
}

export const DATE_ONLY: DateTimeFixture[] = [
  { input: 'วันนี้', expect: '2026-09-04T00:00', allDay: true },
  { input: 'พรุ่งนี้', expect: '2026-09-05T00:00', allDay: true },
  { input: 'มะรืนนี้', expect: '2026-09-06T00:00', allDay: true },
  { input: 'มะรืน', expect: '2026-09-06T00:00', allDay: true },
  { input: 'เมื่อวาน', expect: '2026-09-03T00:00', allDay: true },
  { input: 'อาทิตย์หน้า', expect: '2026-09-11T00:00', allDay: true },
  { input: 'สัปดาห์หน้า', expect: '2026-09-11T00:00', allDay: true },
  { input: 'เดือนหน้า', expect: '2026-10-04T00:00', allDay: true },
  { input: 'สิ้นเดือน', expect: '2026-09-30T00:00', allDay: true },
  { input: 'สิ้นเดือนนี้', expect: '2026-09-30T00:00', allDay: true },
  { input: 'ต้นเดือนหน้า', expect: '2026-10-01T00:00', allDay: true },
  { input: 'ปีหน้า', expect: '2027-09-04T00:00', allDay: true },

  // Weekdays resolve to the next strictly-future occurrence.
  { input: 'วันจันทร์', expect: '2026-09-07T00:00', allDay: true },
  { input: 'วันจันทร์หน้า', expect: '2026-09-07T00:00', allDay: true },
  { input: 'วันพฤหัสบดี', expect: '2026-09-10T00:00', allDay: true },
  { input: 'วันเสาร์', expect: '2026-09-05T00:00', allDay: true },
  {
    input: 'วันศุกร์',
    expect: '2026-09-11T00:00',
    allDay: true,
    note: 'today is Friday; a weekday name always means the next one, never today',
  },
  {
    input: 'วันอาทิตย์หน้า',
    expect: '2026-09-06T00:00',
    allDay: true,
    note: 'with the วัน prefix this is the weekday, not the "next week" phrase',
  },

  // Explicit calendar dates.
  { input: '5 ก.ย.', expect: '2026-09-05T00:00', allDay: true },
  { input: '15 กันยายน', expect: '2026-09-15T00:00', allDay: true },
  { input: '5 กันยายน 2569', expect: '2026-09-05T00:00', allDay: true },
  { input: '5 กันยายน 2026', expect: '2026-09-05T00:00', allDay: true },
  { input: '๑๕ ก.ย.', expect: '2026-09-15T00:00', allDay: true },
  { input: '25 ธ.ค.', expect: '2026-12-25T00:00', allDay: true },
  {
    input: '1 ม.ค.',
    expect: '2027-01-01T00:00',
    allDay: true,
    note: 'a bare date already past this year rolls to next year',
  },
  { input: '5/9', expect: '2026-09-05T00:00', allDay: true },
  { input: '5/9/69', expect: '2026-09-05T00:00', allDay: true },
  { input: '25/12/2569', expect: '2026-12-25T00:00', allDay: true },
];

export const TIME_ONLY: DateTimeFixture[] = [
  { input: 'บ่ายสาม', expect: '2026-09-04T15:00' },
  { input: 'บ่าย 3', expect: '2026-09-04T15:00' },
  { input: 'บ่าย 3 โมง', expect: '2026-09-04T15:00' },
  { input: 'บ่ายโมง', expect: '2026-09-04T13:00' },
  { input: 'บ่ายโมงครึ่ง', expect: '2026-09-04T13:30' },
  { input: 'สามทุ่ม', expect: '2026-09-04T21:00' },
  { input: 'สองทุ่มครึ่ง', expect: '2026-09-04T20:30' },
  { input: '5 โมงเย็น', expect: '2026-09-04T17:00' },
  { input: 'เที่ยง', expect: '2026-09-04T12:00' },
  { input: 'เที่ยงครึ่ง', expect: '2026-09-04T12:30' },
  { input: '15:00', expect: '2026-09-04T15:00' },
  { input: '15.30 น.', expect: '2026-09-04T15:30' },
  { input: '15.30', expect: '2026-09-04T15:30' },
  { input: '9.30 น.', expect: '2026-09-05T09:30', note: 'dot needs the น. marker below 13:00' },
  { input: '14 น.', expect: '2026-09-04T14:00' },

  // A bare clock time that has already passed today means tomorrow.
  { input: 'ตีห้า', expect: '2026-09-05T05:00' },
  { input: 'เที่ยงคืน', expect: '2026-09-05T00:00' },
  { input: '9 โมงเช้า', expect: '2026-09-05T09:00' },
  {
    input: 'สามโมง',
    expect: '2026-09-05T09:00',
    note: 'traditional Thai reading counts from 6am, so สามโมง is 09:00',
  },
];

export const COMBINED: DateTimeFixture[] = [
  {
    input: 'พรุ่งนี้บ่าย 3 พาแม่ไปหาหมอศิริราช',
    expect: '2026-09-05T15:00',
    title: 'พาแม่ไปหาหมอศิริราช',
  },
  { input: 'วันจันทร์ 9 โมงเช้า ประชุม', expect: '2026-09-07T09:00', title: 'ประชุม' },
  { input: '5 ก.ย. 14:00 นัดหมอฟัน', expect: '2026-09-05T14:00', title: 'นัดหมอฟัน' },
  {
    input: 'มะรืนนี้เที่ยงครึ่ง กินข้าวกับป้า',
    expect: '2026-09-06T12:30',
    title: 'กินข้าวกับป้า',
  },
  { input: 'เสาร์นี้ตีห้า ไปสนามบิน', expect: '2026-09-05T05:00', title: 'ไปสนามบิน' },
  { input: '25/12 สองทุ่ม ปาร์ตี้', expect: '2026-12-25T20:00', title: 'ปาร์ตี้' },
];

/**
 * Messages that are NOT about a scheduled thing. A false positive here is worse
 * than a miss: it turns an expense note into a phantom calendar entry.
 */
export const NO_MATCH: DateTimeFixture[] = [
  { input: 'สวัสดีครับ', expect: null },
  { input: 'ค่าข้าว 250', expect: null },
  { input: 'จ่ายค่าน้ำ 350 บาท', expect: null },
  { input: 'ค่าไฟ 1,250', expect: null },
  { input: 'ซื้อนม 2 กล่อง', expect: null },
  {
    input: 'ค่ากาแฟ 1.50',
    expect: null,
    note: 'a decimal amount must not be read as 01:50',
  },
  { input: 'โอนให้แม่ 2000', expect: null },
];

export const ALL_FIXTURES = [...DATE_ONLY, ...TIME_ONLY, ...COMBINED, ...NO_MATCH];
