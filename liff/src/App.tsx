import { useEffect, useMemo, useState } from 'react';
import {
  api,
  chooseFamily,
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
  type DigestSettings,
  type LeadTimes,
  type Emergency,
  type SetupItem,
  type SetupKey,
  type ShoppingItem,
  type TaskItem,
  type TransactionItem,
} from './api.js';
import { openExternal } from './liff.js';
import { weekSpans } from './spans.js';
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
  eventDayKeys,
  spanLabel,
  DOCUMENT_TYPES,
  documentTypeLabel,
  eventCategoryColor,
  eventCategoryIcon,
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
  // Every way into the app — the card in the group, the digest's button, the
  // rich menu — lands on the family's calendar: it is what people open the app
  // to look at. The dashboard is one tap away in the bar.
  const [tab, setTab] = useState<Tab>('agenda');
  // A day tapped on the dashboard's board, for the calendar tab to open on.
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  // A setup-checklist line tapped, for the manage tab to open on.
  const [manageFocus, setManageFocus] = useState<SetupKey | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="screen center error">{welcomeOrError(error)}</div>;
  if (!me) return <div className="screen center loading">กำลังโหลด...</div>;

  const initial = me.displayName.trim().charAt(0) || '🏡';

  return (
    <div className="screen">
      <header className="topbar">
        <div className="avatar">{initial}</div>
        <div className="greeting">บ้านเรา · {me.displayName}</div>
        {me.families.length > 1 && (
          <select
            className="family-switch"
            aria-label="เลือกครอบครัว"
            value={me.familyId}
            onChange={(e) => {
              chooseFamily(e.target.value);
              // Every tab holds data from the old family; start clean.
              window.location.reload();
            }}
          >
            {me.families.map((f) => (
              <option key={f.familyId} value={f.familyId}>
                บ้าน {f.label}
              </option>
            ))}
          </select>
        )}
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
            onOpenSetup={(key) => {
              setManageFocus(key);
              setTab('manage');
            }}
          />
        )}
        {tab === 'tasks' && <TasksTab timezone={me.timezone} />}
        {tab === 'agenda' && <CalendarTab timezone={me.timezone} initialDay={calendarDay} />}
        {tab === 'money' && <MoneyTab />}
        {tab === 'shopping' && <ShoppingTab />}
        {tab === 'manage' && <ManageTab focus={manageFocus} />}
      </main>

      <nav className="tabbar">
        {(
          [
            ['agenda', '📅', 'ปฏิทิน'],
            ['dashboard', '🏠', 'หน้าหลัก'],
            ['tasks', '📋', 'งาน'],
            ['money', '💰', 'เงิน'],
            ['shopping', '🛒', 'ซื้อของ'],
            ['manage', '⚙️', 'จัดการ'],
          ] as const
        ).map(([key, icon, label]) => (
          <button
            key={key}
            className={tab === key ? 'active' : ''}
            onClick={() => {
              // The tab bar always opens the calendar on today, and the
              // manage tab plain rather than jumped into a section.
              if (key === 'agenda') setCalendarDay(null);
              if (key === 'manage') setManageFocus(null);
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
 * Someone the bot has never seen speak is not an error, it is a first visit.
 *
 * The bot learns who people are from the group — when they join, or the first
 * time they say anything. Whoever was already in the group before the bot
 * arrived and has stayed quiet since gets here, and "401 unauthorized" tells
 * them nothing about the one thing that fixes it.
 */
function welcomeOrError(message: string): string {
  return /^401\b|unauthorized/i.test(message)
    ? 'ยังไม่รู้จักคุณในกลุ่มนี้ครับ — ทักอะไรสักคำในกลุ่มที่มีบอทอยู่ แล้วเปิดแอปอีกครั้ง'
    : message;
}

/**
 * The server's own sentence out of an API error, when it sent one.
 * request() reports `400 Bad Request: "ไม่พบชื่อในบ้าน: ..."`, and only the
 * part in quotes means anything to the person holding the phone.
 */
function readableError(err: unknown): string {
  const message = (err as Error).message ?? String(err);
  const quoted = message.match(/^\d{3}[^:]*: "(.+)"$/);
  return quoted ? (quoted[1] as string) : message;
}

/**
 * Edit / delete buttons for one row. Deleting asks first, inline — a mis-tap
 * on a list of small rows is easy, and nothing here can be undone from the app.
 */
function RowActions({
  onEdit,
  onDelete,
  extra,
  editLabel = 'แก้ไข',
  deleteLabel = 'ลบ',
  confirmText = 'ลบรายการนี้?',
}: {
  onEdit?: () => void;
  onDelete: () => void | Promise<void>;
  extra?: { label: string; onClick: () => void | Promise<void> };
  editLabel?: string;
  deleteLabel?: string;
  confirmText?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (confirming) {
    return (
      <div className="row-actions">
        <span className="muted">{confirmText}</span>
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
          {editLabel}
        </button>
      )}
      <button type="button" className="row-btn" onClick={() => setConfirming(true)}>
        {deleteLabel}
      </button>
    </div>
  );
}

/** Where a checklist item is dealt with: in the app, or by typing in the chat. */
const SETUP_CHAT_HINT: Partial<Record<SetupKey, string>> = {
  budgets: 'พิมพ์ในแชต: ตั้งงบ ค่าไฟ 1000 บาท',
  birthdays: 'พิมพ์ในแชต: วันเกิด น้องพร 5 ม.ค. 2560',
};

/**
 * What the house has not set up yet.
 *
 * The bot only reminds about things somebody entered, and a family that has
 * entered appointments and nothing else has no way of knowing what it is
 * missing. Shown until everything is ticked, then gone for good — it is a
 * checklist, not a nag.
 */
function SetupChecklist({
  items,
  doneCount,
  onOpen,
}: {
  items: SetupItem[];
  doneCount: number;
  onOpen: (key: SetupKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const todo = items.filter((i) => !i.done);
  if (todo.length === 0) return null;

  return (
    <div className="dash-section setup-card">
      <button type="button" className="setup-head" onClick={() => setOpen(!open)}>
        <span className="dash-section-heading">✨ เริ่มต้นใช้งาน</span>
        <span className="setup-count">
          {doneCount}/{items.length}
        </span>
        <span className="agenda-chevron">{open ? '▾' : '▸'}</span>
      </button>

      <div className="setup-progress">
        <span style={{ width: `${(doneCount / items.length) * 100}%` }} />
      </div>

      {open ? (
        <ul className="list">
          {todo.map((item) => {
            const hint = SETUP_CHAT_HINT[item.key];
            return (
              <li key={item.key} className="setup-item">
                <div className="agenda-text">
                  <div>{item.label}</div>
                  <div className="muted">{item.hint}</div>
                  {hint && <div className="muted setup-chat-hint">{hint}</div>}
                </div>
                {!hint && (
                  <button type="button" className="row-btn" onClick={() => onOpen(item.key)}>
                    ตั้งค่า
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">ยังไม่ได้ตั้ง {todo.length} อย่าง — แตะเพื่อดู</p>
      )}
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
            {/* The text already names the day and time; the reminder's own time
                read as the appointment's and confused people. */}
            <div className="agenda-text">{item.text}</div>
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
  onOpenSetup,
}: {
  timezone: string;
  displayName: string;
  onOpenDay: (key: string) => void;
  onOpenSetup: (key: SetupKey) => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incomeAmount, setIncomeAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [board, setBoard] = useState<{ events: EventSummary[]; holidays: Holiday[] } | null>(null);
  const [setup, setSetup] = useState<{ items: SetupItem[]; doneCount: number } | null>(null);

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
    // Also a nicety: a checklist that fails to load is not worth an error page.
    api.setup().then(setSetup).catch(() => setSetup(null));
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

      {setup && (
        <SetupChecklist items={setup.items} doneCount={setup.doneCount} onOpen={onOpenSetup} />
      )}

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
      // A trip is drawn as one bar across its days (see weekSpans), unless
      // this is the small copy on the dashboard, which only has room for dots.
      const keys = eventDayKeys(ev, timezone);
      for (const key of keys.length > 1 && !compact ? [] : keys) {
        const bucket = map.get(key);
        if (bucket) bucket.push(ev);
        else map.set(key, [ev]);
      }
    }
    // All-day first, then by time — the order someone would write them in.
    for (const bucket of map.values()) {
      bucket.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startAt.localeCompare(b.startAt));
    }
    return map;
  }, [events, timezone, compact]);

  // Trips, camps, school holidays: everything that lasts more than one day.
  const spans = useMemo(
    () =>
      compact
        ? []
        : (events ?? [])
            .map((ev) => ({ ev, days: eventDayKeys(ev, timezone) }))
            .filter((s) => s.days.length > 1),
    [events, timezone, compact],
  );

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
  const weeks: Array<Array<{ key: string; day: number; weekday: number } | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

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
        {weeks.map((week, w) => {
          const bars = weekSpans(week, spans);
          const lanes = bars.reduce((most, b) => Math.max(most, b.lane + 1), 0);
          return (
            <div
              key={`week-${w}`}
              className="board-week"
              style={{ '--lanes': lanes } as React.CSSProperties}
            >
        {week.map((cell, i) => {
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
              {/* Room for the bars drawn over this row. */}
              {lanes > 0 && <span className="board-lane-space" style={{ height: lanes * 17 }} />}

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

              {/* One bar per trip, straight across the days it covers. Taps fall
                  through to the day underneath, so the day's list still opens. */}
              {bars.map((bar) => (
                <span
                  key={`${bar.ev.id}|${bar.ev.startAt}`}
                  className={`board-span${bar.isStart ? ' is-start' : ''}${bar.isEnd ? ' is-end' : ''}`}
                  style={
                    {
                      left: `${(bar.from * 100) / 7}%`,
                      width: `${((bar.to - bar.from + 1) * 100) / 7}%`,
                      top: `${22 + bar.lane * 17}px`,
                      '--chip': eventCategoryColor(bar.ev.category),
                    } as React.CSSProperties
                  }
                >
                  {/* Named again at the top of each week it runs into. */}
                  {bar.isStart || bar.from === 0 ? bar.ev.title : ' '}
                </span>
              ))}
            </div>
          );
        })}
      </div>

      {events === null && <div className="board-loading">กำลังโหลด...</div>}
    </div>
  );
}

/** The labelled facts of one appointment, shared by the board and the week view. */
function EventDetailRows({ detail, timezone }: { detail: EventDetail; timezone: string }) {
  return (
    <>
      <div className="agenda-detail-row">
        <span className="muted">ประเภท</span>
        <span>{eventCategoryLabel(detail.category)}</span>
      </div>
      <div className="agenda-detail-row">
        <span className="muted">{detail.endAt && spanLabel(detail, timezone) ? 'ช่วง' : 'เวลา'}</span>
        <span>
          {spanLabel(detail, timezone) ?? (detail.allDay ? 'ทั้งวัน' : thaiTimeOnly(detail.startAt))}
        </span>
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

/**
 * The action rows under an appointment's details. A repeating one gets two:
 * "เฉพาะ 14 ก.ย." for that date alone, and "ทุกครั้ง" for the whole series —
 * so nobody deletes every Monday's physio while meaning to skip one.
 */
function EventActions({
  ev,
  timezone,
  onEdit,
  onChanged,
}: {
  ev: EventSummary;
  timezone: string;
  /** Called with the occurrence's start to change that date only. */
  onEdit: (occurrence?: string) => void;
  onChanged: () => void | Promise<void>;
}) {
  return (
    <>
      {ev.repeats && (
        <>
          <div className="occ-label">เฉพาะ {thaiShortDayMonth(dayKey(ev.startAt, timezone))}</div>
          <RowActions
            editLabel="เลื่อน/แก้ครั้งนี้"
            deleteLabel="ข้ามครั้งนี้"
            confirmText="ข้ามนัดครั้งนี้?"
            onEdit={() => onEdit(ev.startAt)}
            onDelete={async () => {
              await api.skipOccurrence(ev.id, ev.startAt);
              await onChanged();
            }}
          />
          <div className="occ-label">ทุกครั้ง</div>
        </>
      )}
      <RowActions
        editLabel={ev.repeats ? 'แก้ทั้งชุด' : 'แก้ไข'}
        deleteLabel={ev.repeats ? 'ลบทั้งชุด' : 'ลบ'}
        confirmText={ev.repeats ? 'ลบนัดนี้ทุกครั้ง?' : 'ลบรายการนี้?'}
        onEdit={() => onEdit()}
        onDelete={async () => {
          await api.deleteEvent(ev.id);
          await onChanged();
        }}
      />
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
  // One kind at a time — "what's on for school this month" — or everything.
  const [kind, setKind] = useState<string | null>(null);
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
  const [editingEvent, setEditingEvent] = useState<{
    id: string;
    detail: EventDetail;
    occurrence?: string;
  } | null>(null);

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

  const monthEvents = current?.events ?? [];
  const shownEvents = kind ? monthEvents.filter((e) => e.category === kind) : monthEvents;
  const kindCounts = EVENT_CATEGORIES.map((c) => ({
    c,
    n: new Set(monthEvents.filter((e) => e.category === c).map((e) => `${e.id}|${e.startAt}`)).size,
  })).filter((k) => k.n > 0);
  const dayEvents = shownEvents.filter((e) => eventDayKeys(e, timezone).includes(selected));
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

      {kindCounts.length > 1 && (
        <div className="kind-filter" role="group" aria-label="กรองตามหมวด">
          <button className={kind === null ? 'active' : ''} aria-pressed={kind === null} onClick={() => setKind(null)}>
            ทั้งหมด
          </button>
          {kindCounts.map(({ c, n }) => (
            <button
              key={c}
              className={kind === c ? 'active' : ''}
              aria-pressed={kind === c}
              style={{ '--chip': eventCategoryColor(c) } as React.CSSProperties}
              onClick={() => setKind(kind === c ? null : c)}
            >
              {eventCategoryIcon(c)} {eventCategoryLabel(c)} <span className="kind-count">{n}</span>
            </button>
          ))}
        </div>
      )}

      {calView === 'board' ? (
        <CalendarBoard
          monthKey={monthKey}
          todayKey={todayKey}
          selected={selected}
          events={current ? shownEvents : null}
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
                        <span className="kind-tag" style={{ color: eventCategoryColor(ev.category) }}>
                          {eventCategoryIcon(ev.category)} {eventCategoryLabel(ev.category)}
                        </span>
                        {' · '}
                        {spanLabel(ev, timezone) ?? (ev.allDay ? 'ทั้งวัน' : thaiTimeOnly(ev.startAt))}
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
                          <EventDetailRows detail={detail} timezone={timezone} />
                          <EventActions
                            ev={ev}
                            timezone={timezone}
                            onEdit={(occurrence) => {
                              setEditingEvent({
                                id: ev.id,
                                detail,
                                ...(occurrence ? { occurrence } : {}),
                              });
                              setShowAddEvent(false);
                            }}
                            onChanged={async () => {
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
  // null: not editing. {}: the whole appointment. { occurrence }: that date only.
  const [editing, setEditing] = useState<{ occurrence?: string } | null>(null);

  const load = () =>
    api
      .events(`${weekStartKey}T00:00:00`, `${weekEndKey}T23:59:59`)
      .then((r) => setEvents(r.items))
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    setSelectedEvent(null);
    setDetail(null);
    setEditing(null);
    load();
  }, [weekStartKey, weekEndKey]);

  // Every week of a repeating appointment shares its id, so a block is
  // identified by id and start together.
  const isChosenEvent = (ev: EventSummary) =>
    selectedEvent?.id === ev.id && selectedEvent.startAt === ev.startAt;

  const byDay = useMemo(() => {
    const map = new Map<string, EventSummary[]>();
    for (const ev of events ?? []) {
      // An all-day trip fills its every day; a timed block is drawn where it starts.
      for (const key of ev.allDay ? eventDayKeys(ev, timezone) : [dayKey(ev.startAt, timezone)]) {
        const bucket = map.get(key);
        if (bucket) bucket.push(ev);
        else map.set(key, [ev]);
      }
    }
    return map;
  }, [events, timezone]);

  const selectEvent = async (ev: EventSummary) => {
    setEditing(null);
    if (isChosenEvent(ev)) {
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
                          className={`week-event${isChosenEvent(ev) ? ' week-event-selected' : ''}`}
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
              <EventDetailRows detail={detail} timezone={timezone} />
              {editing ? (
                <AddEventForm
                  selectedDay={dayKey(selectedEvent.startAt, timezone)}
                  timezone={timezone}
                  editing={{
                    id: detail.id,
                    detail,
                    ...(editing.occurrence ? { occurrence: editing.occurrence } : {}),
                  }}
                  onCancel={() => setEditing(null)}
                  onAdded={async () => {
                    setEditing(null);
                    setSelectedEvent(null);
                    setDetail(null);
                    await load();
                  }}
                />
              ) : (
                <EventActions
                  ev={selectedEvent}
                  timezone={timezone}
                  onEdit={(occurrence) => setEditing(occurrence ? { occurrence } : {})}
                  onChanged={async () => {
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
  /**
   * Set when correcting an existing appointment rather than adding one. With
   * `occurrence` (that date's start), only that one date of a repeating
   * appointment is changed; without it, the whole appointment is.
   */
  editing?: { id: string; detail: EventDetail; occurrence?: string };
  timezone: string;
}

function AddEventForm({ selectedDay, onAdded, onCancel, editing, timezone }: AddEventFormProps) {
  const existing = editing?.detail;
  const occurrence = editing?.occurrence;
  // What the form starts from: the one date being changed, or the appointment itself.
  const shownStart = occurrence ?? existing?.startAt;

  const [title, setTitle] = useState(existing?.title ?? '');
  const [allDay, setAllDay] = useState(existing?.allDay ?? false);
  const [day, setDay] = useState(shownStart ? dayKey(shownStart, timezone) : selectedDay);
  // The last day of a trip; blank (or the same day) is a single day.
  const [endDay, setEndDay] = useState(
    !occurrence && existing?.endAt && existing.allDay ? dayKey(existing.endAt, timezone) : '',
  );
  const [time, setTime] = useState(
    shownStart && !existing?.allDay ? clockHHmm(shownStart, timezone) : '09:00',
  );
  const [category, setCategory] = useState<(typeof EVENT_CATEGORIES)[number]>(
    (existing?.category as (typeof EVENT_CATEGORIES)[number]) ?? 'OTHER',
  );
  // A new appointment's kind is guessed from its title, as in the chat, until
  // someone picks one.
  const [categoryChosen, setCategoryChosen] = useState(Boolean(existing));
  const [location, setLocation] = useState(existing?.location ?? '');
  const [attendeeName, setAttendeeName] = useState(existing?.attendeeNames[0] ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [rrule, setRrule] = useState(existing?.rrule ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Spans are all-day, one-off appointments: "เที่ยวจูไห่ 1-7 ต.ค.".
  const canSpan = allDay && !occurrence && !rrule;
  const spanEnd = canSpan && endDay > day ? endDay : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !day) return;
    if (canSpan && endDay && endDay < day) {
      setError('วันสุดท้ายต้องไม่ก่อนวันเริ่ม');
      return;
    }

    setSaving(true);
    try {
      if (editing && occurrence) {
        await api.detachOccurrence(editing.id, occurrence, {
          title: title.trim(),
          startAt: allDay ? day : `${day}T${time}`,
          allDay,
          category,
          location: location.trim() || null,
          attendeeName: attendeeName.trim() || null,
          note: note.trim() || null,
        });
      } else if (editing) {
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
          endAt: spanEnd,
        });
      } else {
        await api.addEvent({
          title: title.trim(),
          startAt: allDay ? day : `${day}T${time}`,
          ...(spanEnd ? { endAt: spanEnd } : {}),
          allDay,
          ...(categoryChosen ? { category } : {}),
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

      {occurrence && (
        <div className="muted">
          แก้เฉพาะวันที่ {thaiShortDayMonth(dayKey(occurrence, timezone))} — ครั้งอื่นยังเหมือนเดิม
        </div>
      )}

      {/* Tapped from a day in the middle of a trip: say that both ends move. */}
      {!occurrence && existing?.endAt && (
        <div className="muted">
          แก้ได้ทั้งช่วง {spanLabel(existing, timezone)} — เปลี่ยนวันเริ่มหรือวันสุดท้ายได้เลย
        </div>
      )}

      <label className="checkbox-field">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        ทั้งวัน ไม่ระบุเวลา
      </label>

      <div className="field-row">
        <div className="field">
          <label htmlFor="event-day">{canSpan ? 'ตั้งแต่วันที่' : 'วันที่'}</label>
          <input
            id="event-day"
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            required
          />
        </div>
        {canSpan && (
          <div className="field">
            <label htmlFor="event-end-day">ถึงวันที่ (ถ้าหลายวัน)</label>
            <input
              id="event-end-day"
              type="date"
              value={endDay}
              min={day}
              onChange={(e) => setEndDay(e.target.value)}
            />
          </div>
        )}
        {!allDay && (
          <div className="field">
            <label htmlFor="event-time">เวลา</label>
            <input id="event-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        )}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="event-category">ประเภท</label>
          <select
            id="event-category"
            value={categoryChosen ? category : ''}
            onChange={(e) => {
              setCategory(e.target.value as typeof category);
              setCategoryChosen(true);
            }}
          >
            {!categoryChosen && <option value="">เดาจากชื่อเรื่อง</option>}
            {EVENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {eventCategoryIcon(c)} {eventCategoryLabel(c)}
              </option>
            ))}
          </select>
        </div>

        {/* A single date pulled out of a series is a one-off by definition. */}
        {!occurrence && (
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
        )}
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
          {saving
            ? 'กำลังบันทึก...'
            : occurrence
              ? 'บันทึกเฉพาะครั้งนี้'
              : editing
                ? 'บันทึกการแก้ไข'
                : 'บันทึกนัดหมาย'}
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
function ManageTab({ focus }: { focus?: SetupKey | null }) {
  // Arriving from the setup checklist should land on the thing that was
  // tapped, with its form already open — not at the top of a long page.
  useEffect(() => {
    if (!focus) return;
    document.getElementById(`section-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus]);

  return (
    <div>
      <DigestSettingsSection />
      <LeadTimesSection />
      <BillsSection openAdd={focus === 'bills'} />
      <DocumentsSection openAdd={focus === 'documents'} />
      <MedicationsSection openAdd={focus === 'medications'} />
      <ChoresSection openAdd={focus === 'chores'} />
      <EmergencySection openEdit={focus === 'emergency'} />
      <BackupSection />
    </div>
  );
}

/** Every half hour between two times, as "HH:mm". */
function halfHours(fromHour: number, toHour: number): string[] {
  const out: string[] = [];
  for (let h = fromHour; h <= toHour; h++) {
    for (const m of ['00', '30']) out.push(`${String(h).padStart(2, '0')}:${m}`);
  }
  return out;
}

const MORNING_TIMES = halfHours(4, 11);
const EVENING_TIMES = halfHours(15, 23);

/** ISO weekday order, starting Monday the way a Thai wall calendar does. */
const WEEKDAYS: Array<[number, string]> = [
  [1, 'จ'],
  [2, 'อ'],
  [3, 'พ'],
  [4, 'พฤ'],
  [5, 'ศ'],
  [6, 'ส'],
  [7, 'อา'],
];

/**
 * When the bot talks to the group. The first week went three days without a
 * word because nothing happened to be due — correct by the design at the time,
 * and not what the family wanted — so the times, and whether a quiet morning
 * still gets its message, are theirs to choose.
 */
function DigestSettingsSection() {
  const [form, setForm] = useState<DigestSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    api
      .digestSettings()
      .then(setForm)
      .catch((e: Error) => setNote({ text: readableError(e), error: true }));
  }, []);

  if (!form) {
    return (
      <div className="dash-section" id="section-digest">
        <div className="dash-section-heading">🔔 การแจ้งเตือนประจำวัน</div>
        {note ? <p className="error">{note.text}</p> : <p className="loading">กำลังโหลด...</p>}
      </div>
    );
  }

  const update = (patch: Partial<DigestSettings>) => {
    setForm({ ...form, ...patch });
    setNote(null);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.saveDigestSettings(form);
      setNote({ text: 'บันทึกแล้ว — มีผลตั้งแต่รอบถัดไป' });
    } catch (err) {
      setNote({ text: readableError(err), error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dash-section" id="section-digest">
      <div className="dash-section-heading">🔔 การแจ้งเตือนประจำวัน</div>
      <form className="entry-form digest-settings" onSubmit={save}>
        <div className="digest-row">
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={form.morningOn}
              onChange={(e) => update({ morningOn: e.target.checked })}
            />
            สรุปเช้า
          </label>
          <select
            aria-label="เวลาสรุปเช้า"
            value={form.morningAt}
            disabled={!form.morningOn}
            onChange={(e) => update({ morningAt: e.target.value })}
          >
            {MORNING_TIMES.map((t) => (
              <option key={t} value={t}>
                {t} น.
              </option>
            ))}
          </select>
        </div>

        <label className={`checkbox-field digest-sub${form.morningOn ? '' : ' is-disabled'}`}>
          <input
            type="checkbox"
            checked={form.everyMorning}
            disabled={!form.morningOn}
            onChange={(e) => update({ everyMorning: e.target.checked })}
          />
          ส่งทุกเช้า แม้วันนั้นไม่มีอะไรครบกำหนด
          <span className="muted"> (บอกนัดใน 7 วันข้างหน้าแทน)</span>
        </label>

        <div className="digest-row">
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={form.eveningOn}
              onChange={(e) => update({ eveningOn: e.target.checked })}
            />
            สรุปเย็น
          </label>
          <select
            aria-label="เวลาสรุปเย็น"
            value={form.eveningAt}
            disabled={!form.eveningOn}
            onChange={(e) => update({ eveningAt: e.target.value })}
          >
            {EVENING_TIMES.map((t) => (
              <option key={t} value={t}>
                {t} น.
              </option>
            ))}
          </select>
        </div>
        <label className={`checkbox-field digest-sub${form.eveningOn ? '' : ' is-disabled'}`}>
          <input
            type="checkbox"
            checked={form.everyEvening}
            disabled={!form.eveningOn}
            onChange={(e) => update({ everyEvening: e.target.checked })}
          />
          ส่งทุกเย็น แม้วันนั้นไม่มีอะไรครบกำหนด
        </label>

        <div className="digest-days-label">ส่งวันไหนบ้าง</div>
        <div className="segmented digest-days" role="group" aria-label="วันที่ส่งสรุป">
          {WEEKDAYS.map(([day, label]) => {
            const on = form.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                className={on ? 'active' : ''}
                aria-pressed={on}
                onClick={() =>
                  update({ days: on ? form.days.filter((d) => d !== day) : [...form.days, day].sort() })
                }
              >
                {label}
              </button>
            );
          })}
        </div>
        {form.days.length < 7 && form.days.length > 0 && (
          <div className="muted">วันที่ไม่ส่ง เรื่องที่ครบกำหนดจะรวมไปบอกในรอบถัดไปก่อนถึงวันจริง</div>
        )}

        <button
          type="submit"
          className="form-submit"
          disabled={saving || (!form.morningOn && !form.eveningOn) || form.days.length === 0}
        >
          {saving ? 'กำลังบันทึก...' : 'บันทึกการแจ้งเตือน'}
        </button>
        {!form.morningOn && !form.eveningOn && (
          <p className="error">ต้องเปิดไว้อย่างน้อย 1 รอบ ไม่อย่างนั้นการเตือนจะไม่ถูกส่งเลย</p>
        )}
        {form.days.length === 0 && <p className="error">ต้องเลือกอย่างน้อย 1 วัน</p>}
        {note && <p className={note.error ? 'error' : 'muted'}>{note.text}</p>}
      </form>
    </div>
  );
}

const DAY = 24 * 60;

/** The choices offered per kind — the defaults are always among them. */
const LEAD_CHOICES: Array<{ kind: keyof LeadTimes; title: string; options: Array<[number, string]> }> = [
  {
    kind: 'event',
    title: '📅 นัดหมาย',
    options: [
      [7 * DAY, '7 วัน'],
      [3 * DAY, '3 วัน'],
      [DAY, '1 วัน'],
      [120, '2 ชม.'],
    ],
  },
  {
    kind: 'bill',
    title: '💸 บิล',
    options: [
      [7 * DAY, '7 วัน'],
      [3 * DAY, '3 วัน'],
      [DAY, '1 วัน'],
      [0, 'วันครบกำหนด'],
    ],
  },
  {
    kind: 'document',
    title: '📄 เอกสารหมดอายุ',
    options: [
      [90 * DAY, '90 วัน'],
      [60 * DAY, '60 วัน'],
      [30 * DAY, '30 วัน'],
      [7 * DAY, '7 วัน'],
    ],
  },
  {
    kind: 'task',
    title: '✅ งาน',
    options: [
      [3 * DAY, '3 วัน'],
      [DAY, '1 วัน'],
      [0, 'วันครบกำหนด'],
    ],
  },
];

/**
 * How far ahead each kind of thing is reminded. A change applies to what is
 * already on record too, not only to what gets added next.
 */
function LeadTimesSection() {
  const [form, setForm] = useState<LeadTimes | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    api
      .leadTimes()
      .then(setForm)
      .catch((e: Error) => setNote({ text: readableError(e), error: true }));
  }, []);

  if (!form) {
    return (
      <div className="dash-section" id="section-lead-times">
        <div className="dash-section-heading">⏰ เตือนล่วงหน้า</div>
        {note ? <p className="error">{note.text}</p> : <p className="loading">กำลังโหลด...</p>}
      </div>
    );
  }

  const toggle = (kind: keyof LeadTimes, minutes: number) => {
    const current = form[kind];
    const next = current.includes(minutes) ? current.filter((m) => m !== minutes) : [...current, minutes];
    setForm({ ...form, [kind]: next.sort((a, b) => b - a) });
    setNote(null);
  };
  const empty = LEAD_CHOICES.filter((c) => form[c.kind].length === 0);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      setForm(await api.saveLeadTimes(form));
      setNote({ text: 'บันทึกแล้ว — ใช้กับรายการเดิมและรายการใหม่ทั้งหมด' });
    } catch (err) {
      setNote({ text: readableError(err), error: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dash-section" id="section-lead-times">
      <div className="dash-section-heading">⏰ เตือนล่วงหน้า</div>
      <form className="entry-form" onSubmit={save}>
        {LEAD_CHOICES.map(({ kind, title, options }) => (
          <div key={kind} className="lead-kind">
            <div className="digest-days-label">{title}</div>
            <div className="segmented" role="group" aria-label={`เตือน${title}ล่วงหน้า`}>
              {options.map(([minutes, label]) => {
                const on = form[kind].includes(minutes);
                return (
                  <button
                    key={minutes}
                    type="button"
                    className={on ? 'active' : ''}
                    aria-pressed={on}
                    onClick={() => toggle(kind, minutes)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="muted">เตือนจะไปอยู่ในสรุปรอบที่ใกล้ที่สุดก่อนถึงเวลานั้น</div>
        <button type="submit" className="form-submit" disabled={saving || empty.length > 0}>
          {saving ? 'กำลังบันทึก...' : 'บันทึกช่วงเตือน'}
        </button>
        {empty.length > 0 && (
          <p className="error">เลือกอย่างน้อย 1 ช่วงให้ {empty.map((c) => c.title.replace(/^\S+ /, '')).join(', ')}</p>
        )}
        {note && <p className={note.error ? 'error' : 'muted'}>{note.text}</p>}
      </form>
    </div>
  );
}

/**
 * The caller's own emergency card. Only ever their own row — the same rule the
 * chat command keeps, for the same reason.
 */
function EmergencySection({ openEdit }: { openEdit?: boolean }) {
  const [data, setData] = useState<Emergency | null>(null);
  const [editing, setEditing] = useState(openEdit ?? false);
  const [bloodType, setBloodType] = useState('');
  const [allergies, setAllergies] = useState('');
  const [conditions, setConditions] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .emergency()
      .then((r) => {
        setData(r);
        setBloodType(r.bloodType ?? '');
        setAllergies(r.allergies ?? '');
        setConditions(r.conditions ?? '');
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.saveEmergency({
        bloodType: bloodType.trim() || null,
        allergies: allergies.trim() || null,
        conditions: conditions.trim() || null,
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;

  const empty = !data?.bloodType && !data?.allergies && !data?.conditions;

  return (
    <div className="dash-section" id="section-emergency">
      <div className="dash-section-heading">🚑 ข้อมูลฉุกเฉินของคุณ</div>

      {!editing && (
        <>
          {empty ? (
            <p className="empty">ยังไม่ได้กรอก — ตอนฉุกเฉินคนในบ้านเปิดดูได้ทันที</p>
          ) : (
            <ul className="list">
              <li className="agenda-item">
                <div className="agenda-text">
                  <div>กรุ๊ปเลือด {data?.bloodType || '—'}</div>
                  <div className="muted">แพ้ยา: {data?.allergies || 'ไม่มี'}</div>
                  <div className="muted">โรคประจำตัว: {data?.conditions || 'ไม่มี'}</div>
                </div>
              </li>
            </ul>
          )}
          <button type="button" className="form-toggle" onClick={() => setEditing(true)}>
            {empty ? '＋ กรอกข้อมูลฉุกเฉิน' : 'แก้ไข'}
          </button>
        </>
      )}

      {editing && (
        <form className="entry-form" onSubmit={save}>
          <div className="field-row">
            <div className="field">
              <label htmlFor="em-blood">กรุ๊ปเลือด</label>
              <input
                id="em-blood"
                type="text"
                placeholder="เช่น O"
                value={bloodType}
                onChange={(e) => setBloodType(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="em-allergies">
              แพ้ยา/แพ้อาหาร <span className="optional">(ไม่บังคับ)</span>
            </label>
            <input
              id="em-allergies"
              type="text"
              placeholder="เช่น เพนิซิลลิน"
              value={allergies}
              onChange={(e) => setAllergies(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="em-conditions">
              โรคประจำตัว <span className="optional">(ไม่บังคับ)</span>
            </label>
            <input
              id="em-conditions"
              type="text"
              placeholder="เช่น เบาหวาน"
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
            />
          </div>
          <div className="field-row">
            <button type="button" className="form-toggle" onClick={() => setEditing(false)}>
              ยกเลิก
            </button>
            <button type="submit" className="form-submit" disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
          <div className="muted">ข้อมูลนี้ไม่เคยถูกส่งให้ AI และแก้ได้เฉพาะของตัวเอง</div>
        </form>
      )}
    </div>
  );
}

/** One file with everything in it, for the family to keep somewhere else. */
function BackupSection() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setNote(null);
    try {
      const { url, expiresInMinutes } = await api.exportLink();
      await openExternal(url);
      setNote(`เปิดในเบราว์เซอร์แล้ว ลิงก์ใช้ได้ ${expiresInMinutes} นาที`);
    } catch (err) {
      setNote(readableError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dash-section" id="section-backup">
      <div className="dash-section-heading">💾 สำรองข้อมูล</div>
      <p className="muted">
        ดาวน์โหลดทุกอย่างที่บันทึกไว้เป็นไฟล์เดียว (นัดหมาย เงิน บิล เอกสาร ยา เวร ของที่ต้องซื้อ
        ทรัพย์สิน) เก็บไว้เผื่อฐานข้อมูลมีปัญหา
      </p>
      <button type="button" className="form-toggle" onClick={download} disabled={busy}>
        {busy ? 'กำลังสร้างลิงก์...' : '⬇️ ดาวน์โหลดไฟล์สำรอง'}
      </button>
      {note && <p className="muted">{note}</p>}
    </div>
  );
}

function BillsSection({ openAdd }: { openAdd?: boolean }) {
  const [bills, setBills] = useState<BillItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(openAdd ?? false);
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
    <div className="dash-section" id="section-bills">
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

function DocumentsSection({ openAdd }: { openAdd?: boolean }) {
  const [documents, setDocuments] = useState<DocumentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(openAdd ?? false);
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
    <div className="dash-section" id="section-documents">
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

function MedicationsSection({ openAdd }: { openAdd?: boolean }) {
  const [meds, setMeds] = useState<MedicationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(openAdd ?? false);
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
    <div className="dash-section" id="section-medications">
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

function ChoresSection({ openAdd }: { openAdd?: boolean }) {
  const [chores, setChores] = useState<ChoreItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(openAdd ?? false);
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState('WEEKLY');
  const [rotation, setRotation] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
    setFormError(null);
  };

  const startEdit = (chore: ChoreItem) => {
    setEditingId(chore.id);
    setName(chore.name);
    setCadence(chore.cadence);
    // Comma-separated: LINE display names often contain spaces.
    setRotation(chore.rotationNames.join(', '));
    setFormError(null);
    setShowAdd(true);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    // Commas when there are any — "Aon Somchai, แม่" is two people, not three.
    // Plain spaces still work for the short household names typed by hand.
    const rotationNames = rotation
      .split(rotation.includes(',') ? ',' : /\s+/)
      .map((n) => n.trim())
      .filter(Boolean);

    setSaving(true);
    setFormError(null);
    try {
      if (editingId) {
        // The first name is whoever goes next — the form was filled in that
        // order, so saving it untouched keeps the turn where it was.
        await api.updateChore(editingId, { name: name.trim(), cadence, rotationNames });
      } else {
        await api.addChore({ name: name.trim(), cadence, rotationNames });
      }
      closeForm();
      await load();
    } catch (err) {
      // Stay in the form: a misspelt name is fixed by retyping it, not by
      // reloading the page.
      setFormError(readableError(err));
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="dash-section" id="section-chores">
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
                placeholder="แม่, พ่อ, พี่เอ"
                value={rotation}
                onChange={(e) => setRotation(e.target.value)}
              />
            </div>
          </div>
          {editingId && <div className="muted">ชื่อแรกคือคนที่ถึงตาถัดไป</div>}
          {formError && <p className="error">{formError}</p>}
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
