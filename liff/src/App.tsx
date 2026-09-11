import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type Asset,
  type AgendaItem,
  type BillItem,
  type ChoreItem,
  type DashboardData,
  type Deposit,
  type DocumentItem,
  type EventDetail,
  type EventSummary,
  type ExpenseSummary,
  type Holiday,
  type Loan,
  type MedicationItem,
  type Me,
  type ShoppingItem,
  type TaskItem,
  type TransactionItem,
} from './api.js';
import { Mascot, moodForDay } from './Mascot.js';
import {
  ASSET_CATEGORIES,
  EVENT_CATEGORIES,
  REPEAT_OPTIONS,
  assetCategoryIcon,
  assetCategoryLabel,
  baht,
  cadenceLabel,
  clockHHmm,
  dayKey,
  DOCUMENT_TYPES,
  documentTypeLabel,
  eventCategoryColor,
  eventCategoryLabel,
  kindLabel,
  minutesOfDay,
  repeatLabel,
  thaiDate,
  thaiFullDate,
  thaiMonthYear,
  thaiShortDayMonth,
  thaiTimeOnly,
} from './format.js';

type Tab = 'dashboard' | 'tasks' | 'agenda' | 'money' | 'shopping' | 'manage';

const WEEKDAY_LABELS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

/** "YYYY-MM-DD" + N days -> "YYYY-MM-DD", via local Date field arithmetic
 * (matches how the month grid itself builds day keys) rather than parsing
 * the string as an ISO instant, which would be UTC-based and off by a
 * timezone offset. */
function addDaysToKey(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

/** The Sunday on or before `key`. */
function weekStartKeyOf(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const dow = new Date(y, m - 1, d).getDay(); // 0 = Sunday
  return addDaysToKey(key, -dow);
}

const WEEK_DAY_START_HOUR = 7;
const WEEK_DAY_END_HOUR = 21;
const WEEK_HOUR_PX = 44;
const WEEK_HOURS = Array.from(
  { length: WEEK_DAY_END_HOUR - WEEK_DAY_START_HOUR + 1 },
  (_, i) => WEEK_DAY_START_HOUR + i,
);

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  // A day tapped on the dashboard's board, for the calendar tab to open on.
  const [calendarDay, setCalendarDay] = useState<string | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="screen center error">{error}</div>;
  if (!me) return <div className="screen center loading">กำลังโหลด...</div>;

  const initial = me.displayName.trim().charAt(0) || '🏡';

  return (
    <div className="screen">
      <header className="topbar">
        <div className="avatar">{initial}</div>
        <div className="greeting">บ้านเรา · {me.displayName}</div>
      </header>

      <main className="content">
        {tab === 'dashboard' && (
          <DashboardTab
            timezone={me.timezone}
            displayName={me.displayName}
            onOpenDay={(key) => {
              setCalendarDay(key);
              setTab('agenda');
            }}
          />
        )}
        {tab === 'tasks' && <TasksTab timezone={me.timezone} />}
        {tab === 'agenda' && <CalendarTab timezone={me.timezone} initialDay={calendarDay} />}
        {tab === 'money' && <MoneyTab />}
        {tab === 'shopping' && <ShoppingTab />}
        {tab === 'manage' && <ManageTab />}
      </main>

      <nav className="tabbar">
        {(
          [
            ['dashboard', '🏠', 'หน้าหลัก'],
            ['tasks', '📋', 'งาน'],
            ['agenda', '📅', 'ปฏิทิน'],
            ['money', '💰', 'เงิน'],
            ['shopping', '🛒', 'ซื้อของ'],
            ['manage', '⚙️', 'จัดการ'],
          ] as const
        ).map(([key, icon, label]) => (
          <button
            key={key}
            className={tab === key ? 'active' : ''}
            onClick={() => {
              // The tab bar always opens the calendar on today.
              if (key === 'agenda') setCalendarDay(null);
              setTab(key);
            }}
          >
            <span className="tab-icon">{icon}</span>
            <span className="tab-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/**
 * Edit / delete buttons for one row. Deleting asks first, inline — a mis-tap
 * on a list of small rows is easy, and nothing here can be undone from the app.
 */
function RowActions({
  onEdit,
  onDelete,
  extra,
}: {
  onEdit?: () => void;
  onDelete: () => void | Promise<void>;
  extra?: { label: string; onClick: () => void | Promise<void> };
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (confirming) {
    return (
      <div className="row-actions">
        <span className="muted">ลบรายการนี้?</span>
        <button
          type="button"
          className="row-btn row-btn-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onDelete();
            } finally {
              setBusy(false);
              setConfirming(false);
            }
          }}
        >
          {busy ? '...' : 'ลบเลย'}
        </button>
        <button type="button" className="row-btn" onClick={() => setConfirming(false)}>
          ยกเลิก
        </button>
      </div>
    );
  }

  return (
    <div className="row-actions">
      {extra && (
        <button type="button" className="row-btn" onClick={() => void extra.onClick()}>
          {extra.label}
        </button>
      )}
      {onEdit && (
        <button type="button" className="row-btn" onClick={onEdit}>
          แก้ไข
        </button>
      )}
      <button type="button" className="row-btn" onClick={() => setConfirming(true)}>
        ลบ
      </button>
    </div>
  );
}

function UpcomingSection({ heading, items }: { heading: string; items: AgendaItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="dash-section">
      <div className="dash-section-heading">
        {heading} ({items.length})
      </div>
      <ul className="list">
        {items.map((item) => (
          <li key={item.id} className="agenda-item">
            <span className="badge">{kindLabel(item.kind)}</span>
            <div className="agenda-text">
              <div>{item.text}</div>
              <div className="muted">{thaiTimeOnly(item.dueAt)}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DashboardTab({
  timezone,
  displayName,
  onOpenDay,
}: {
  timezone: string;
  displayName: string;
  onOpenDay: (key: string) => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incomeAmount, setIncomeAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [board, setBoard] = useState<{ events: EventSummary[]; holidays: Holiday[] } | null>(null);

  const todayKey = useMemo(() => dayKey(new Date().toISOString(), timezone), [timezone]);

  const load = () => api.dashboard().then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
    const [from, to] = monthRange(todayKey.slice(0, 7));
    // The board is a nicety on this page — if it fails, the rest still stands.
    api
      .events(from, to)
      .then((r) => setBoard({ events: r.items, holidays: r.holidays }))
      .catch(() => setBoard({ events: [], holidays: [] }));
  }, []);

  const addIncome = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountBaht = Number(incomeAmount);
    if (!Number.isFinite(amountBaht) || amountBaht <= 0) return;

    setSaving(true);
    try {
      await api.addExpense({ amountBaht, direction: 'IN' });
      setIncomeAmount('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="loading">กำลังโหลด...</p>;

  const { upcoming, money, netWorth, tasks } = data;
  const noUpcoming =
    upcoming.today.length === 0 && upcoming.next3d.length === 0 && upcoming.next7d.length === 0;

  const nwMax = Math.max(netWorth.loansOutstandingSatang, netWorth.assetsValueSatang, netWorth.depositsSatang, 1);

  const openTasks = tasks.todo + tasks.doing;
  const totalToday = openTasks + tasks.doneToday;
  const mood = moodForDay({
    openTasks,
    doneToday: tasks.doneToday,
    hour: Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' })
        .format(new Date()),
    ),
  });

  return (
    <div>
      <div className="room">
        <div className="wood-sign">
          <div className="wood-sign-title">สวัสดีครับ คุณ{displayName} 👋</div>
          <div className="wood-sign-sub">{thaiFullDate(new Date())}</div>
        </div>

        <div className="chalkboard" style={{ marginTop: 14 }}>
          <div className="chalk-title">บอร์ดวันนี้</div>
          <div className="chalk-row">
            <span>นัดวันนี้</span>
            <span className="chalk-num">{upcoming.today.length}</span>
          </div>
          {upcoming.today.length === 0 && (
            <div className="chalk-note">
              วันนี้ยังไม่มีนัดครับ
              <div className="muted">เพิ่มได้ที่แท็บปฏิทิน</div>
            </div>
          )}
          <div className="chalk-row">
            <span>งานค้าง</span>
            <span className="chalk-num">{openTasks}</span>
          </div>
          <div style={{ fontSize: 12, textAlign: 'right', marginBottom: 6 }}>
            เสร็จวันนี้ {tasks.doneToday}/{totalToday || 0}
          </div>
          <div className="chalk-progress">
            <span
              style={{ width: `${totalToday === 0 ? 0 : (tasks.doneToday / totalToday) * 100}%` }}
            />
          </div>
        </div>

        <div className="room-calendar">
          <CalendarBoard
            compact
            monthKey={todayKey.slice(0, 7)}
            todayKey={todayKey}
            events={board?.events ?? null}
            holidays={board?.holidays ?? []}
            timezone={timezone}
            onSelect={onOpenDay}
          />
        </div>

        <div className="room-scene">
          <div className="speech">
            {openTasks === 0
              ? 'วันนี้สบายๆ เลยครับ'
              : tasks.doing > 0
                ? `กำลังทำอยู่ ${tasks.doing} งานครับ`
                : `มีงานรออยู่ ${openTasks} งานครับ`}
          </div>
          <Mascot who="boy" mood={mood} size={112} />
          <Mascot who="girl" mood={mood === 'sleepy' ? 'sleepy' : 'happy'} size={112} />
        </div>
        <div className="room-desk" />
      </div>

      <div className="dash-section">
        <div className="dash-section-heading">⏰ กำลังจะถึง</div>
        {noUpcoming ? (
          <p className="empty">ไม่มีอะไรใน 7 วันนี้ครับ</p>
        ) : (
          <>
            <UpcomingSection heading="วันนี้" items={upcoming.today} />
            <UpcomingSection heading="ใน 3 วัน" items={upcoming.next3d} />
            <UpcomingSection heading="ใน 7 วัน" items={upcoming.next7d} />
          </>
        )}
      </div>

      <div className="dash-section">
        <div className="dash-section-heading">💵 รายรับ-รายจ่ายเดือนนี้</div>
        <div className="money-row">
          <div className="money-tile money-in">
            <div className="money-label">▲ รายรับ</div>
            <div className="money-value">{baht(money.incomeSatang)}</div>
          </div>
          <div className="money-tile money-out">
            <div className="money-label">▼ รายจ่าย</div>
            <div className="money-value">{baht(money.expenseSatang)}</div>
          </div>
        </div>
        <div className="total">
          คงเหลือสุทธิ{' '}
          <strong className={money.netSatang < 0 ? 'negative' : ''}>{baht(money.netSatang)}</strong> บาท
        </div>
        <form className="entry-form" onSubmit={addIncome}>
          <div className="field-row">
            <div className="field">
              <label htmlFor="income-amount">จำนวนรายรับ (บาท)</label>
              <input
                id="income-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="เช่น 30000"
                value={incomeAmount}
                onChange={(e) => setIncomeAmount(e.target.value)}
                required
              />
            </div>
          </div>
          <button type="submit" className="form-submit" disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกรายรับ'}
          </button>
        </form>
      </div>

      <div className="dash-section">
        <div className="dash-section-heading">📊 ฐานะการเงิน</div>
        <ul className="list">
          <li className="category-row">
            <div className="category-name">เงินให้ยืม</div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${(netWorth.loansOutstandingSatang / nwMax) * 100}%` }} />
            </div>
            <div className="category-amount">{baht(netWorth.loansOutstandingSatang)}</div>
          </li>
          <li className="category-row">
            <div className="category-name">ทรัพย์สิน</div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${(netWorth.assetsValueSatang / nwMax) * 100}%` }} />
            </div>
            <div className="category-amount">{baht(netWorth.assetsValueSatang)}</div>
          </li>
          <li className="category-row">
            <div className="category-name">เงินฝาก</div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${(netWorth.depositsSatang / nwMax) * 100}%` }} />
            </div>
            <div className="category-amount">{baht(netWorth.depositsSatang)}</div>
          </li>
        </ul>
        <div className="total">
          รวมทั้งหมด <strong>{baht(netWorth.totalSatang)}</strong> บาท
        </div>
      </div>
    </div>
  );
}

interface CalendarBoardProps {
  /** "YYYY-MM". */
  monthKey: string;
  todayKey: string;
  selected?: string;
  /** Null while the month is still loading. */
  events: EventSummary[] | null;
  holidays: Holiday[];
  timezone: string;
  onSelect: (key: string) => void;
  /** Omit to hide the month arrows (the dashboard shows only this month). */
  onMonth?: (delta: number) => void;
  /** Dots instead of titles — for the small copy hanging in the dashboard room. */
  compact?: boolean;
}

/**
 * The calendar board: a paper wall calendar, the kind that hangs in a Thai
 * kitchen — Sundays and public holidays in red, the holiday's name written
 * under the date, and each day's appointments pencilled into the square.
 *
 * It reads appointments on the day they happen (GET /events), never reminder
 * times — see modules/calendar.ts for why the old dot grid got that wrong.
 */
function CalendarBoard({
  monthKey,
  todayKey,
  selected,
  events,
  holidays,
  timezone,
  onSelect,
  onMonth,
  compact = false,
}: CalendarBoardProps) {
  const [year, month] = monthKey.split('-').map(Number) as [number, number];
  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month, 0).getDate();
  const [monthName] = thaiMonthYear(year, month - 1).split(' ');

  const byDay = useMemo(() => {
    const map = new Map<string, EventSummary[]>();
    for (const ev of events ?? []) {
      const key = dayKey(ev.startAt, timezone);
      const bucket = map.get(key);
      if (bucket) bucket.push(ev);
      else map.set(key, [ev]);
    }
    // All-day first, then by time — the order someone would write them in.
    for (const bucket of map.values()) {
      bucket.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startAt.localeCompare(b.startAt));
    }
    return map;
  }, [events, timezone]);

  const holidayByDay = useMemo(() => new Map(holidays.map((h) => [h.date, h.name])), [holidays]);

  const cells: Array<{ key: string; day: number; weekday: number } | null> = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({
      key: `${monthKey}-${String(day).padStart(2, '0')}`,
      day,
      weekday: (firstWeekday + day - 1) % 7,
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const maxChips = 2;

  return (
    <div className={`board-cal${compact ? ' board-cal-compact' : ''}`}>
      <div className="board-rings" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} />
        ))}
      </div>

      <div className="board-head">
        {onMonth && (
          <button type="button" className="board-nav" onClick={() => onMonth(-1)} aria-label="เดือนก่อนหน้า">
            ‹
          </button>
        )}
        <div className="board-title">
          <span className="board-month">{monthName}</span>
          <span className="board-year">พ.ศ. {year + 543}</span>
        </div>
        {onMonth && (
          <button type="button" className="board-nav" onClick={() => onMonth(1)} aria-label="เดือนถัดไป">
            ›
          </button>
        )}
      </div>

      <div className="board-weekdays">
        {WEEKDAY_LABELS.map((w, i) => (
          <div key={w} className={i === 0 ? 'board-sun' : i === 6 ? 'board-sat' : ''}>
            {w}
          </div>
        ))}
      </div>

      <div className="board-grid">
        {cells.map((cell, i) => {
          if (!cell) return <div key={`blank-${i}`} className="board-day board-day-blank" />;

          const dayEvents = byDay.get(cell.key) ?? [];
          const holiday = holidayByDay.get(cell.key);
          const red = cell.weekday === 0 || holiday !== undefined;
          const extra = dayEvents.length - maxChips;

          return (
            <button
              type="button"
              key={cell.key}
              className={[
                'board-day',
                red ? 'board-day-red' : cell.weekday === 6 ? 'board-day-sat' : '',
                cell.key === todayKey ? 'board-day-today' : '',
                cell.key === selected ? 'board-day-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onSelect(cell.key)}
              aria-label={[
                `วันที่ ${cell.day}`,
                holiday,
                dayEvents.length > 0 ? `${dayEvents.length} นัด` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              <span className="board-num">{cell.day}</span>

              {compact ? (
                dayEvents.length > 0 && (
                  <span className="board-dots">
                    {dayEvents.slice(0, 3).map((ev, j) => (
                      <span key={j} style={{ background: eventCategoryColor(ev.category) }} />
                    ))}
                  </span>
                )
              ) : (
                <>
                  {holiday && <span className="board-holiday">{holiday}</span>}
                  {dayEvents.slice(0, maxChips).map((ev, j) => (
                    <span
                      key={`${ev.id}-${j}`}
                      className="board-chip"
                      style={{ '--chip': eventCategoryColor(ev.category) } as React.CSSProperties}
                    >
                      {ev.title}
                    </span>
                  ))}
                  {extra > 0 && <span className="board-more">+{extra}</span>}
                </>
              )}
            </button>
          );
        })}
      </div>

      {events === null && <div className="board-loading">กำลังโหลด...</div>}
    </div>
  );
}

/** The labelled facts of one appointment, shared by the board and the week view. */
function EventDetailRows({ detail }: { detail: EventDetail }) {
  return (
    <>
      <div className="agenda-detail-row">
        <span className="muted">ประเภท</span>
        <span>{eventCategoryLabel(detail.category)}</span>
      </div>
      <div className="agenda-detail-row">
        <span className="muted">เวลา</span>
        <span>{detail.allDay ? 'ทั้งวัน' : thaiTimeOnly(detail.startAt)}</span>
      </div>
      {detail.rrule && (
        <div className="agenda-detail-row">
          <span className="muted">ทำซ้ำ</span>
          <span>{repeatLabel(detail.rrule)}</span>
        </div>
      )}
      {detail.location && (
        <div className="agenda-detail-row">
          <span className="muted">สถานที่</span>
          <span>{detail.location}</span>
        </div>
      )}
      {detail.attendeeNames.length > 0 && (
        <div className="agenda-detail-row">
          <span className="muted">สำหรับ</span>
          <span>{detail.attendeeNames.join(', ')}</span>
        </div>
      )}
      {detail.note && (
        <div className="agenda-detail-row">
          <span className="muted">หมายเหตุ</span>
          <span>{detail.note}</span>
        </div>
      )}
    </>
  );
}

/** "YYYY-MM" -> the ISO bounds of that whole month, for GET /events. */
function monthRange(monthKey: string): [string, string] {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  const last = new Date(y, m, 0).getDate();
  return [`${monthKey}-01T00:00:00`, `${monthKey}-${String(last).padStart(2, '0')}T23:59:59`];
}

interface CalendarTabProps {
  timezone: string;
  /** Day to open on — set when the dashboard's board was tapped. */
  initialDay?: string | null;
}

function CalendarTab({ timezone, initialDay }: CalendarTabProps) {
  const todayKey = useMemo(() => dayKey(new Date().toISOString(), timezone), [timezone]);

  // The selected day is the one source of truth: the board shows its month,
  // the week view its week, and the panel below its appointments.
  const [selected, setSelected] = useState<string>(initialDay ?? todayKey);
  const [calView, setCalView] = useState<'board' | 'week'>('board');
  const [monthData, setMonthData] = useState<{
    key: string;
    events: EventSummary[];
    holidays: Holiday[];
  } | null>(null);
  const [reminders, setReminders] = useState<AgendaItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, EventDetail>>({});
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editingEvent, setEditingEvent] = useState<{ id: string; detail: EventDetail } | null>(null);

  const monthKey = selected.slice(0, 7);

  const loadMonth = () => {
    const [from, to] = monthRange(monthKey);
    return api
      .events(from, to)
      .then((r) => setMonthData({ key: monthKey, events: r.items, holidays: r.holidays }))
      .catch((e: Error) => setError(e.message));
  };

  // Bills, documents, medicine and the rest have a due date but no Event row,
  // so they still come from the reminder queue — every kind except EVENT,
  // which the board already shows on its real day.
  const loadReminders = () =>
    api
      .agenda()
      .then((r) => setReminders(r.items.filter((i) => i.kind !== 'EVENT')))
      .catch((e: Error) => setError(e.message));

  const reload = () => Promise.all([loadMonth(), loadReminders()]);

  useEffect(() => {
    loadMonth();
  }, [monthKey]);
  useEffect(() => {
    loadReminders();
  }, []);

  if (error) return <p className="error">{error}</p>;

  const current = monthData?.key === monthKey ? monthData : null;
  const holidays = current?.holidays ?? [];

  const changeMonth = (delta: number) => {
    const [y, m] = monthKey.split('-').map(Number) as [number, number];
    const next = new Date(y, m - 1 + delta, 1);
    const nextKey = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    setSelected(todayKey.startsWith(nextKey) ? todayKey : `${nextKey}-01`);
    setExpandedKey(null);
  };

  const dayEvents = (current?.events ?? []).filter((e) => dayKey(e.startAt, timezone) === selected);
  const dayReminders = reminders
    .filter((r) => dayKey(r.dueAt, timezone) === selected)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const holidayName = holidays.find((h) => h.date === selected)?.name;

  const toggleEvent = async (ev: EventSummary, rowKey: string) => {
    if (expandedKey === rowKey) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(rowKey);
    if (!details[ev.id]) {
      try {
        const detail = await api.event(ev.id);
        setDetails((prev) => ({ ...prev, [ev.id]: detail }));
      } catch (err) {
        setDetailError((err as Error).message);
      }
    }
  };

  const forget = (id: string) =>
    setDetails((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const total = dayEvents.length + dayReminders.length;

  return (
    <div>
      <div className="cal-view-toggle">
        <button className={calView === 'board' ? 'active' : ''} onClick={() => setCalView('board')}>
          บอร์ดเดือน
        </button>
        <button className={calView === 'week' ? 'active' : ''} onClick={() => setCalView('week')}>
          สัปดาห์
        </button>
      </div>

      {calView === 'board' ? (
        <CalendarBoard
          monthKey={monthKey}
          todayKey={todayKey}
          selected={selected}
          events={current?.events ?? null}
          holidays={holidays}
          timezone={timezone}
          onSelect={(key) => {
            setSelected(key);
            setExpandedKey(null);
          }}
          onMonth={changeMonth}
        />
      ) : (
        <WeekView timezone={timezone} selected={selected} todayKey={todayKey} onSelectDay={setSelected} />
      )}

      <div className="cal-detail">
        <div className="cal-detail-heading">
          {selected === todayKey ? 'วันนี้' : thaiShortDayMonth(selected)}
          {total > 0 && ` (${total})`}
          {holidayName && <span className="cal-detail-holiday"> · {holidayName}</span>}
        </div>

        {showAddEvent ? (
          <AddEventForm
            selectedDay={selected}
            timezone={timezone}
            onCancel={() => setShowAddEvent(false)}
            onAdded={async () => {
              setShowAddEvent(false);
              await reload();
            }}
          />
        ) : editingEvent ? (
          <AddEventForm
            selectedDay={selected}
            timezone={timezone}
            editing={editingEvent}
            onCancel={() => setEditingEvent(null)}
            onAdded={async () => {
              // The detail cache holds the pre-edit copy, so drop it.
              forget(editingEvent.id);
              setEditingEvent(null);
              setExpandedKey(null);
              await reload();
            }}
          />
        ) : (
          <button type="button" className="form-toggle cal-add-toggle" onClick={() => setShowAddEvent(true)}>
            ＋ เพิ่มนัดหมาย
          </button>
        )}

        {total === 0 ? (
          <p className="empty">ไม่มีนัดวันนี้ครับ</p>
        ) : (
          <ul className="list">
            {dayEvents.map((ev) => {
              const rowKey = `${ev.id}|${ev.startAt}`;
              const isExpanded = expandedKey === rowKey;
              const detail = details[ev.id];
              return (
                <li key={rowKey} className="agenda-item-wrap">
                  <div className="agenda-item agenda-item-clickable" onClick={() => toggleEvent(ev, rowKey)}>
                    <span className="event-swatch" style={{ background: eventCategoryColor(ev.category) }} />
                    <div className="agenda-text">
                      <div>
                        {ev.title}
                        {ev.repeats && <span className="muted"> 🔁</span>}
                      </div>
                      <div className="muted">
                        {ev.allDay ? 'ทั้งวัน' : thaiTimeOnly(ev.startAt)}
                        {ev.location ? ` · ${ev.location}` : ''}
                      </div>
                    </div>
                    <span className="agenda-chevron">{isExpanded ? '▾' : '▸'}</span>
                  </div>

                  {isExpanded && (
                    <div className="agenda-detail">
                      {detailError ? (
                        <p className="error">{detailError}</p>
                      ) : !detail ? (
                        <p className="loading">กำลังโหลด...</p>
                      ) : (
                        <>
                          <EventDetailRows detail={detail} />
                          {detail.rrule && (
                            <div className="muted">แก้ไขหรือลบจะมีผลกับทุกครั้งที่นัดนี้เกิดซ้ำ</div>
                          )}
                          <RowActions
                            onEdit={() => {
                              setEditingEvent({ id: ev.id, detail });
                              setShowAddEvent(false);
                            }}
                            onDelete={async () => {
                              await api.deleteEvent(ev.id);
                              forget(ev.id);
                              setExpandedKey(null);
                              await reload();
                            }}
                          />
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}

            {dayReminders.map((item) => (
              <li key={item.id} className="agenda-item">
                <span className="badge">{kindLabel(item.kind)}</span>
                <div className="agenda-text">
                  <div>{item.text}</div>
                  <div className="muted">เตือน {thaiTimeOnly(item.dueAt)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface WeekViewProps {
  timezone: string;
  /** "YYYY-MM-DD" of the day currently selected — determines which week shows. */
  selected: string;
  todayKey: string;
  onSelectDay: (key: string) => void;
}

/** Google Calendar-style week timeline: real appointments positioned and
 * sized by their actual start/end time, not by reminder fire time (a
 * reminder's dueAt is offset before the event — see reminders/generate.ts —
 * so this reads Event rows directly via GET /events instead of /agenda). */
function WeekView({ timezone, selected, todayKey, onSelectDay }: WeekViewProps) {
  const weekStartKey = useMemo(() => weekStartKeyOf(selected), [selected]);
  const weekDays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const key = addDaysToKey(weekStartKey, i);
        const day = Number(key.split('-')[2]);
        return { key, day };
      }),
    [weekStartKey],
  );
  const weekEndKey = weekDays[6]!.key;

  const [events, setEvents] = useState<EventSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<EventSummary | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = () =>
    api
      .events(`${weekStartKey}T00:00:00`, `${weekEndKey}T23:59:59`)
      .then((r) => setEvents(r.items))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    setSelectedEvent(null);
    setDetail(null);
    setEditing(false);
    load();
  }, [weekStartKey, weekEndKey]);

  const byDay = useMemo(() => {
    const map = new Map<string, EventSummary[]>();
    for (const ev of events ?? []) {
      const key = dayKey(ev.startAt, timezone);
      const bucket = map.get(key);
      if (bucket) bucket.push(ev);
      else map.set(key, [ev]);
    }
    return map;
  }, [events, timezone]);

  const selectEvent = async (ev: EventSummary) => {
    if (selectedEvent?.id === ev.id) {
      setSelectedEvent(null);
      setDetail(null);
      return;
    }
    setSelectedEvent(ev);
    setDetail(null);
    try {
      setDetail(await api.event(ev.id));
    } catch (err) {
      setDetailError((err as Error).message);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div>
      <div className="cal-header">
        <button
          className="cal-nav"
          onClick={() => onSelectDay(addDaysToKey(selected, -7))}
          aria-label="สัปดาห์ก่อนหน้า"
        >
          ‹
        </button>
        <div className="cal-title">
          {thaiShortDayMonth(weekStartKey)} – {thaiShortDayMonth(weekEndKey)}
        </div>
        <button
          className="cal-nav"
          onClick={() => onSelectDay(addDaysToKey(selected, 7))}
          aria-label="สัปดาห์ถัดไป"
        >
          ›
        </button>
      </div>

      {!events ? (
        <p className="loading">กำลังโหลด...</p>
      ) : (
        <div className="week-scroll">
          <div className="week-grid">
            <div className="week-gutter">
              <div className="week-gutter-spacer" />
              {WEEK_HOURS.map((h) => (
                <div
                  key={h}
                  className="week-hour-label"
                  style={{ top: (h - WEEK_DAY_START_HOUR) * WEEK_HOUR_PX }}
                >
                  {h}:00
                </div>
              ))}
            </div>

            {weekDays.map((d, i) => {
              const dayEvents = byDay.get(d.key) ?? [];
              const allDayEvents = dayEvents.filter((e) => e.allDay);
              const timedEvents = dayEvents.filter((e) => !e.allDay);
              const isToday = d.key === todayKey;
              const isSelected = d.key === selected;

              return (
                <div key={d.key} className="week-day">
                  <button
                    type="button"
                    className={[
                      'week-day-header',
                      isToday ? 'week-day-header-today' : '',
                      isSelected ? 'week-day-header-selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => onSelectDay(d.key)}
                  >
                    <span className="week-day-weekday">{WEEKDAY_LABELS[i]}</span>
                    <span className="week-day-num">{d.day}</span>
                  </button>

                  {allDayEvents.length > 0 && (
                    <div className="week-allday">
                      {allDayEvents.map((ev) => (
                        <button
                          type="button"
                          key={ev.id}
                          className="week-allday-chip"
                          style={{ background: eventCategoryColor(ev.category) }}
                          onClick={() => selectEvent(ev)}
                        >
                          {ev.title}
                        </button>
                      ))}
                    </div>
                  )}

                  <div
                    className="week-timeline"
                    style={{ height: (WEEK_DAY_END_HOUR - WEEK_DAY_START_HOUR) * WEEK_HOUR_PX }}
                  >
                    {WEEK_HOURS.map((h) => (
                      <div
                        key={h}
                        className="week-hour-line"
                        style={{ top: (h - WEEK_DAY_START_HOUR) * WEEK_HOUR_PX }}
                      />
                    ))}
                    {timedEvents.map((ev) => {
                      const startMin = Math.min(
                        Math.max(minutesOfDay(ev.startAt, timezone), WEEK_DAY_START_HOUR * 60),
                        WEEK_DAY_END_HOUR * 60,
                      );
                      const rawEndMin = ev.endAt
                        ? minutesOfDay(ev.endAt, timezone)
                        : startMin + 60;
                      const endMin = Math.min(
                        Math.max(rawEndMin, startMin + 30),
                        WEEK_DAY_END_HOUR * 60,
                      );
                      const top = ((startMin - WEEK_DAY_START_HOUR * 60) / 60) * WEEK_HOUR_PX;
                      const height = Math.max(((endMin - startMin) / 60) * WEEK_HOUR_PX, 22);

                      return (
                        <button
                          key={ev.id}
                          type="button"
                          className={`week-event${selectedEvent?.id === ev.id ? ' week-event-selected' : ''}`}
                          style={{ top, height, background: eventCategoryColor(ev.category) }}
                          onClick={() => selectEvent(ev)}
                        >
                          <span className="week-event-title">{ev.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selectedEvent && (
        <div className="agenda-detail week-detail">
          <div className="dash-section-heading">{selectedEvent.title}</div>
          {detailError ? (
            <p className="error">{detailError}</p>
          ) : !detail ? (
            <p className="loading">กำลังโหลด...</p>
          ) : (
            <>
              <EventDetailRows detail={detail} />
              {editing ? (
                <AddEventForm
                  selectedDay={dayKey(detail.startAt, timezone)}
                  timezone={timezone}
                  editing={{ id: detail.id, detail }}
                  onCancel={() => setEditing(false)}
                  onAdded={async () => {
                    setEditing(false);
                    setSelectedEvent(null);
                    setDetail(null);
                    await load();
                  }}
                />
              ) : (
                <RowActions
                  onEdit={() => setEditing(true)}
                  onDelete={async () => {
                    await api.deleteEvent(detail.id);
                    setSelectedEvent(null);
                    setDetail(null);
                    await load();
                  }}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface AddEventFormProps {
  /** "YYYY-MM-DD" — the day currently selected in the calendar grid. */
  selectedDay: string;
  onAdded: () => void;
  onCancel: () => void;
  /** Set when correcting an existing appointment rather than adding one. */
  editing?: { id: string; detail: EventDetail };
  timezone: string;
}

function AddEventForm({ selectedDay, onAdded, onCancel, editing, timezone }: AddEventFormProps) {
  const existing = editing?.detail;
  const [title, setTitle] = useState(existing?.title ?? '');
  const [allDay, setAllDay] = useState(existing?.allDay ?? false);
  const [time, setTime] = useState(
    existing && !existing.allDay ? clockHHmm(existing.startAt, timezone) : '09:00',
  );
  const [category, setCategory] = useState<(typeof EVENT_CATEGORIES)[number]>(
    (existing?.category as (typeof EVENT_CATEGORIES)[number]) ?? 'OTHER',
  );
  const [location, setLocation] = useState(existing?.location ?? '');
  const [attendeeName, setAttendeeName] = useState(existing?.attendeeNames[0] ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [rrule, setRrule] = useState(existing?.rrule ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // An edit keeps the appointment on its own day, not on whichever day the
  // grid happens to have selected.
  const day = existing ? dayKey(existing.startAt, timezone) : selectedDay;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSaving(true);
    try {
      if (editing) {
        // null rather than omitted: an emptied field means "clear it".
        await api.updateEvent(editing.id, {
          title: title.trim(),
          startAt: allDay ? day : `${day}T${time}`,
          allDay,
          category,
          location: location.trim() || null,
          attendeeName: attendeeName.trim() || null,
          note: note.trim() || null,
          rrule: rrule || null,
        });
      } else {
        await api.addEvent({
          title: title.trim(),
          startAt: allDay ? day : `${day}T${time}`,
          allDay,
          category,
          ...(location.trim() ? { location: location.trim() } : {}),
          ...(attendeeName.trim() ? { attendeeName: attendeeName.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(rrule ? { rrule } : {}),
        });
      }
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="entry-form" onSubmit={submit}>
      {error && <p className="error">{error}</p>}
      <div className="field">
        <label htmlFor="event-title">เรื่อง</label>
        <input
          id="event-title"
          type="text"
          placeholder="เช่น พาแม่ไปหาหมอ"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoFocus
        />
      </div>

      <label className="checkbox-field">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        ทั้งวัน ไม่ระบุเวลา
      </label>

      <div className="field-row">
        {!allDay && (
          <div className="field">
            <label htmlFor="event-time">เวลา</label>
            <input id="event-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        )}
        <div className="field">
          <label htmlFor="event-category">ประเภท</label>
          <select
            id="event-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as typeof category)}
          >
            {EVENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {eventCategoryLabel(c)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="event-repeat">ทำซ้ำ</label>
        <select id="event-repeat" value={rrule} onChange={(e) => setRrule(e.target.value)}>
          {REPEAT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {/* A rule typed in chat ("ทุกวันจันทร์") has no entry above — keep it
              selectable so editing does not silently drop it. */}
          {rrule && !REPEAT_OPTIONS.some((o) => o.value === rrule) && (
            <option value={rrule}>{repeatLabel(rrule)}</option>
          )}
        </select>
      </div>

      <div className="field">
        <label htmlFor="event-location">
          สถานที่ <span className="optional">(ไม่บังคับ)</span>
        </label>
        <input
          id="event-location"
          type="text"
          placeholder="เช่น ศิริราช"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="event-attendee">
          สำหรับใคร <span className="optional">(ไม่บังคับ)</span>
        </label>
        <input
          id="event-attendee"
          type="text"
          placeholder="เช่น น้องพร"
          value={attendeeName}
          onChange={(e) => setAttendeeName(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="event-note">
          หมายเหตุ <span className="optional">(ไม่บังคับ)</span>
        </label>
        <input id="event-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div className="field-row">
        <button type="button" className="form-toggle" onClick={onCancel}>
          ยกเลิก
        </button>
        <button type="submit" className="form-submit" disabled={saving}>
          {saving ? 'กำลังบันทึก...' : editing ? 'บันทึกการแก้ไข' : 'บันทึกนัดหมาย'}
        </button>
      </div>
    </form>
  );
}

function ExpensesTab() {
  const [summary, setSummary] = useState<ExpenseSummary | null>(null);
  const [transactions, setTransactions] = useState<TransactionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    Promise.all([api.expenseSummary(), api.transactions()])
      .then(([s, t]) => {
        setSummary(s);
        setTransactions(t.items);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setAmount('');
    setCategory('');
    setNote('');
  };

  const startEdit = (tx: TransactionItem) => {
    setEditingId(tx.id);
    setAmount(String(tx.amountSatang / 100));
    setCategory(tx.categoryName ?? '');
    setNote(tx.note ?? '');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountBaht = Number(amount);
    if (!Number.isFinite(amountBaht) || amountBaht <= 0) return;

    setSaving(true);
    try {
      if (editingId) {
        // null rather than omitted: an emptied field means "clear it".
        await api.updateTransaction(editingId, {
          amountBaht,
          categoryName: category.trim() || null,
          note: note.trim() || null,
        });
      } else {
        await api.addExpense({
          amountBaht,
          ...(category.trim() ? { categoryName: category.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }
      resetForm();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;

  const max = summary?.byCategory[0]?.amountSatang ?? 1;

  return (
    <div>
      <div className="dash-section">
        <div className="dash-section-heading">
          {editingId ? '✏️ แก้ไขรายการ' : '💰 บันทึกรายจ่าย'}
        </div>
        <form className="entry-form" onSubmit={submit} style={{ borderTop: 'none', paddingTop: 0 }}>
          <div className="field-row">
            <div className="field">
              <label htmlFor="exp-amount">จำนวนเงิน (บาท)</label>
              <input
                id="exp-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="เช่น 250"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="exp-category">
                หมวดหมู่ <span className="optional">(ไม่บังคับ)</span>
              </label>
              <input
                id="exp-category"
                type="text"
                list="exp-category-options"
                placeholder="เช่น ข้าว"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
              <datalist id="exp-category-options">
                {(summary?.byCategory ?? []).map((c) => (
                  <option key={c.name} value={c.name} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="field">
            <label htmlFor="exp-note">
              บันทึกเพิ่มเติม <span className="optional">(ไม่บังคับ)</span>
            </label>
            <input
              id="exp-note"
              type="text"
              placeholder="เช่น ซื้อของเข้าบ้าน"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {editingId ? (
            <div className="field-row">
              <button type="button" className="form-toggle" onClick={resetForm}>
                ยกเลิก
              </button>
              <button type="submit" className="form-submit" disabled={saving}>
                {saving ? 'กำลังบันทึก...' : 'บันทึกการแก้ไข'}
              </button>
            </div>
          ) : (
            <button type="submit" className="form-submit" disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'บันทึกรายจ่าย'}
            </button>
          )}
        </form>
      </div>

      {!summary ? (
        <p className="loading">กำลังโหลด...</p>
      ) : (
        <div className="dash-section">
          <div className="dash-section-heading">📅 สรุปรายจ่ายเดือนนี้</div>
          <div className="total">
            เดือนนี้ใช้ไป <strong>{baht(summary.totalSatang)}</strong> บาท
          </div>
          <ul className="list">
            {summary.byCategory.map((c) => (
              <li key={c.name} className="category-row">
                <div className="category-name">{c.name}</div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(c.amountSatang / max) * 100}%` }} />
                </div>
                <div className="category-amount">{baht(c.amountSatang)}</div>
              </li>
            ))}
            {summary.byCategory.length === 0 && <p className="empty">ยังไม่มีรายจ่ายเดือนนี้ครับ</p>}
          </ul>
        </div>
      )}

      <div className="dash-section">
        <div className="dash-section-heading">🧾 รายการเดือนนี้</div>
        {!transactions ? (
          <p className="loading">กำลังโหลด...</p>
        ) : transactions.length === 0 ? (
          <p className="empty">ยังไม่มีรายการเดือนนี้ครับ</p>
        ) : (
          <ul className="list">
            {transactions.map((tx) => (
              <li key={tx.id} className="finance-item finance-item-stacked">
                <div className="finance-item-main">
                  <span className="finance-icon">{tx.direction === 'IN' ? '📥' : '📤'}</span>
                  <div>
                    <div>
                      {tx.categoryName ?? 'ไม่มีหมวด'}
                      <span className={tx.direction === 'IN' ? 'amount-in' : 'amount-out'}>
                        {' '}
                        {tx.direction === 'IN' ? '+' : '−'}
                        {baht(tx.amountSatang)}
                      </span>
                    </div>
                    <div className="muted">
                      {thaiDate(tx.occurredAt)}
                      {tx.note ? ` · ${tx.note}` : ''}
                      {tx.paidBy ? ` · ${tx.paidBy}` : ''}
                    </div>
                  </div>
                </div>
                <RowActions
                  onEdit={() => startEdit(tx)}
                  onDelete={async () => {
                    await api.deleteTransaction(tx.id);
                    if (editingId === tx.id) resetForm();
                    await load();
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function LoansSection() {
  const [loans, setLoans] = useState<Loan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [borrowerName, setBorrowerName] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.loans().then((r) => setLoans(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setBorrowerName('');
    setAmount('');
    setDueDate('');
    setNote('');
  };

  const startEdit = (loan: Loan) => {
    setEditingId(loan.id);
    setBorrowerName(loan.borrowerName);
    setAmount(String(loan.principalSatang / 100));
    setDueDate(loan.dueAt ? loan.dueAt.slice(0, 10) : '');
    setNote(loan.note ?? '');
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const principalAmountBaht = Number(amount);
    if (!borrowerName.trim() || !Number.isFinite(principalAmountBaht) || principalAmountBaht <= 0) return;

    setSaving(true);
    try {
      if (editingId) {
        await api.updateLoan(editingId, {
          borrowerName: borrowerName.trim(),
          principalAmountBaht,
          dueAt: dueDate || null,
          note: note.trim() || null,
        });
      } else {
        await api.addLoan({
          borrowerName: borrowerName.trim(),
          principalAmountBaht,
          ...(dueDate ? { dueAt: dueDate } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }
      resetForm();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const repayFull = async (loan: Loan) => {
    const outstandingBaht = (loan.principalSatang - loan.repaidSatang) / 100;
    if (outstandingBaht <= 0) return;
    await api.repayLoan(loan.id, outstandingBaht).catch(() => undefined);
    await load();
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dash-section">
      <div className="dash-section-heading">🤝 เงินให้ยืม</div>
      {!loans ? (
        <p className="loading">กำลังโหลด...</p>
      ) : loans.length === 0 ? (
        <p className="empty">ยังไม่มีเงินให้ใครยืมครับ</p>
      ) : (
        <ul className="list">
          {loans.map((loan) => {
            const outstanding = loan.principalSatang - loan.repaidSatang;
            return (
              <li key={loan.id} className="finance-item finance-item-stacked">
                <div className="finance-item-row">
                  <div className="finance-item-main">
                    <span className="finance-icon">🤝</span>
                    <div>
                      <div>{loan.borrowerName}</div>
                      {loan.dueAt && <div className="muted">ครบกำหนด {thaiDate(loan.dueAt)}</div>}
                      {loan.note && <div className="muted">{loan.note}</div>}
                    </div>
                  </div>
                  <div className={`pill ${outstanding <= 0 ? 'pill-muted' : 'pill-warn'}`}>
                    {outstanding <= 0 ? '✓ คืนครบแล้ว' : `ค้าง ${baht(outstanding)}`}
                  </div>
                </div>
                <RowActions
                  {...(outstanding > 0
                    ? { extra: { label: 'คืนครบแล้ว', onClick: () => repayFull(loan) } }
                    : {})}
                  onEdit={() => startEdit(loan)}
                  onDelete={async () => {
                    await api.deleteLoan(loan.id);
                    if (editingId === loan.id) resetForm();
                    await load();
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
      <form className="entry-form" onSubmit={add}>
        <div className="field">
          <label htmlFor="loan-borrower">ให้ใครยืม</label>
          <input
            id="loan-borrower"
            type="text"
            placeholder="เช่น พี่เอ"
            value={borrowerName}
            onChange={(e) => setBorrowerName(e.target.value)}
            required
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="loan-amount">จำนวนเงิน (บาท)</label>
            <input
              id="loan-amount"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="เช่น 5000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="loan-due">
              ครบกำหนดคืน <span className="optional">(ไม่บังคับ)</span>
            </label>
            <input id="loan-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="loan-note">
            หมายเหตุ <span className="optional">(ไม่บังคับ)</span>
          </label>
          <input
            id="loan-note"
            type="text"
            placeholder="เช่น ยืมไปซ่อมรถ"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {editingId ? (
          <div className="field-row">
            <button type="button" className="form-toggle" onClick={resetForm}>
              ยกเลิก
            </button>
            <button type="submit" className="form-submit" disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'บันทึกการแก้ไข'}
            </button>
          </div>
        ) : (
          <button type="submit" className="form-submit" disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกเงินให้ยืม'}
          </button>
        )}
      </form>
    </div>
  );
}

function AssetsSection() {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<(typeof ASSET_CATEGORIES)[number]>('OTHER');
  const [value, setValue] = useState('');
  const [acquiredAt, setAcquiredAt] = useState('');
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.assets().then((r) => setAssets(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setValue('');
    setAcquiredAt('');
    setNote('');
  };

  const startEdit = (asset: Asset) => {
    setEditingId(asset.id);
    setName(asset.name);
    setCategory(asset.category as (typeof ASSET_CATEGORIES)[number]);
    setValue(String(asset.valueSatang / 100));
    setNote(asset.note ?? '');
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const valueBaht = Number(value);
    if (!name.trim() || !Number.isFinite(valueBaht) || valueBaht <= 0) return;

    setSaving(true);
    try {
      if (editingId) {
        await api.updateAsset(editingId, {
          name: name.trim(),
          category,
          valueBaht,
          ...(acquiredAt ? { acquiredAt } : {}),
          note: note.trim() || null,
        });
      } else {
        await api.addAsset({
          name: name.trim(),
          category,
          valueBaht,
          ...(acquiredAt ? { acquiredAt } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }
      resetForm();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dash-section">
      <div className="dash-section-heading">🏠 ทรัพย์สิน</div>
      {!assets ? (
        <p className="loading">กำลังโหลด...</p>
      ) : assets.length === 0 ? (
        <p className="empty">ยังไม่มีทรัพย์สินบันทึกไว้ครับ</p>
      ) : (
        <ul className="list">
          {assets.map((asset) => (
            <li key={asset.id} className="finance-item finance-item-stacked">
              <div className="finance-item-row">
                <div className="finance-item-main">
                  <span className="finance-icon">{assetCategoryIcon(asset.category)}</span>
                  <div>
                    <div>{asset.name}</div>
                    <div className="muted">
                      {assetCategoryLabel(asset.category)}
                      {asset.note ? ` · ${asset.note}` : ''}
                    </div>
                  </div>
                </div>
                <div>{baht(asset.valueSatang)}</div>
              </div>
              <RowActions
                onEdit={() => startEdit(asset)}
                onDelete={async () => {
                  await api.deleteAsset(asset.id);
                  if (editingId === asset.id) resetForm();
                  await load();
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <form className="entry-form" onSubmit={add}>
        <div className="field">
          <label htmlFor="asset-name">ชื่อทรัพย์สิน</label>
          <input
            id="asset-name"
            type="text"
            placeholder="เช่น บ้านสวน"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="asset-category">ประเภท</label>
            <select
              id="asset-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as typeof category)}
            >
              {ASSET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {assetCategoryLabel(c)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="asset-value">มูลค่า (บาท)</label>
            <input
              id="asset-value"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="เช่น 3000000"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="asset-acquired">
            วันที่ได้มา <span className="optional">(ไม่บังคับ)</span>
          </label>
          <input
            id="asset-acquired"
            type="date"
            value={acquiredAt}
            onChange={(e) => setAcquiredAt(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="asset-note">
            หมายเหตุ <span className="optional">(ไม่บังคับ)</span>
          </label>
          <input
            id="asset-note"
            type="text"
            placeholder="เช่น ผ่อนหมดแล้ว"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {editingId ? (
          <div className="field-row">
            <button type="button" className="form-toggle" onClick={resetForm}>
              ยกเลิก
            </button>
            <button type="submit" className="form-submit" disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'บันทึกการแก้ไข'}
            </button>
          </div>
        ) : (
          <button type="submit" className="form-submit" disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกทรัพย์สิน'}
          </button>
        )}
      </form>
    </div>
  );
}

function DepositsSection() {
  const [deposits, setDeposits] = useState<Deposit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('');
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    api.deposits().then((r) => setDeposits(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setBalance('');
    setNote('');
  };

  const startEdit = (deposit: Deposit) => {
    setEditingId(deposit.id);
    setName(deposit.name);
    setBalance(String(deposit.balanceSatang / 100));
    setNote(deposit.note ?? '');
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const balanceBaht = Number(balance);
    if (!name.trim() || !Number.isFinite(balanceBaht) || balanceBaht < 0) return;

    setSaving(true);
    try {
      if (editingId) {
        await api.updateDeposit(editingId, {
          name: name.trim(),
          balanceBaht,
          note: note.trim() || null,
        });
      } else {
        await api.addDeposit({
          name: name.trim(),
          balanceBaht,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
      }
      resetForm();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dash-section">
      <div className="dash-section-heading">🏦 เงินฝาก</div>
      {!deposits ? (
        <p className="loading">กำลังโหลด...</p>
      ) : deposits.length === 0 ? (
        <p className="empty">ยังไม่มีบัญชีเงินฝากบันทึกไว้ครับ</p>
      ) : (
        <ul className="list">
          {deposits.map((deposit) => (
            <li key={deposit.id} className="finance-item finance-item-stacked">
              <div className="finance-item-row">
                <div className="finance-item-main">
                  <span className="finance-icon">🏦</span>
                  <div>
                    <div>{deposit.name}</div>
                    {deposit.note && <div className="muted">{deposit.note}</div>}
                  </div>
                </div>
                <div>{baht(deposit.balanceSatang)}</div>
              </div>
              <RowActions
                onEdit={() => startEdit(deposit)}
                onDelete={async () => {
                  await api.deleteDeposit(deposit.id);
                  if (editingId === deposit.id) resetForm();
                  await load();
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <form className="entry-form" onSubmit={add}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="deposit-name">ชื่อบัญชี</label>
            <input
              id="deposit-name"
              type="text"
              placeholder="เช่น ออมทรัพย์ SCB"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="deposit-balance">ยอดคงเหลือ (บาท)</label>
            <input
              id="deposit-balance"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="เช่น 50000"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              required
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="deposit-note">
            หมายเหตุ <span className="optional">(ไม่บังคับ)</span>
          </label>
          <input
            id="deposit-note"
            type="text"
            placeholder="เช่น บัญชีสำหรับค่าเทอมลูก"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {editingId ? (
          <div className="field-row">
            <button type="button" className="form-toggle" onClick={resetForm}>
              ยกเลิก
            </button>
            <button type="submit" className="form-submit" disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'บันทึกการแก้ไข'}
            </button>
          </div>
        ) : (
          <button type="submit" className="form-submit" disabled={saving}>
            {saving ? 'กำลังบันทึก...' : 'บันทึกบัญชีเงินฝาก'}
          </button>
        )}
      </form>
    </div>
  );
}

function FinanceTab() {
  return (
    <div>
      <LoansSection />
      <AssetsSection />
      <DepositsSection />
    </div>
  );
}

/** Expenses and net worth are both "เงิน" — one tab, two views. */
function MoneyTab() {
  const [view, setView] = useState<'flow' | 'worth'>('flow');

  return (
    <div>
      <div className="segmented">
        <button className={view === 'flow' ? 'active' : ''} onClick={() => setView('flow')}>
          รายรับ-รายจ่าย
        </button>
        <button className={view === 'worth' ? 'active' : ''} onClick={() => setView('worth')}>
          ทรัพย์สิน/หนี้สิน
        </button>
      </div>
      {view === 'flow' ? <ExpensesTab /> : <FinanceTab />}
    </div>
  );
}

const TASK_COLUMNS = [
  { status: 'TODO', label: 'ต้องทำ', className: 'board-column-todo', note: 'note-todo' },
  { status: 'DOING', label: 'กำลังทำ', className: 'board-column-doing', note: 'note-doing' },
  { status: 'DONE', label: 'เสร็จแล้ว', className: 'board-column-done', note: 'note-done' },
] as const;

/**
 * The family board. Cards move by tapping a button rather than by dragging:
 * drag-and-drop inside a LINE webview fights the page's own scrolling, and a
 * card that will not drop where you meant is worse than one extra tap.
 */
function TasksTab({ timezone }: { timezone: string }) {
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assignee, setAssignee] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => api.tasks().then((r) => setTasks(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSaving(true);
    try {
      await api.addTask({
        title: title.trim(),
        ...(dueDate ? { dueAt: dueDate } : {}),
        ...(assignee.trim() ? { assigneeName: assignee.trim() } : {}),
      });
      setTitle('');
      setDueDate('');
      setAssignee('');
      setShowAdd(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const move = async (task: TaskItem, status: TaskItem['status']) => {
    // Optimistic: the card jumps columns on tap, which is the whole point.
    setTasks((prev) => prev?.map((t) => (t.id === task.id ? { ...t, status } : t)) ?? null);
    await api.updateTask(task.id, { status }).catch(() => undefined);
    await load();
  };

  const remove = async (task: TaskItem) => {
    setTasks((prev) => prev?.filter((t) => t.id !== task.id) ?? null);
    await api.deleteTask(task.id).catch(() => undefined);
    await load();
  };

  if (error) return <p className="error">{error}</p>;
  if (!tasks) return <p className="loading">กำลังโหลด...</p>;

  const todayKey = dayKey(new Date().toISOString(), timezone);
  const open = tasks.filter((t) => t.status !== 'DONE').length;
  const doneToday = tasks.filter(
    (t) => t.status === 'DONE' && t.doneAt && dayKey(t.doneAt, timezone) === todayKey,
  ).length;

  return (
    <div>
      <div className="dash-section" style={{ textAlign: 'center' }}>
        <div className="dash-section-heading">📋 บอร์ดงานของบ้าน</div>
        <div className="muted">
          {open === 0 ? 'ไม่มีงานค้างแล้ว เยี่ยมมากครับ' : `ค้างอยู่ ${open} งาน`}
          {doneToday > 0 ? ` · วันนี้เสร็จไป ${doneToday}` : ''}
        </div>
      </div>

      <div className="corkboard">
        <div className="board-columns">
          {TASK_COLUMNS.map((col) => {
            const cards = tasks.filter((t) => t.status === col.status);
            return (
              <div key={col.status} className={`board-column ${col.className}`}>
                <div className="board-column-head">
                  {col.label}
                  <span className="board-count">{cards.length}</span>
                </div>

                {cards.length === 0 && <div className="board-empty">ว่าง</div>}

                {cards.map((task) => {
                  const overdue =
                    task.status !== 'DONE' && task.dueAt !== null && new Date(task.dueAt) < new Date();
                  return (
                    <div
                      key={task.id}
                      className={`note ${col.note}${overdue ? ' note-overdue' : ''}`}
                    >
                      <div className="note-title">{task.title}</div>
                      {(task.assignee || task.dueAt) && (
                        <div className="note-meta">
                          {task.assignee ?? ''}
                          {task.assignee && task.dueAt ? ' · ' : ''}
                          {task.dueAt ? thaiDate(task.dueAt) : ''}
                        </div>
                      )}

                      <div className="note-actions">
                        {task.status === 'TODO' && (
                          <button className="note-btn" onClick={() => move(task, 'DOING')}>
                            เริ่ม
                          </button>
                        )}
                        {task.status !== 'DONE' ? (
                          <button className="note-btn" onClick={() => move(task, 'DONE')}>
                            ✓
                          </button>
                        ) : (
                          <button className="note-btn" onClick={() => move(task, 'TODO')}>
                            ↩
                          </button>
                        )}
                        <button className="note-btn" onClick={() => remove(task)}>
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="board-footnote">งานเลยกำหนด = หมุดแดง</div>
      </div>

      <div className="dash-section" style={{ marginTop: 12 }}>
        {showAdd ? (
          <form className="entry-form" onSubmit={add} style={{ borderTop: 'none', paddingTop: 0 }}>
            <div className="field">
              <label htmlFor="task-title">งานอะไร</label>
              <input
                id="task-title"
                type="text"
                placeholder="เช่น โทรหาช่างแอร์"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="task-due">
                  ครบกำหนด <span className="optional">(ไม่บังคับ)</span>
                </label>
                <input
                  id="task-due"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="task-assignee">
                  ให้ใครทำ <span className="optional">(ไม่บังคับ)</span>
                </label>
                <input
                  id="task-assignee"
                  type="text"
                  placeholder="เช่น พ่อ"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                />
              </div>
            </div>
            <div className="field-row">
              <button type="button" className="form-toggle" onClick={() => setShowAdd(false)}>
                ยกเลิก
              </button>
              <button type="submit" className="form-submit" disabled={saving}>
                {saving ? 'กำลังบันทึก...' : 'ปักงานลงบอร์ด'}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="form-toggle" onClick={() => setShowAdd(true)}>
            ＋ เพิ่มงาน
          </button>
        )}
      </div>

      <div className="dash-section" style={{ textAlign: 'center' }}>
        <Mascot who="girl" mood={open === 0 ? 'cheer' : 'happy'} size={110} />
        <div className="muted">
          {open === 0 ? 'บอร์ดโล่งแล้ว! 🎉' : 'พิมพ์ในแชทก็ได้นะ — "เพิ่มงาน ..."'}
        </div>
      </div>
    </div>
  );
}

/**
 * Standing items — bills, documents, medication, chores. These are all set up
 * from chat, and until now the app had no way to see (let alone stop) one that
 * was entered wrong, which is the whole reason this tab exists. Each empty
 * state doubles as a reminder of the phrase that creates one.
 */
function ManageTab() {
  return (
    <div>
      <BillsSection />
      <DocumentsSection />
      <MedicationsSection />
      <ChoresSection />
    </div>
  );
}

function BillsSection() {
  const [bills, setBills] = useState<BillItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.bills().then((r) => setBills(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const startEdit = (bill: BillItem) => {
    setEditingId(bill.id);
    setName(bill.name);
    setAmount(bill.amountSatang === null ? '' : String(bill.amountSatang / 100));
    setDueDay(String(bill.dueDay));
    setShowAdd(true);
  };

  const closeForm = () => {
    setShowAdd(false);
    setEditingId(null);
    setName('');
    setAmount('');
    setDueDay('');
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const day = Number(dueDay);
    if (!name.trim() || !Number.isInteger(day) || day < 1 || day > 31) return;
    const amountBaht = Number(amount);
    const hasAmount = Number.isFinite(amountBaht) && amountBaht > 0;

    setSaving(true);
    try {
      if (editingId) {
        // null clears a fixed amount, for a bill that varies month to month.
        await api.updateBill(editingId, {
          name: name.trim(),
          dueDay: day,
          amountBaht: hasAmount ? amountBaht : null,
        });
      } else {
        await api.addBill({
          name: name.trim(),
          dueDay: day,
          ...(hasAmount ? { amountBaht } : {}),
        });
      }
      closeForm();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dash-section">
      <div className="dash-section-heading">🧾 บิลประจำเดือน</div>
      {!bills ? (
        <p className="loading">กำลังโหลด...</p>
      ) : bills.length === 0 ? (
        <p className="empty">ยังไม่มีบิล — พิมพ์ "ตั้งบิล ค่าไฟ 800 ทุกวันที่ 5" ในแชทได้เลย</p>
      ) : (
        <ul className="list">
          {bills.map((bill) => (
            <li key={bill.id} className="finance-item finance-item-stacked">
              <div className="finance-item-row">
                <div className="finance-item-main">
                  <span className="finance-icon">🧾</span>
                  <div>
                    <div>{bill.name}</div>
                    <div className="muted">
                      ทุกวันที่ {bill.dueDay} ·{' '}
                      {bill.amountSatang === null ? 'ยอดตามบิล' : `${baht(bill.amountSatang)} บาท`}
                    </div>
                  </div>
                </div>
                {!bill.active && <span className="pill pill-muted">ปิดอยู่</span>}
              </div>
              <RowActions
                extra={{
                  label: bill.active ? 'ปิดเตือน' : 'เปิดเตือน',
                  onClick: async () => {
                    await api.updateBill(bill.id, { active: !bill.active });
                    await load();
                  },
                }}
                onEdit={() => startEdit(bill)}
                onDelete={async () => {
                  await api.deleteBill(bill.id);
                  await load();
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {showAdd ? (
        <form className="entry-form" onSubmit={add}>
          <div className="field">
            <label htmlFor="bill-name">ชื่อบิล</label>
            <input
              id="bill-name"
              type="text"
              placeholder="เช่น ค่าไฟ"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="bill-amount">
                ยอด (บาท) <span className="optional">(ไม่บังคับ)</span>
              </label>
              <input
                id="bill-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                placeholder="ว่างไว้ถ้ายอดไม่คงที่"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="bill-dueday">ครบกำหนดทุกวันที่</label>
              <input
                id="bill-dueday"
                type="number"
                inputMode="numeric"
                min="1"
                max="31"
                placeholder="1-31"
                value={dueDay}
                onChange={(e) => setDueDay(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="field-row">
            <button type="button" className="form-toggle" onClick={closeForm}>
              ยกเลิก
            </button>
            <button type="submit" className="form-submit" disabled={saving}>
              {saving ? 'กำลังบันทึก...' : editingId ? 'บันทึกการแก้ไข' : 'ตั้งบิล'}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="form-toggle" onClick={() => setShowAdd(true)}>
          ＋ ตั้งบิลใหม่
        </button>
      )}
    </div>
  );
}

function DocumentsSection() {
  const [documents, setDocuments] = useState<DocumentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState('OTHER');
  const [expiresAt, setExpiresAt] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    api.documents().then((r) => setDocuments(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const closeForm = () => {
    setShowAdd(false);
    setEditingId(null);
    setName('');
    setExpiresAt('');
    setType('OTHER');
  };

  const startEdit = (doc: DocumentItem) => {
    setEditingId(doc.id);
    setName(doc.name);
    setType(doc.type);
    // The API hands back a full ISO timestamp; <input type="date"> wants a day.
    setExpiresAt(doc.expiresAt.slice(0, 10));
    setShowAdd(true);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !expiresAt) return;

    setSaving(true);
    try {
      if (editingId) await api.updateDocument(editingId, { name: name.trim(), type, expiresAt });
      else await api.addDocument({ name: name.trim(), type, expiresAt });
      closeForm();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dash-section">
      <div className="dash-section-heading">📄 เอกสารที่ต้องต่ออายุ</div>
      {!documents ? (
        <p className="loading">กำลังโหลด...</p>
      ) : documents.length === 0 ? (
        <p className="empty">ยังไม่มีเอกสาร — พิมพ์ "ใบขับขี่ หมดอายุ 15 มี.ค. 70" ในแชทได้เลย</p>
      ) : (
        <ul className="list">
          {documents.map((doc) => (
            <li key={doc.id} className="finance-item finance-item-stacked">
              <div className="finance-item-row">
                <div className="finance-item-main">
                  <span className="finance-icon">📄</span>
                  <div>
                    <div>{doc.name}</div>
                    <div className="muted">
                      {documentTypeLabel(doc.type)} · หมดอายุ {thaiDate(doc.expiresAt)}
                      {doc.owner ? ` · ${doc.owner}` : ''}
                    </div>
                  </div>
                </div>
              </div>
              <RowActions
                onEdit={() => startEdit(doc)}
                onDelete={async () => {
                  await api.deleteDocument(doc.id);
                  await load();
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {showAdd ? (
        <form className="entry-form" onSubmit={add}>
          <div className="field">
            <label htmlFor="doc-name">ชื่อเอกสาร</label>
            <input
              id="doc-name"
              type="text"
              placeholder="เช่น ใบขับขี่แม่"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="doc-type">ประเภท</label>
              <select id="doc-type" value={type} onChange={(e) => setType(e.target.value)}>
                {DOCUMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {documentTypeLabel(t)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="doc-expires">วันหมดอายุ</label>
              <input
                id="doc-expires"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="field-row">
            <button type="button" className="form-toggle" onClick={closeForm}>
              ยกเลิก
            </button>
            <button type="submit" className="form-submit" disabled={saving}>
              {saving ? 'กำลังบันทึก...' : editingId ? 'บันทึกการแก้ไข' : 'บันทึกเอกสาร'}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="form-toggle" onClick={() => setShowAdd(true)}>
          ＋ เพิ่มเอกสาร
        </button>
      )}
    </div>
  );
}

function MedicationsSection() {
  const [meds, setMeds] = useState<MedicationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [dosage, setDosage] = useState('');
  const [times, setTimes] = useState('08:00, 20:00');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () =>
    api.medications().then((r) => setMeds(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const closeForm = () => {
    setShowAdd(false);
    setEditingId(null);
    setName('');
    setDosage('');
    setTimes('08:00, 20:00');
  };

  const startEdit = (med: MedicationItem) => {
    setEditingId(med.id);
    setName(med.name);
    setDosage(med.dosage ?? '');
    setTimes(med.times.join(', '));
    setShowAdd(true);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsedTimes = times
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => /^\d{1,2}:\d{2}$/.test(t));
    if (!name.trim() || parsedTimes.length === 0) {
      setError('ใส่เวลาแบบ 08:00 อย่างน้อยหนึ่งเวลานะครับ');
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        // null, not omitted: clearing the dosage field has to reach the server
        // as an erasure, otherwise an old dose lingers on the reminder.
        await api.updateMedication(editingId, {
          name: name.trim(),
          times: parsedTimes,
          dosage: dosage.trim() || null,
        });
      } else {
        await api.addMedication({
          name: name.trim(),
          times: parsedTimes,
          ...(dosage.trim() ? { dosage: dosage.trim() } : {}),
        });
      }
      closeForm();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dash-section">
      <div className="dash-section-heading">💊 ยาประจำตัว</div>
      {!meds ? (
        <p className="loading">กำลังโหลด...</p>
      ) : meds.length === 0 ? (
        <p className="empty">ยังไม่มียา — พิมพ์ "ตั้งยา ยาความดัน เวลา 08:00, 20:00" ในแชทได้เลย</p>
      ) : (
        <ul className="list">
          {meds.map((med) => (
            <li key={med.id} className="finance-item finance-item-stacked">
              <div className="finance-item-row">
                <div className="finance-item-main">
                  <span className="finance-icon">💊</span>
                  <div>
                    <div>
                      {med.name} <span className="muted">— {med.owner}</span>
                    </div>
                    <div className="muted">
                      {med.times.join(', ')}
                      {med.dosage ? ` · ${med.dosage}` : ''}
                    </div>
                  </div>
                </div>
                {!med.active && <span className="pill pill-muted">ปิดอยู่</span>}
              </div>
              <RowActions
                extra={{
                  label: med.active ? 'ปิดเตือน' : 'เปิดเตือน',
                  onClick: async () => {
                    await api.updateMedication(med.id, { active: !med.active });
                    await load();
                  },
                }}
                onEdit={() => startEdit(med)}
                onDelete={async () => {
                  await api.deleteMedication(med.id);
                  await load();
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {showAdd ? (
        <form className="entry-form" onSubmit={add}>
          <div className="field">
            <label htmlFor="med-name">ชื่อยา</label>
            <input
              id="med-name"
              type="text"
              placeholder="เช่น ยาความดัน"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="med-times">เวลา</label>
              <input
                id="med-times"
                type="text"
                placeholder="08:00, 20:00"
                value={times}
                onChange={(e) => setTimes(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="med-dosage">
                ขนาด <span className="optional">(ไม่บังคับ)</span>
              </label>
              <input
                id="med-dosage"
                type="text"
                placeholder="เช่น 1 เม็ด"
                value={dosage}
                onChange={(e) => setDosage(e.target.value)}
              />
            </div>
          </div>
          <div className="field-row">
            <button type="button" className="form-toggle" onClick={closeForm}>
              ยกเลิก
            </button>
            <button type="submit" className="form-submit" disabled={saving}>
              {saving ? 'กำลังบันทึก...' : editingId ? 'บันทึกการแก้ไข' : 'ตั้งเตือนยา'}
            </button>
          </div>
          {!editingId && <div className="muted">ยาจะบันทึกเป็นของคนที่เปิดแอปอยู่ตอนนี้</div>}
        </form>
      ) : (
        <button type="button" className="form-toggle" onClick={() => setShowAdd(true)}>
          ＋ เพิ่มยา
        </button>
      )}
    </div>
  );
}

function ChoresSection() {
  const [chores, setChores] = useState<ChoreItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState('WEEKLY');
  const [rotation, setRotation] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => api.chores().then((r) => setChores(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const closeForm = () => {
    setShowAdd(false);
    setEditingId(null);
    setName('');
    setCadence('WEEKLY');
    setRotation('');
  };

  const startEdit = (chore: ChoreItem) => {
    setEditingId(chore.id);
    setName(chore.name);
    setCadence(chore.cadence);
    setShowAdd(true);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const rotationNames = rotation
      .split(/[,\s]+/)
      .map((n) => n.trim())
      .filter(Boolean);

    setSaving(true);
    try {
      if (editingId) {
        // The rotation is fixed when the chore is created — editing covers the
        // parts that actually drift: what it is called and how often it comes
        // round. Changing who is in the rotation means making a new chore.
        await api.updateChore(editingId, { name: name.trim(), cadence });
      } else {
        await api.addChore({ name: name.trim(), cadence, rotationNames });
      }
      closeForm();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dash-section">
      <div className="dash-section-heading">🧹 งานบ้าน</div>
      {!chores ? (
        <p className="loading">กำลังโหลด...</p>
      ) : chores.length === 0 ? (
        <p className="empty">ยังไม่มีเวร — พิมพ์ "ตั้งเวร ล้างจาน ทุกวัน หมุนกับ แม่ พ่อ" ในแชทได้เลย</p>
      ) : (
        <ul className="list">
          {chores.map((chore) => (
            <li key={chore.id} className="finance-item finance-item-stacked">
              <div className="finance-item-row">
                <div className="finance-item-main">
                  <span className="finance-icon">🧹</span>
                  <div>
                    <div>{chore.name}</div>
                    <div className="muted">
                      {cadenceLabel(chore.cadence)}
                      {chore.nextAssignee ? ` · ตาของ ${chore.nextAssignee}` : ''}
                    </div>
                  </div>
                </div>
                {!chore.active && <span className="pill pill-muted">ปิดอยู่</span>}
              </div>
              <RowActions
                extra={{
                  label: chore.active ? 'ปิดเตือน' : 'เปิดเตือน',
                  onClick: async () => {
                    await api.updateChore(chore.id, { active: !chore.active });
                    await load();
                  },
                }}
                onEdit={() => startEdit(chore)}
                onDelete={async () => {
                  await api.deleteChore(chore.id);
                  await load();
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {showAdd ? (
        <form className="entry-form" onSubmit={add}>
          <div className="field">
            <label htmlFor="chore-name">งานบ้าน</label>
            <input
              id="chore-name"
              type="text"
              placeholder="เช่น ล้างจาน"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="chore-cadence">ความถี่</label>
              <select
                id="chore-cadence"
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
              >
                {['DAILY', 'WEEKLY', 'MONTHLY'].map((c) => (
                  <option key={c} value={c}>
                    {cadenceLabel(c)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="chore-rotation">
                หมุนเวรกับ <span className="optional">(ไม่บังคับ)</span>
              </label>
              <input
                id="chore-rotation"
                type="text"
                placeholder="แม่ พ่อ พี่เอ"
                value={rotation}
                onChange={(e) => setRotation(e.target.value)}
                disabled={editingId !== null}
              />
            </div>
          </div>
          {editingId && <div className="muted">ลำดับเวรแก้ไม่ได้ — ถ้าจะเปลี่ยนคน ให้ตั้งเวรใหม่</div>}
          <div className="field-row">
            <button type="button" className="form-toggle" onClick={closeForm}>
              ยกเลิก
            </button>
            <button type="submit" className="form-submit" disabled={saving}>
              {saving ? 'กำลังบันทึก...' : editingId ? 'บันทึกการแก้ไข' : 'ตั้งเวร'}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="form-toggle" onClick={() => setShowAdd(true)}>
          ＋ เพิ่มงานบ้าน
        </button>
      )}
    </div>
  );
}

function ShoppingTab() {
  const [items, setItems] = useState<ShoppingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newItem, setNewItem] = useState('');
  const [newQty, setNewQty] = useState('');

  const load = () => api.shopping().then((r) => setItems(r.items)).catch((e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newItem.trim();
    if (!name) return;
    const qty = newQty.trim();
    setNewItem('');
    setNewQty('');
    await api.addShoppingItems([{ name, ...(qty ? { qty } : {}) }]);
    await load();
  };

  const bought = async (id: string) => {
    // Optimistic: the item disappears immediately, matching what tapping it means.
    setItems((prev) => prev?.filter((i) => i.id !== id) ?? null);
    await api.markBought(id).catch(() => load());
  };

  if (error) return <p className="error">{error}</p>;
  if (!items) return <p className="loading">กำลังโหลด...</p>;

  return (
    <div>
      <form className="quick-add" onSubmit={add}>
        <input
          type="text"
          placeholder="เพิ่มของที่ต้องซื้อ"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
        />
        <input
          type="text"
          placeholder="จำนวน (ไม่บังคับ)"
          value={newQty}
          onChange={(e) => setNewQty(e.target.value)}
        />
        <button type="submit">เพิ่ม</button>
      </form>

      {items.length === 0 ? (
        <p className="empty">ไม่มีของที่ต้องซื้อครับ</p>
      ) : (
        <ul className="list">
          {items.map((item) => (
            <li key={item.id} className="shopping-item">
              <span className="checkbox" onClick={() => bought(item.id)} />
              <span className="shopping-text" onClick={() => bought(item.id)}>
                {item.name}
                {item.qty && <span className="muted"> · {item.qty}</span>}
                {item.addedBy && <span className="muted"> — {item.addedBy}</span>}
              </span>
              <button
                type="button"
                className="row-btn shopping-remove"
                aria-label="ลบรายการนี้"
                onClick={async () => {
                  // Distinct from ticking it off: this one was never wanted.
                  setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? null);
                  await api.deleteShoppingItem(item.id).catch(() => load());
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
