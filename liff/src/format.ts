export function baht(satang: number): string {
  return (satang / 100).toLocaleString('th-TH', { maximumFractionDigits: 2 });
}

const KIND_LABEL: Record<string, string> = {
  EVENT: 'นัดหมาย',
  BILL: 'บิล',
  DOCUMENT: 'เอกสาร',
  MEDICATION: 'ยา',
  CHORE: 'งานบ้าน',
  BUDGET_ALERT: 'งบประมาณ',
  BIRTHDAY: 'วันเกิด',
  LOAN_DUE: 'เงินกู้ครบกำหนด',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

const ASSET_CATEGORY_LABEL: Record<string, string> = {
  PROPERTY: 'บ้าน/ที่ดิน',
  VEHICLE: 'รถ',
  ELECTRONICS: 'เครื่องใช้ไฟฟ้า',
  JEWELRY: 'ของมีค่า',
  INVESTMENT: 'เงินลงทุน',
  OTHER: 'อื่นๆ',
};

export function assetCategoryLabel(category: string): string {
  return ASSET_CATEGORY_LABEL[category] ?? category;
}

export const ASSET_CATEGORIES = ['PROPERTY', 'VEHICLE', 'ELECTRONICS', 'JEWELRY', 'INVESTMENT', 'OTHER'] as const;

const ASSET_CATEGORY_ICON: Record<string, string> = {
  PROPERTY: '🏠',
  VEHICLE: '🚗',
  ELECTRONICS: '📱',
  JEWELRY: '💎',
  INVESTMENT: '📈',
  OTHER: '📦',
};

export function assetCategoryIcon(category: string): string {
  return ASSET_CATEGORY_ICON[category] ?? '📦';
}

/** "วันศุกร์ที่ 5 กันยายน 2569" — today's date for the header, no time. */
export function thaiFullDate(date: Date): string {
  const parts = date.toLocaleDateString('th-TH-u-ca-buddhist', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return parts;
}

export function thaiDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('th-TH', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function thaiTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

/**
 * "YYYY-MM-DD" for `iso`, evaluated in `timezone` — not the browser's own
 * zone, which may not be Asia/Bangkok. 'en-CA' is just a locale that happens
 * to format dates in this exact order with '-' separators.
 */
export function dayKey(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** The day after a "YYYY-MM-DD" key, as a key — calendar arithmetic only, no zone. */
function nextKey(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Every day an appointment covers: one for most, seven for "เที่ยว 1-7 ต.ค.".
 * An all-day span's end is its last day, inclusive.
 */
export function eventDayKeys(ev: { startAt: string; endAt: string | null }, timezone: string): string[] {
  const first = dayKey(ev.startAt, timezone);
  const last = ev.endAt ? dayKey(ev.endAt, timezone) : first;
  const keys = [first];
  for (let k = first; k < last && keys.length < 400; ) {
    k = nextKey(k);
    keys.push(k);
  }
  return keys;
}

/** "1–7 ต.ค." style label for a span's days, or null for a single day. */
export function spanLabel(ev: { startAt: string; endAt: string | null }, timezone: string): string | null {
  const keys = eventDayKeys(ev, timezone);
  if (keys.length < 2) return null;
  return `${thaiShortDayMonth(keys[0]!)} – ${thaiShortDayMonth(keys[keys.length - 1]!)}`;
}

const EVENT_CATEGORY_LABEL: Record<string, string> = {
  SCHOOL: 'โรงเรียน',
  TRAVEL: 'เที่ยว',
  WORK: 'งาน',
  MEDICAL: 'หมอ',
  GOVERNMENT: 'ราชการ',
  SOCIAL: 'สังคม',
  OTHER: 'นัด',
};

const EVENT_CATEGORY_ICON: Record<string, string> = {
  SCHOOL: '🏫',
  TRAVEL: '✈️',
  WORK: '💼',
  MEDICAL: '🏥',
  GOVERNMENT: '🏛️',
  SOCIAL: '🎉',
  OTHER: '📌',
};

/** In the order the filter chips and the form's picker show them. */
export const EVENT_CATEGORIES = ['SCHOOL', 'TRAVEL', 'WORK', 'MEDICAL', 'GOVERNMENT', 'SOCIAL', 'OTHER'] as const;

export function eventCategoryLabel(category: string): string {
  return EVENT_CATEGORY_LABEL[category] ?? category;
}

export function eventCategoryIcon(category: string): string {
  return EVENT_CATEGORY_ICON[category] ?? (EVENT_CATEGORY_ICON.OTHER as string);
}

/** Month names for the board's own picker. */
export const THAI_MONTH_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

/** What one appointment's reminders can be set to, longest first. */
export const EVENT_REMINDERS: Array<[number, string]> = [
  [7 * 24 * 60, '7 วัน'],
  [3 * 24 * 60, '3 วัน'],
  [24 * 60, '1 วัน'],
  [120, '2 ชม.'],
  [30, '30 นาที'],
];

const THAI_MONTHS_FULL = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

/** "กันยายน 2569" for a JS Date's own (0-indexed) month/year. */
export function thaiMonthYear(year: number, month0: number): string {
  return `${THAI_MONTHS_FULL[month0]} ${year + 543}`;
}

const THAI_MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

/** "5 ก.ย." for a "YYYY-MM-DD" key — no year, used in a week-range label. */
export function thaiShortDayMonth(dayKeyStr: string): string {
  const parts = dayKeyStr.split('-').map(Number);
  const month = parts[1] as number;
  const day = parts[2] as number;
  return `${day} ${THAI_MONTHS_SHORT[month - 1]}`;
}

/**
 * Minutes since local midnight for `iso`, evaluated in `timezone` — not the
 * browser's own zone, for the same reason dayKey isn't either.
 */
export function minutesOfDay(iso: string, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  ID_CARD: 'บัตรประชาชน',
  PASSPORT: 'พาสปอร์ต',
  DRIVER_LICENSE: 'ใบขับขี่',
  VEHICLE_TAX: 'พ.ร.บ./ทะเบียนรถ',
  INSURANCE: 'ประกัน',
  VISA: 'วีซ่า',
  OTHER: 'เอกสาร',
};

export function documentTypeLabel(type: string): string {
  return DOCUMENT_TYPE_LABEL[type] ?? type;
}

export const DOCUMENT_TYPES = Object.keys(DOCUMENT_TYPE_LABEL);

const CADENCE_LABEL: Record<string, string> = {
  DAILY: 'ทุกวัน',
  WEEKLY: 'ทุกสัปดาห์',
  MONTHLY: 'ทุกเดือน',
};

export function cadenceLabel(cadence: string): string {
  return CADENCE_LABEL[cadence] ?? cadence;
}

/** The repeats the picker offers — the same RRULEs the chat parser produces. */
export const REPEAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'ไม่ซ้ำ' },
  { value: 'FREQ=DAILY', label: 'ทุกวัน' },
  { value: 'FREQ=WEEKLY', label: 'ทุกสัปดาห์' },
  { value: 'FREQ=MONTHLY', label: 'ทุกเดือน' },
  { value: 'FREQ=YEARLY', label: 'ทุกปี' },
];

export function repeatLabel(rrule: string | null | undefined): string {
  if (!rrule) return 'ไม่ซ้ำ';
  const known = REPEAT_OPTIONS.find((o) => o.value === rrule);
  if (known) return known.label;

  // Weekly-on-a-weekday comes from chat ("ทุกวันจันทร์") and has no picker entry.
  const byDay = rrule.match(/BYDAY=(MO|TU|WE|TH|FR|SA|SU)/)?.[1];
  const dayName: Record<string, string> = {
    MO: 'จันทร์', TU: 'อังคาร', WE: 'พุธ', TH: 'พฤหัสบดี', FR: 'ศุกร์', SA: 'เสาร์', SU: 'อาทิตย์',
  };
  if (byDay) return `ทุกวัน${dayName[byDay]}`;

  const monthDay = rrule.match(/BYMONTHDAY=(\d{1,2})/)?.[1];
  if (monthDay) return `ทุกวันที่ ${monthDay}`;

  return 'ซ้ำ';
}

/** "09:30" for `iso`, in `timezone` — what a type="time" input expects. */
export function clockHHmm(iso: string, timezone: string): string {
  const total = minutesOfDay(iso, timezone);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** A distinct color per appointment category, for the week timeline's blocks. */
const EVENT_CATEGORY_COLOR: Record<string, string> = {
  MEDICAL: '#2f8fd6',
  SCHOOL: '#7a5fd6',
  GOVERNMENT: '#8a8f98',
  SOCIAL: '#e0813f',
  WORK: '#049b43',
  TRAVEL: '#e0487f',
  OTHER: '#06c755',
};

export function eventCategoryColor(category: string): string {
  return EVENT_CATEGORY_COLOR[category] ?? (EVENT_CATEGORY_COLOR.OTHER as string);
}
