import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type BillFrequency,
  type BillInput,
  type BillItem,
  type FamilyFinance,
  type Fund,
  type FundTotals,
  type MoneyItem,
  type MonthSummary,
  type PaymentStatus,
} from './api.js';
import { baht, THAI_MONTH_SHORT, thaiShortDayMonth } from './format.js';

/**
 * The money side of the family calendar. Every piece here reads the same
 * recurring items the server lays out (Bill → occurrences), so what the board
 * shows on the 15th, what the month adds up to and what the dashboard warns
 * about are one set of numbers, not three.
 */

function readable(err: unknown): string {
  const message = (err as Error).message ?? String(err);
  const quoted = message.match(/^\d{3}[^:]*: "(.+)"$/);
  return quoted ? (quoted[1] as string) : message;
}

/**
 * An average shown to the baht. The sums behind it stay exact to the satang;
 * "7,107.33 a month" only reads as false precision.
 */
const bahtWhole = (satang: number) => baht(Math.round(satang / 100) * 100);

const bahtOrDash = (satang: number | null | undefined) => (satang === null || satang === undefined ? '—' : baht(satang));

// ----------------------------------------------------------------- status

const STATUS_LABEL: Record<'IN' | 'OUT', Record<PaymentStatus, string>> = {
  OUT: { PAID: 'จ่ายแล้ว', UNPAID: 'ยังไม่จ่าย', OVERDUE: 'เลยกำหนด', UNTRACKED: '' },
  IN: { PAID: 'ได้รับแล้ว', UNPAID: 'ยังไม่ได้รับ', OVERDUE: 'ยังไม่ได้รับ', UNTRACKED: '' },
};

export function StatusPill({ item }: { item: MoneyItem }) {
  const label = STATUS_LABEL[item.direction][item.status];
  if (!label) return null;
  const tone =
    item.status === 'PAID' ? 'pill-paid' : item.status === 'OVERDUE' && item.direction === 'OUT' ? 'pill-warn' : 'pill-muted';
  return <span className={`pill ${tone}`}>{label}</span>;
}

/** 💰 money out, 💵 money in — the same marks the board uses. */
export const moneyIcon = (item: { direction: 'IN' | 'OUT' }) => (item.direction === 'IN' ? '💵' : '💰');

// ----------------------------------------------------------------- the form

type Choice = 'once' | 'daily' | 'weekly' | 'monthly' | 'm3' | 'm6' | 'yearly' | 'custom';
type CustomUnit = 'days' | 'weeks' | 'months';

const CHOICES: Array<[Choice, string]> = [
  ['once', 'ครั้งเดียว'],
  ['monthly', 'รายเดือน'],
  ['m3', 'ทุก 3 เดือน'],
  ['m6', 'ทุก 6 เดือน'],
  ['yearly', 'รายปี'],
  ['weekly', 'รายสัปดาห์'],
  ['daily', 'รายวัน'],
  ['custom', 'กำหนดเอง'],
];

/** The form's choice for a bill as stored. */
function choiceOf(bill: BillItem): { choice: Choice; every: number; unit: CustomUnit } {
  if (bill.frequency === 'ONCE') return { choice: 'once', every: 1, unit: 'days' };
  if (bill.frequency === 'DAILY') return bill.interval === 1 ? { choice: 'daily', every: 1, unit: 'days' } : { choice: 'custom', every: bill.interval, unit: 'days' };
  if (bill.frequency === 'WEEKLY') return bill.interval === 1 ? { choice: 'weekly', every: 1, unit: 'weeks' } : { choice: 'custom', every: bill.interval, unit: 'weeks' };
  const byMonths: Record<number, Choice> = { 1: 'monthly', 3: 'm3', 6: 'm6', 12: 'yearly' };
  const known = byMonths[bill.everyMonths];
  return known ? { choice: known, every: bill.everyMonths, unit: 'months' } : { choice: 'custom', every: bill.everyMonths, unit: 'months' };
}

/** The next due day of a month-based bill that has no start date, for the form to open on. */
function nextMonthlyDue(bill: BillItem, todayKey: string): string {
  const [y, m] = todayKey.split('-').map(Number) as [number, number];
  for (let i = 0; i < 25; i++) {
    const month0 = (m - 1 + i) % 12;
    const year = y + Math.floor((m - 1 + i) / 12);
    const index = year * 12 + month0;
    const anchor = (bill.dueMonth ?? 1) - 1;
    if ((((index - anchor) % bill.everyMonths) + bill.everyMonths) % bill.everyMonths !== 0) continue;
    const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
    const key = `${year}-${String(month0 + 1).padStart(2, '0')}-${String(Math.min(bill.dueDay, last)).padStart(2, '0')}`;
    if (key >= todayKey) return key;
  }
  return todayKey;
}

const monthsBetween = (fromKey: string, toKey: string) => {
  const [fy, fm] = fromKey.split('-').map(Number) as [number, number];
  const [ty, tm] = toKey.split('-').map(Number) as [number, number];
  return Math.max(1, (ty - fy) * 12 + (tm - fm));
};

/**
 * Adding or changing a recurring money item — from the calendar ("เพิ่ม →
 * ค่าใช้จ่าย") or from the management tab, the same form either way.
 */
export function MoneyForm({
  editing,
  defaultDay,
  todayKey,
  direction: initialDirection = 'OUT',
  onSaved,
  onCancel,
}: {
  editing?: BillItem;
  /** "YYYY-MM-DD" — the day tapped on the calendar. */
  defaultDay: string;
  todayKey: string;
  direction?: 'IN' | 'OUT';
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const start = editing ? choiceOf(editing) : { choice: 'monthly' as Choice, every: 1, unit: 'months' as CustomUnit };
  const [direction, setDirection] = useState<'IN' | 'OUT'>(editing?.direction ?? initialDirection);
  const [name, setName] = useState(editing?.name ?? '');
  const [varies, setVaries] = useState(editing ? editing.amountSatang === null && editing.estimateSatang !== null : false);
  const [amount, setAmount] = useState(
    editing
      ? String(((editing.amountSatang ?? editing.estimateSatang) ?? 0) / 100 || '')
      : '',
  );
  const [choice, setChoice] = useState<Choice>(start.choice);
  const [every, setEvery] = useState(String(start.every));
  const [unit, setUnit] = useState<CustomUnit>(start.unit);
  const [day, setDay] = useState(
    editing
      ? editing.frequency === 'MONTHLY' && !editing.startsOn
        ? nextMonthlyDue(editing, todayKey)
        : (editing.startsOn ?? defaultDay)
      : defaultDay,
  );
  const [showRange, setShowRange] = useState(Boolean(editing?.endsOn));
  const [endsOn, setEndsOn] = useState(editing?.endsOn ?? '');
  const [category, setCategory] = useState(editing?.category ?? '');
  const [newCategory, setNewCategory] = useState('');
  const [categories, setCategories] = useState<{ OUT: string[]; IN: string[] } | null>(null);
  const [note, setNote] = useState(editing?.note ?? '');
  const [changes, setChanges] = useState<Array<{ effectiveFrom: string; amount: string }>>(
    editing?.amountChanges.map((c) => ({ effectiveFrom: c.effectiveFrom, amount: String(c.amountSatang / 100) })) ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.moneyCategories().then(setCategories).catch(() => setCategories({ OUT: [], IN: [] }));
  }, []);

  const n = Math.max(1, Math.floor(Number(every) || 1));
  const monthsPerCycle =
    choice === 'm3' ? 3 : choice === 'm6' ? 6 : choice === 'yearly' ? 12 : choice === 'monthly' ? 1 : choice === 'custom' && unit === 'months' ? n : 0;
  const amountSatang = Math.round(Number(amount) * 100);
  const hasAmount = amount.trim() !== '' && Number.isFinite(Number(amount));
  // What this one asks to be put aside each month, shown as it is typed.
  const reservePreview =
    direction === 'OUT' && hasAmount && amountSatang > 0
      ? choice === 'once'
        ? Math.ceil(amountSatang / monthsBetween(todayKey, day))
        : monthsPerCycle > 1
          ? Math.round(amountSatang / monthsPerCycle)
          : null
      : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('ต้องมีชื่อรายการ');
    if (hasAmount && !(amountSatang > 0)) return setError('จำนวนเงินต้องมากกว่า 0');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return setError('ต้องเลือกวันครบกำหนด');
    if (showRange && endsOn && endsOn < day) return setError('วันสิ้นสุดต้องไม่ก่อนวันครบกำหนดแรก');
    // An optional row left blank is simply not there; a half-filled one is a mistake.
    const filled = changes.filter((c) => c.effectiveFrom || c.amount.trim());
    for (const c of filled) {
      if (!c.effectiveFrom || !(Number(c.amount) > 0)) return setError('ยอดที่เปลี่ยนต้องมีทั้งวันที่และจำนวนเงินมากกว่า 0 (หรือกด "ลบ" แถวนั้น)');
    }

    const [, mm, dd] = day.split('-').map(Number) as [number, number, number];
    const frequency: BillFrequency =
      choice === 'once' ? 'ONCE' : choice === 'daily' || (choice === 'custom' && unit === 'days') ? 'DAILY' : choice === 'weekly' || (choice === 'custom' && unit === 'weeks') ? 'WEEKLY' : 'MONTHLY';
    const everyMonths = frequency === 'MONTHLY' ? monthsPerCycle || 1 : 1;
    // A month-based cycle that does not divide a year needs its own first day to count from.
    const anchored = frequency !== 'MONTHLY' || 12 % everyMonths !== 0;
    const categoryName = (category === '__new' ? newCategory : category).trim();

    const body: BillInput = {
      name: name.trim(),
      direction,
      frequency,
      interval: frequency === 'DAILY' || frequency === 'WEEKLY' ? (choice === 'custom' ? n : 1) : 1,
      everyMonths,
      dueDay: dd,
      dueMonth: everyMonths > 1 ? mm : null,
      ...(varies
        ? { amountBaht: null, estimateBaht: hasAmount ? amountSatang / 100 : null }
        : { amountBaht: hasAmount ? amountSatang / 100 : null, estimateBaht: null }),
      ...(anchored ? { startsOn: day } : editing ? {} : {}),
      endsOn: showRange && endsOn ? endsOn : null,
      note: note.trim() || null,
      categoryName: categoryName || null,
      amountChanges: filled.map((c) => ({ effectiveFrom: c.effectiveFrom, amountBaht: Number(c.amount) })),
    };

    setSaving(true);
    try {
      if (editing) {
        await api.updateBill(editing.id, body);
      } else {
        // New items only send what they have: the server fills in its defaults.
        const fresh = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null)) as unknown as BillInput;
        await api.addBill(fresh);
      }
      await onSaved();
    } catch (err) {
      setError(readable(err));
    } finally {
      setSaving(false);
    }
  };

  const list = categories?.[direction] ?? [];

  return (
    <form className="entry-form money-form" onSubmit={submit}>
      {error && <p className="error">{error}</p>}

      <div className="segmented" role="group" aria-label="ประเภทเงิน">
        <button type="button" className={direction === 'OUT' ? 'active' : ''} onClick={() => setDirection('OUT')}>
          💰 ค่าใช้จ่าย
        </button>
        <button type="button" className={direction === 'IN' ? 'active' : ''} onClick={() => setDirection('IN')}>
          💵 รายรับ
        </button>
      </div>

      <div className="field">
        <label htmlFor="money-name">ชื่อรายการ</label>
        <input
          id="money-name"
          type="text"
          placeholder={direction === 'IN' ? 'เช่น เงินเดือน' : 'เช่น ประกันรถ, ค่าเทอม'}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus={!editing}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="money-amount">{varies ? 'ยอดประมาณ (บาท)' : 'จำนวนเงิน (บาท)'}</label>
          <input
            id="money-amount"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            placeholder={varies ? 'เช่น 2500' : 'เช่น 24000'}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="money-day">{choice === 'once' ? 'วันที่' : 'ครบกำหนด (ครั้งถัดไป)'}</label>
          <input id="money-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
        </div>
      </div>
      <label className="checkbox-field">
        <input type="checkbox" checked={varies} onChange={(e) => setVaries(e.target.checked)} />
        ยอดไม่เท่ากันทุกครั้ง (ใส่ยอดประมาณไว้คำนวณ)
      </label>
      {!hasAmount && (
        <div className="muted">ถ้าไม่ใส่ยอด รายการนี้จะไม่ถูกนับในประมาณการ</div>
      )}

      <div className="field-row">
        <div className="field">
          <label htmlFor="money-freq">ความถี่</label>
          <select id="money-freq" value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
            {CHOICES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="money-cat">หมวด</label>
          <select id="money-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">— ไม่ระบุ —</option>
            {list.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value="__new">＋ เพิ่มหมวดใหม่…</option>
          </select>
        </div>
      </div>

      {choice === 'custom' && (
        <div className="field-row">
          <div className="field">
            <label htmlFor="money-every">ทุก ๆ</label>
            <input
              id="money-every"
              type="number"
              inputMode="numeric"
              min="1"
              max={unit === 'days' ? 365 : unit === 'weeks' ? 52 : 24}
              value={every}
              onChange={(e) => setEvery(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="money-unit">หน่วย</label>
            <select id="money-unit" value={unit} onChange={(e) => setUnit(e.target.value as CustomUnit)}>
              <option value="days">วัน</option>
              <option value="weeks">สัปดาห์</option>
              <option value="months">เดือน</option>
            </select>
          </div>
        </div>
      )}

      {category === '__new' && (
        <div className="field">
          <label htmlFor="money-newcat">ชื่อหมวดใหม่</label>
          <input
            id="money-newcat"
            type="text"
            maxLength={40}
            placeholder="เช่น สัตว์เลี้ยง"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
          />
        </div>
      )}

      {reservePreview !== null && (
        <div className="reserve-hint">
          🏦 ควรกันเงินเดือนละ <strong>{baht(reservePreview)}</strong> บาท
        </div>
      )}

      {choice !== 'once' && (
        <>
          <button type="button" className="link-button" onClick={() => setShowRange((v) => !v)}>
            {showRange ? 'ไม่กำหนดวันสิ้นสุด' : 'กำหนดวันสิ้นสุด (เช่น ผ่อนครบงวด)'}
          </button>
          {showRange && (
            <div className="field">
              <label htmlFor="money-ends">จ่ายครั้งสุดท้ายไม่เกินวันที่</label>
              <input id="money-ends" type="date" min={day} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </div>
          )}
        </>
      )}

      {choice !== 'once' && (
        <div className="field">
          <label>ยอดที่เปลี่ยนในอนาคต <span className="optional">(ไม่บังคับ)</span></label>
          {changes.map((c, i) => (
            <div key={i} className="field-row amount-change">
              <input
                type="date"
                aria-label="ตั้งแต่วันที่"
                value={c.effectiveFrom}
                onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { ...x, effectiveFrom: e.target.value } : x)))}
              />
              <input
                type="number"
                inputMode="decimal"
                min="0.01"
                step="0.01"
                aria-label="จำนวนเงินใหม่"
                placeholder="บาท"
                value={c.amount}
                onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              />
              <button type="button" className="link-button" onClick={() => setChanges(changes.filter((_, j) => j !== i))}>
                ลบ
              </button>
            </div>
          ))}
          <button
            type="button"
            className="link-button"
            onClick={() => setChanges([...changes, { effectiveFrom: '', amount: '' }])}
          >
            ＋ ยอดเปลี่ยนตั้งแต่วันที่… (เช่น ค่าเทอมปีหน้าขึ้น)
          </button>
        </div>
      )}

      <div className="field">
        <label htmlFor="money-note">
          หมายเหตุ <span className="optional">(ไม่บังคับ)</span>
        </label>
        <input id="money-note" type="text" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div className="field-row">
        <button type="button" className="form-toggle" onClick={onCancel}>
          ยกเลิก
        </button>
        <button type="submit" className="form-submit" disabled={saving}>
          {saving ? 'กำลังบันทึก...' : editing ? 'บันทึกการแก้ไข' : 'บันทึก'}
        </button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------------- the day's money

/**
 * A day's money on the calendar: what falls due, whether it is settled, and
 * the buttons to settle it, undo it, change it or remove it.
 */
export function MoneyRows({
  items,
  todayKey,
  onChanged,
  onEdit,
}: {
  items: MoneyItem[];
  todayKey: string;
  onChanged: () => void | Promise<void>;
  onEdit: (billId: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [paidAmount, setPaidAmount] = useState('');
  const [paidOn, setPaidOn] = useState(todayKey);
  const [payNote, setPayNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setPaying(null);
      setConfirmDelete(null);
      await onChanged();
    } catch (err) {
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {items.map((item) => {
        const key = `${item.billId}|${item.dueOn}`;
        const isOpen = open === key;
        const income = item.direction === 'IN';
        return (
          <li key={key} className={`agenda-item-wrap money-row-item money-${item.status.toLowerCase()}`}>
            <div className="agenda-item agenda-item-clickable" onClick={() => setOpen(isOpen ? null : key)}>
              <span className={`money-swatch${income ? ' dir-in' : ''}`}>{moneyIcon(item)}</span>
              <div className="agenda-text">
                <div className="money-line">
                  <span>{item.name}</span>
                  <strong className={income ? 'money-plus' : ''}>
                    {income ? '+' : ''}
                    {bahtOrDash(item.amountSatang)}
                  </strong>
                </div>
                <div className="muted">
                  <StatusPill item={item} /> {item.category ? `${item.category} · ` : ''}
                  {item.frequencyLabel}
                  {item.estimated ? ' · ยอดประมาณ' : ''}
                </div>
              </div>
              <span className="agenda-chevron">{isOpen ? '▾' : '▸'}</span>
            </div>

            {isOpen && (
              <div className="agenda-detail">
                <div className="agenda-detail-row">
                  <span className="muted">จำนวน</span>
                  <span>
                    {bahtOrDash(item.amountSatang)} บาท{item.estimated ? ' (ประมาณ)' : ''}
                  </span>
                </div>
                <div className="agenda-detail-row">
                  <span className="muted">วันครบกำหนด</span>
                  <span>{thaiShortDayMonth(item.dueOn)}</span>
                </div>
                <div className="agenda-detail-row">
                  <span className="muted">หมวด</span>
                  <span>{item.category ?? '—'}</span>
                </div>
                <div className="agenda-detail-row">
                  <span className="muted">ประเภท</span>
                  <span>{item.frequencyLabel}</span>
                </div>
                {item.reservePerMonthSatang !== null && (
                  <div className="agenda-detail-row reserve-row">
                    <span className="muted">ควรกันเงิน</span>
                    <span>เดือนละ {baht(item.reservePerMonthSatang)} บาท</span>
                  </div>
                )}
                {item.status === 'PAID' && (
                  <div className="agenda-detail-row">
                    <span className="muted">{income ? 'ได้รับจริง' : 'จ่ายจริง'}</span>
                    <span>
                      {bahtOrDash(item.paidSatang)} บาท{item.paidOn ? ` · ${thaiShortDayMonth(item.paidOn)}` : ''}
                    </span>
                  </div>
                )}

                {error && open === key && <p className="error">{error}</p>}

                {paying === key ? (
                  <form
                    className="entry-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const value = paidAmount.trim() === '' ? undefined : Number(paidAmount);
                      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
                        setError('จำนวนเงินติดลบไม่ได้');
                        return;
                      }
                      void act(() =>
                        api.payBill(item.billId, {
                          dueOn: item.dueOn,
                          ...(value !== undefined ? { amountBaht: value } : {}),
                          paidOn,
                          ...(payNote.trim() ? { note: payNote.trim() } : {}),
                        }),
                      );
                    }}
                  >
                    <div className="field-row">
                      <div className="field">
                        <label htmlFor={`paid-amount-${key}`}>{income ? 'ได้รับจริง (บาท)' : 'จ่ายจริง (บาท)'}</label>
                        <input
                          id={`paid-amount-${key}`}
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          placeholder={item.amountSatang !== null ? String(item.amountSatang / 100) : 'ใส่ยอด'}
                          value={paidAmount}
                          onChange={(e) => setPaidAmount(e.target.value)}
                          required={item.amountSatang === null}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`paid-on-${key}`}>วันที่</label>
                        <input id={`paid-on-${key}`} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor={`paid-note-${key}`}>
                        หมายเหตุ <span className="optional">(ไม่บังคับ)</span>
                      </label>
                      <input id={`paid-note-${key}`} type="text" value={payNote} onChange={(e) => setPayNote(e.target.value)} />
                    </div>
                    <div className="field-row">
                      <button type="button" className="form-toggle" onClick={() => setPaying(null)}>
                        ยกเลิก
                      </button>
                      <button type="submit" className="form-submit" disabled={busy}>
                        {busy ? 'กำลังบันทึก...' : 'บันทึก'}
                      </button>
                    </div>
                  </form>
                ) : confirmDelete === key ? (
                  <div className="row-actions">
                    <span className="muted">ลบรายการนี้ทุกงวด?</span>
                    <button type="button" className="row-btn row-btn-danger" disabled={busy} onClick={() => act(() => api.deleteBill(item.billId))}>
                      ลบเลย
                    </button>
                    <button type="button" className="row-btn" onClick={() => setConfirmDelete(null)}>
                      ไม่ลบ
                    </button>
                  </div>
                ) : (
                  <div className="row-actions">
                    {item.status === 'PAID' ? (
                      <button type="button" className="row-btn" disabled={busy} onClick={() => act(() => api.unpayBill(item.billId, item.dueOn))}>
                        ยกเลิกการ{income ? 'รับ' : 'จ่าย'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="row-btn row-btn-primary"
                        onClick={() => {
                          setPaying(key);
                          setPaidAmount('');
                          setPaidOn(todayKey);
                          setPayNote('');
                        }}
                      >
                        ✅ {income ? 'ได้รับแล้ว' : 'จ่ายแล้ว'}
                      </button>
                    )}
                    <button type="button" className="row-btn" onClick={() => onEdit(item.billId)}>
                      แก้ไข
                    </button>
                    <button type="button" className="row-btn row-btn-danger" onClick={() => setConfirmDelete(key)}>
                      ลบ
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </>
  );
}

// ----------------------------------------------------------------- the month

const THAI_MONTH_FULL = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

/** "กันยายน 2569". */
export const thaiMonthName = (monthKey: string) =>
  `${THAI_MONTH_FULL[Number(monthKey.slice(5, 7)) - 1]} ${Number(monthKey.slice(0, 4)) + 543}`;

/**
 * The month on the board, in money: what comes in, what goes out, what is put
 * aside for later, and what is left. The lumpy bills due this month are paid
 * out of their pots, so they are shown but not taken twice.
 */
export function MonthMoneySummary({ monthKey, refreshKey }: { monthKey: string; refreshKey: number }) {
  const [summary, setSummary] = useState<MonthSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSummary(null);
    api
      .monthSummary(monthKey)
      .then(setSummary)
      .catch((e: Error) => setError(readable(e)));
  }, [monthKey, refreshKey]);

  if (error) return <p className="error">{error}</p>;
  if (!summary) return <div className="month-money month-money-loading">กำลังคำนวณ…</div>;
  if (summary.items.length === 0 && summary.reserveSatang === 0) return null;

  return (
    <div className="month-money">
      <div className="month-money-title">💰 {thaiMonthName(monthKey)}</div>
      <dl className="month-money-grid">
        <dt>รายรับ</dt>
        <dd className="money-plus">{baht(summary.incomeSatang)}</dd>
        <dt>ค่าใช้จ่าย</dt>
        <dd>{baht(summary.expenseSatang)}</dd>
        {summary.lumpySatang > 0 && (
          <>
            <dt className="indent">จ่ายจากกองเงิน</dt>
            <dd className="muted">{baht(summary.lumpySatang)}</dd>
          </>
        )}
        <dt>เงินกันค่าใช้จ่ายอนาคต</dt>
        <dd>{baht(summary.reserveSatang)}</dd>
        <dt className="strong">เงินเหลือ</dt>
        <dd className={`strong${summary.leftSatang < 0 ? ' negative' : ''}`}>{baht(summary.leftSatang)}</dd>
      </dl>
      <div className="month-money-status">
        {summary.paidSatang > 0 && <span className="pill pill-paid">จ่ายแล้ว {baht(summary.paidSatang)}</span>}
        {summary.unpaidSatang > 0 && <span className="pill pill-muted">ยังไม่จ่าย {baht(summary.unpaidSatang)}</span>}
        {summary.overdueSatang > 0 && <span className="pill pill-warn">เลยกำหนด {baht(summary.overdueSatang)}</span>}
      </div>
      {(summary.actualExpenseSatang > 0 || summary.actualIncomeSatang > 0) && (
        <div className="muted month-money-actual">
          บันทึกจริงเดือนนี้: รับ {baht(summary.actualIncomeSatang)} · จ่าย {baht(summary.actualExpenseSatang)}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- the dashboard

/** Twelve months of planned spending, the pot-paid part drawn darker. */
function MonthBars({ finance }: { finance: FamilyFinance }) {
  const top = Math.max(...finance.months.map((m) => m.expenseSatang), finance.monthlyReserveSatang, 1);
  const reserveAt = (finance.monthlyReserveSatang / top) * 100;
  return (
    <div className="fin-chart" role="img" aria-label="ค่าใช้จ่าย 12 เดือนข้างหน้า">
      <div className="fin-bars">
        {finance.monthlyReserveSatang > 0 && (
          <div className="fin-reserve-line" style={{ bottom: `${reserveAt}%` }} title="เงินที่ต้องกันต่อเดือน" />
        )}
        {finance.months.map((m) => {
          const running = m.expenseSatang - m.lumpySatang;
          return (
            <div key={m.month} className="fin-bar" title={`${m.month}: ${baht(m.expenseSatang)} บาท`}>
              <span className="fin-bar-lumpy" style={{ height: `${(m.lumpySatang / top) * 100}%` }} />
              <span className="fin-bar-running" style={{ height: `${(running / top) * 100}%` }} />
            </div>
          );
        })}
      </div>
      <div className="fin-bar-labels">
        {finance.months.map((m) => (
          <span key={m.month}>{THAI_MONTH_SHORT[Number(m.month.slice(5, 7)) - 1]}</span>
        ))}
      </div>
      <div className="fin-legend">
        <span>
          <i className="fin-key-running" /> ประจำเดือน
        </span>
        <span>
          <i className="fin-key-lumpy" /> ก้อนใหญ่
        </span>
        {finance.monthlyReserveSatang > 0 && (
          <span>
            <i className="fin-key-reserve" /> เงินกัน/เดือน
          </span>
        )}
      </div>
    </div>
  );
}

export function FundTotalsRow({ totals }: { totals: FundTotals }) {
  return (
    <dl className="fund-totals">
      <div>
        <dt>ต้องกันทั้งหมด</dt>
        <dd>{baht(totals.requiredSatang)}</dd>
      </div>
      <div>
        <dt>เก็บแล้ว</dt>
        <dd>{baht(totals.reservedSatang)}</dd>
      </div>
      <div>
        <dt>ยังขาด</dt>
        <dd className={totals.remainingSatang > 0 ? 'negative' : ''}>{baht(totals.remainingSatang)}</dd>
      </div>
      <div>
        <dt>ต่อเดือน</dt>
        <dd>{baht(totals.monthlyRequiredSatang)}</dd>
      </div>
    </dl>
  );
}

/** The dashboard's money card, and the questions it answers at a glance. */
export function FinanceCard({ finance, onManage }: { finance: FamilyFinance; onManage: () => void }) {
  const empty = finance.next12MonthsSatang === 0 && finance.monthlyIncomeSatang === 0;
  if (empty) {
    return (
      <div className="dash-section">
        <div className="dash-section-heading">💰 การเงินครอบครัว</div>
        <p className="empty">
          ยังไม่มีค่าใช้จ่ายหรือรายรับประจำ — เพิ่มได้จากปฏิทิน (กดวันที่ → ＋ เพิ่ม → ค่าใช้จ่าย) หรือแท็บจัดการ
        </p>
        <button type="button" className="form-toggle" onClick={onManage}>
          ＋ ตั้งค่าใช้จ่ายประจำ
        </button>
      </div>
    );
  }

  const month = (m: { month: string } | null) => (m ? thaiMonthName(m.month) : '—');
  return (
    <div className="dash-section">
      <div className="dash-section-heading">💰 การเงินครอบครัว</div>

      {finance.alerts.length > 0 && (
        <ul className="fin-alerts">
          {finance.alerts.slice(0, 6).map((a, i) => (
            <li key={i} className={`fin-alert fin-alert-${a.level}`}>
              {a.level === 'warn' ? '⚠️' : 'ℹ️'} {a.text}
            </li>
          ))}
        </ul>
      )}

      <div className="fin-tiles">
        <div className="fin-tile">
          <span>รายได้ต่อเดือน</span>
          <strong className="money-plus">{bahtWhole(finance.monthlyIncomeSatang)}</strong>
        </div>
        <div className="fin-tile">
          <span>ค่าใช้จ่ายประจำ/เดือน</span>
          <strong>{bahtWhole(finance.monthlyRunningSatang)}</strong>
        </div>
        <div className="fin-tile">
          <span>ต้องกันเงิน/เดือน</span>
          <strong>{bahtWhole(finance.monthlyReserveSatang)}</strong>
        </div>
        <div className="fin-tile fin-tile-key">
          <span>เงินเหลือ/เดือน</span>
          <strong className={finance.monthlyLeftSatang < 0 ? 'negative' : ''}>{bahtWhole(finance.monthlyLeftSatang)}</strong>
        </div>
        <div className="fin-tile">
          <span>เดือนนี้ต้องจ่าย</span>
          <strong>{baht(finance.thisMonth.expenseSatang)}</strong>
        </div>
        <div className="fin-tile">
          <span>เดือนหน้าต้องจ่าย</span>
          <strong>{baht(finance.nextMonth.expenseSatang)}</strong>
        </div>
      </div>

      <div className="fin-subhead">
        ค่าใช้จ่าย 12 เดือนข้างหน้า <strong>{baht(finance.next12MonthsSatang)}</strong> บาท
      </div>
      <MonthBars finance={finance} />
      <div className="muted fin-extremes">
        สูงสุด {month(finance.highest)} {finance.highest ? baht(finance.highest.expenseSatang) : ''} · ต่ำสุด{' '}
        {month(finance.lowest)} {finance.lowest ? baht(finance.lowest.expenseSatang) : ''}
      </div>

      {finance.upcoming.length > 0 && (
        <>
          <div className="fin-subhead">ใกล้ครบกำหนด (30 วัน)</div>
          <ul className="list fin-upcoming">
            {finance.upcoming.slice(0, 6).map((i) => (
              <li key={`${i.billId}|${i.dueOn}`} className="plan-item">
                <span className="plan-item-day">{thaiShortDayMonth(i.dueOn)}</span>
                <span className="plan-item-name">
                  {i.name} <StatusPill item={i} />
                </span>
                <span className="plan-item-amount">{bahtOrDash(i.amountSatang)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {finance.funds.length > 0 && (
        <>
          <div className="fin-subhead">🏦 กองเงิน</div>
          <FundTotalsRow totals={finance.fundTotals} />
        </>
      )}

      <button type="button" className="link-button" onClick={onManage}>
        จัดการค่าใช้จ่ายและกองเงิน →
      </button>
    </div>
  );
}

// ----------------------------------------------------------------- the pots

/** One pot per lumpy bill: how full it is, and money in or out. */
export function FundsSection() {
  const [data, setData] = useState<{ items: Fund[]; totals: FundTotals } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ billId: string; sign: 1 | -1 } | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [history, setHistory] = useState<{
    billId: string;
    items: Array<{ id: string; amountSatang: number; at: string; note: string | null; fromPayment: boolean }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .funds()
      .then(setData)
      .catch((e: Error) => setError(readable(e)));
  useEffect(() => {
    void load();
  }, []);

  const openHistory = async (billId: string) => {
    if (history?.billId === billId) return setHistory(null);
    const r = await api.fundEntries(billId);
    setHistory({ billId, items: r.items });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!moving) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return setError('จำนวนเงินต้องมากกว่า 0');
    setBusy(true);
    setError(null);
    try {
      await api.addFundEntry(moving.billId, { amountBaht: value * moving.sign, ...(note.trim() ? { note: note.trim() } : {}) });
      setMoving(null);
      setAmount('');
      setNote('');
      if (history?.billId === moving.billId) setHistory(null);
      await load();
    } catch (err) {
      setError(readable(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash-section" id="section-funds">
      <div className="dash-section-heading">🏦 กองเงิน</div>
      <p className="muted">
        ค่าใช้จ่ายก้อนใหญ่ (รายปี ทุก 3–6 เดือน หรือครั้งเดียว) มีกองของตัวเอง เก็บทีละเดือน พอถึงวันจ่าย
        ระบบหักจากกองให้เอง
      </p>
      {error && <p className="error">{error}</p>}
      {!data ? (
        <p className="loading">กำลังโหลด...</p>
      ) : data.items.length === 0 ? (
        <p className="empty">ยังไม่มีค่าใช้จ่ายก้อนใหญ่ — ตั้งรายการแบบรายปี ทุก 6 เดือน หรือครั้งเดียว แล้วกองจะขึ้นเอง</p>
      ) : (
        <>
          <FundTotalsRow totals={data.totals} />
          <ul className="list">
            {data.items.map((f) => {
              const pct = Math.min(100, Math.round((Math.max(0, f.savedSatang) / Math.max(1, f.targetSatang)) * 100));
              return (
                <li key={f.billId} className="fund-item">
                  <div className="fund-head">
                    <strong>กอง{f.name}</strong>
                    <span className="muted">
                      {f.frequencyLabel} · ครบ {thaiShortDayMonth(f.nextDueOn)}
                    </span>
                  </div>
                  <div className="bar-track">
                    <div className={`bar-fill${f.behindSatang > 0 ? ' bar-behind' : ''}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="fund-numbers">
                    <span>เป้าหมาย {baht(f.targetSatang)}</span>
                    <span>เก็บแล้ว {baht(f.savedSatang)}</span>
                    <span className={f.shortSatang > 0 ? 'negative' : 'money-plus'}>
                      {f.shortSatang > 0 ? `ขาดอีก ${baht(f.shortSatang)}` : 'ครบแล้ว ✅'}
                    </span>
                  </div>
                  <div className="muted">
                    ต้องเก็บเดือนละ {baht(f.perMonthSatang)}
                    {f.behindSatang > 0 && ` · ตามหลังอยู่ — ช่วง ${f.monthsLeft} เดือนนี้ต้องเก็บเดือนละ ${baht(f.catchUpPerMonthSatang)}`}
                  </div>

                  {moving?.billId === f.billId ? (
                    <form className="entry-form" onSubmit={save}>
                      <div className="field-row">
                        <div className="field">
                          <label htmlFor={`fund-amt-${f.billId}`}>{moving.sign > 0 ? 'ฝากเข้ากอง (บาท)' : 'ถอนออก (บาท)'}</label>
                          <input
                            id={`fund-amt-${f.billId}`}
                            type="number"
                            inputMode="decimal"
                            min="0.01"
                            step="0.01"
                            value={amount}
                            placeholder={moving.sign > 0 ? String(f.perMonthSatang / 100) : ''}
                            onChange={(e) => setAmount(e.target.value)}
                            required
                            autoFocus
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`fund-note-${f.billId}`}>หมายเหตุ</label>
                          <input id={`fund-note-${f.billId}`} type="text" value={note} onChange={(e) => setNote(e.target.value)} />
                        </div>
                      </div>
                      <div className="field-row">
                        <button type="button" className="form-toggle" onClick={() => setMoving(null)}>
                          ยกเลิก
                        </button>
                        <button type="submit" className="form-submit" disabled={busy}>
                          บันทึก
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="row-actions">
                      <button type="button" className="row-btn row-btn-primary" onClick={() => { setMoving({ billId: f.billId, sign: 1 }); setAmount(''); }}>
                        ＋ ฝาก
                      </button>
                      <button type="button" className="row-btn" onClick={() => { setMoving({ billId: f.billId, sign: -1 }); setAmount(''); }}>
                        − ถอน
                      </button>
                      <button type="button" className="row-btn" onClick={() => openHistory(f.billId)}>
                        {history?.billId === f.billId ? 'ซ่อนประวัติ' : 'ประวัติ'}
                      </button>
                    </div>
                  )}

                  {history?.billId === f.billId && (
                    <ul className="list fund-history">
                      {history.items.length === 0 && <li className="muted">ยังไม่มีรายการ</li>}
                      {history.items.map((h) => (
                        <li key={h.id} className="plan-item">
                          <span className="plan-item-day">{thaiShortDayMonth(h.at.slice(0, 10))}</span>
                          <span className="plan-item-name">{h.note ?? (h.amountSatang > 0 ? 'ฝาก' : 'ถอน')}</span>
                          <span className={`plan-item-amount ${h.amountSatang < 0 ? 'negative' : 'money-plus'}`}>
                            {h.amountSatang > 0 ? '+' : ''}
                            {baht(h.amountSatang)}
                          </span>
                          {!h.fromPayment && (
                            <button
                              type="button"
                              className="link-button"
                              onClick={async () => {
                                await api.deleteFundEntry(h.id);
                                setHistory(null);
                                await load();
                              }}
                            >
                              ลบ
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

/** Group money items by day key, for the board and the day list. */
export function useMoneyByDay(items: MoneyItem[] | undefined) {
  return useMemo(() => {
    const map = new Map<string, MoneyItem[]>();
    for (const item of items ?? []) {
      const bucket = map.get(item.dueOn);
      if (bucket) bucket.push(item);
      else map.set(item.dueOn, [item]);
    }
    return map;
  }, [items]);
}
