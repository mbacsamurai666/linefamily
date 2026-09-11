import type { PrismaClient } from '@prisma/client';

/**
 * What the house has not set up yet.
 *
 * The bot's best work — a bill flagged before the late fee, a licence before it
 * expires, a dose before it is missed — only happens for things somebody told
 * it about. A family that has entered a few appointments and nothing else gets
 * a fraction of what it installed, and has no way of knowing that. This is the
 * list the app shows until each line is ticked.
 *
 * Deliberately not a wizard: every item is optional, nothing is nagged twice,
 * and a house with no medication to track is meant to leave that line unticked
 * forever.
 */

export type SetupKey =
  | 'bills'
  | 'documents'
  | 'medications'
  | 'chores'
  | 'emergency'
  | 'budgets'
  | 'birthdays';

export interface SetupItem {
  key: SetupKey;
  label: string;
  /** What this gets the family, in one line — the reason to bother. */
  hint: string;
  done: boolean;
  count: number;
}

export interface SetupStatus {
  items: SetupItem[];
  doneCount: number;
}

export async function computeSetupStatus(
  prisma: PrismaClient,
  familyId: string,
  memberId: string,
): Promise<SetupStatus> {
  const [bills, documents, medications, chores, budgets, birthdays, me] = await Promise.all([
    prisma.bill.count({ where: { familyId, active: true } }),
    prisma.document.count({ where: { familyId } }),
    prisma.medication.count({ where: { member: { familyId }, active: true } }),
    prisma.chore.count({ where: { familyId, active: true } }),
    prisma.budget.count({ where: { familyId } }),
    prisma.member.count({ where: { familyId, birthDate: { not: null } } }),
    prisma.member.findUnique({
      where: { id: memberId },
      select: { bloodType: true, allergies: true, conditions: true },
    }),
  ]);

  // One filled field is enough: a person with no allergies should not be stuck
  // with an unticked line forever.
  const emergencyFilled = Boolean(me?.bloodType || me?.allergies || me?.conditions);

  const items: SetupItem[] = [
    {
      key: 'bills',
      label: 'บิลประจำเดือน',
      hint: 'ค่าไฟ ค่าน้ำ ค่าเน็ต — เตือนก่อนครบกำหนด ไม่ต้องโดนค่าปรับ',
      done: bills > 0,
      count: bills,
    },
    {
      key: 'documents',
      label: 'เอกสารที่ต้องต่ออายุ',
      hint: 'ใบขับขี่ พ.ร.บ. ประกัน พาสปอร์ต — เตือนล่วงหน้า 60/30/7 วัน',
      done: documents > 0,
      count: documents,
    },
    {
      key: 'medications',
      label: 'ยาประจำตัว',
      hint: 'เตือนตามเวลา และเตือนซ้ำถ้ายังไม่กด "กินยาแล้ว"',
      done: medications > 0,
      count: medications,
    },
    {
      key: 'chores',
      label: 'เวรงานบ้าน',
      hint: 'หมุนเวรอัตโนมัติ บอกว่าถึงตาใคร',
      done: chores > 0,
      count: chores,
    },
    {
      key: 'emergency',
      label: 'ข้อมูลฉุกเฉินของคุณ',
      hint: 'กรุ๊ปเลือด แพ้ยา โรคประจำตัว — เปิดดูได้ทันทีตอนที่ต้องใช้จริง',
      done: emergencyFilled,
      count: emergencyFilled ? 1 : 0,
    },
    {
      key: 'budgets',
      label: 'งบรายเดือน',
      hint: 'เตือนเมื่อใช้ถึง 80% และเมื่อเกินงบ',
      done: budgets > 0,
      count: budgets,
    },
    {
      key: 'birthdays',
      label: 'วันเกิดคนในบ้าน',
      hint: 'เตือนล่วงหน้า 1 วันและวันจริง ทุกปี',
      done: birthdays > 0,
      count: birthdays,
    },
  ];

  return { items, doneCount: items.filter((i) => i.done).length };
}
