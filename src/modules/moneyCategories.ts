/**
 * Where a family's money usually goes, offered when filing a recurring item
 * so nobody starts from a blank box. They are only suggestions: a category
 * exists once something is filed under it, and the family can name its own.
 */
export const STARTER_EXPENSE_CATEGORIES = [
  'บ้าน',
  'รถ',
  'การศึกษา',
  'สุขภาพ',
  'ประกัน',
  'หนี้สิน',
  'ครอบครัว',
  'อาหาร',
  'เดินทาง',
  'ท่องเที่ยว',
  'บันเทิง',
  'สมาชิก/Subscription',
  'ธุรกิจ',
  'อื่น ๆ',
] as const;

export const STARTER_INCOME_CATEGORIES = ['เงินเดือน', 'ธุรกิจ', 'ค่าเช่า', 'เงินปันผล', 'อื่น ๆ'] as const;
