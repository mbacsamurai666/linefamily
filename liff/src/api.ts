import { getIdToken } from './liff.js';

const FAMILY_KEY = 'familyId';

/**
 * Which family this phone last chose, for someone in more than one family
 * group. A per-device convenience, so localStorage — and it may be missing or
 * throw (private mode, blocked storage), which just means "the first family".
 */
export function chosenFamily(): string | null {
  try {
    return localStorage.getItem(FAMILY_KEY);
  } catch {
    return null;
  }
}

export function chooseFamily(familyId: string): void {
  try {
    localStorage.setItem(FAMILY_KEY, familyId);
  } catch {
    // Nowhere to remember it; the switch still applies until the page reloads.
  }
  sessionFamily = familyId;
}

let sessionFamily: string | null = chosenFamily();

/** Every request re-fetches the ID token; the SDK caches it, so this is cheap. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const idToken = await getIdToken();

  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'x-liff-id-token': idToken,
      ...(sessionFamily ? { 'x-family-id': sessionFamily } : {}),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `${res.status} ${res.statusText}: ${JSON.stringify((body as { error?: unknown }).error ?? body)}`,
    );
  }
  return res.json() as Promise<T>;
}

export interface Me {
  memberId: string;
  displayName: string;
  familyId: string;
  timezone: string;
  /** Empty unless this LINE account is in more than one family group. */
  families: Array<{ familyId: string; label: string }>;
}

export interface AgendaItem {
  id: string;
  kind: string;
  dueAt: string;
  text: string;
  /** Id of the originating row (Event.id for kind EVENT, etc.). */
  refId: string;
}

export interface EventSummary {
  id: string;
  title: string;
  category: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  location: string | null;
  /** A repeating appointment appears once per occurrence, all sharing `id`. */
  repeats: boolean;
}

export interface Holiday {
  /** "YYYY-MM-DD". */
  date: string;
  name: string;
}

export interface EventDetail {
  id: string;
  title: string;
  category: string;
  startAt: string;
  endAt: string | null;
  allDay: boolean;
  location: string | null;
  note: string | null;
  attendeeNames: string[];
  rrule?: string | null;
}

export interface ExpenseSummary {
  month: string;
  totalSatang: number;
  byCategory: Array<{ name: string; amountSatang: number }>;
}

export interface ShoppingItem {
  id: string;
  name: string;
  qty: string | null;
  addedBy: string | null;
}

export interface ShoppingItemInput {
  name: string;
  qty?: string;
}

export interface NetWorth {
  loansOutstandingSatang: number;
  assetsValueSatang: number;
  depositsSatang: number;
  totalSatang: number;
}

export interface TaskItem {
  id: string;
  title: string;
  status: 'TODO' | 'DOING' | 'DONE';
  assignee: string | null;
  dueAt: string | null;
  note: string | null;
  doneAt: string | null;
  sortOrder: number;
}

export interface DashboardData {
  upcoming: {
    today: AgendaItem[];
    next3d: AgendaItem[];
    next7d: AgendaItem[];
  };
  tasks: {
    todo: number;
    doing: number;
    doneToday: number;
  };
  money: {
    month: string;
    incomeSatang: number;
    expenseSatang: number;
    netSatang: number;
  };
  netWorth: NetWorth;
}

export interface Loan {
  id: string;
  borrowerName: string;
  principalSatang: number;
  repaidSatang: number;
  dueAt: string | null;
  note: string | null;
}

export interface TransactionItem {
  id: string;
  amountSatang: number;
  direction: 'IN' | 'OUT';
  categoryName: string | null;
  note: string | null;
  occurredAt: string;
  paidBy: string | null;
}

export interface BillItem {
  id: string;
  name: string;
  amountSatang: number | null;
  dueDay: number;
  active: boolean;
}

export interface DocumentItem {
  id: string;
  name: string;
  type: string;
  expiresAt: string;
  owner: string | null;
}

export interface MedicationItem {
  id: string;
  name: string;
  dosage: string | null;
  times: string[];
  active: boolean;
  owner: string;
}

export interface ChoreItem {
  id: string;
  name: string;
  cadence: string;
  active: boolean;
  nextDueAt: string;
  nextAssignee: string | null;
  /** In turn order, starting from whoever is up next. */
  rotationNames: string[];
}

export interface Asset {
  id: string;
  name: string;
  category: string;
  valueSatang: number;
  note: string | null;
}

export interface Deposit {
  id: string;
  name: string;
  balanceSatang: number;
  note: string | null;
}

export const api = {
  me: () => request<Me>('/me'),
  // 90 is the server's own cap (see api/router.ts) — enough to render the
  // current month plus a couple ahead in the calendar without refetching.
  agenda: (days = 90) => request<{ items: AgendaItem[] }>(`/agenda?days=${days}`),
  event: (id: string) => request<EventDetail>(`/events/${id}`),
  /** `from`/`to` are "YYYY-MM-DD" or full local datetime strings. */
  events: (from: string, to: string) =>
    request<{ items: EventSummary[]; holidays: Holiday[] }>(
      `/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  expenseSummary: (month?: string) =>
    request<ExpenseSummary>(`/expenses/summary${month ? `?month=${month}` : ''}`),
  addExpense: (body: {
    amountBaht: number;
    direction?: 'IN' | 'OUT';
    categoryName?: string;
    note?: string;
  }) => request('/expenses', { method: 'POST', body: JSON.stringify(body) }),
  shopping: () => request<{ items: ShoppingItem[] }>('/shopping'),
  addShoppingItems: (items: ShoppingItemInput[]) =>
    request('/shopping', { method: 'POST', body: JSON.stringify({ items }) }),
  markBought: (id: string) => request(`/shopping/${id}/bought`, { method: 'POST' }),
  addEvent: (body: {
    title: string;
    startAt: string;
    allDay: boolean;
    category: string;
    location?: string;
    note?: string;
    attendeeName?: string;
    rrule?: string;
  }) => request('/events', { method: 'POST', body: JSON.stringify(body) }),
  dashboard: () => request<DashboardData>('/dashboard'),
  loans: () => request<{ items: Loan[] }>('/loans'),
  addLoan: (body: { borrowerName: string; principalAmountBaht: number; dueAt?: string; note?: string }) =>
    request('/loans', { method: 'POST', body: JSON.stringify(body) }),
  repayLoan: (id: string, amountBaht: number) =>
    request(`/loans/${id}/repay`, { method: 'POST', body: JSON.stringify({ amountBaht }) }),
  assets: () => request<{ items: Asset[] }>('/assets'),
  addAsset: (body: {
    name: string;
    category: string;
    valueBaht: number;
    acquiredAt?: string;
    note?: string;
  }) => request('/assets', { method: 'POST', body: JSON.stringify(body) }),
  setAssetValue: (id: string, valueBaht: number) =>
    request(`/assets/${id}/value`, { method: 'POST', body: JSON.stringify({ valueBaht }) }),
  deposits: () => request<{ items: Deposit[] }>('/deposits'),
  addDeposit: (body: { name: string; balanceBaht: number; note?: string }) =>
    request('/deposits', { method: 'POST', body: JSON.stringify(body) }),
  adjustDeposit: (id: string, amountBaht: number) =>
    request(`/deposits/${id}/adjust`, { method: 'POST', body: JSON.stringify({ amountBaht }) }),

  // ---- editing and deleting. `null` on an optional field clears it. ----

  updateEvent: (
    id: string,
    body: {
      title?: string;
      startAt?: string;
      allDay?: boolean;
      category?: string;
      location?: string | null;
      note?: string | null;
      attendeeName?: string | null;
      rrule?: string | null;
    },
  ) => request(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteEvent: (id: string) => request(`/events/${id}`, { method: 'DELETE' }),
  /** One date of a repeating appointment stops happening. */
  skipOccurrence: (id: string, occurrence: string) =>
    request(`/events/${id}/skip`, { method: 'POST', body: JSON.stringify({ occurrence }) }),
  /** One date of a repeating appointment becomes its own, editable one-off. */
  detachOccurrence: (
    id: string,
    occurrence: string,
    body: {
      title?: string;
      startAt?: string;
      allDay?: boolean;
      category?: string;
      location?: string | null;
      note?: string | null;
      attendeeName?: string | null;
    },
  ) =>
    request<{ id: string }>(`/events/${id}/detach`, {
      method: 'POST',
      body: JSON.stringify({ occurrence, ...body }),
    }),

  transactions: (month?: string) =>
    request<{ items: TransactionItem[] }>(`/transactions${month ? `?month=${month}` : ''}`),
  updateTransaction: (
    id: string,
    body: {
      amountBaht?: number;
      direction?: 'IN' | 'OUT';
      categoryName?: string | null;
      note?: string | null;
      occurredAt?: string;
    },
  ) => request(`/transactions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTransaction: (id: string) => request(`/transactions/${id}`, { method: 'DELETE' }),

  bills: () => request<{ items: BillItem[] }>('/bills'),
  addBill: (body: { name: string; amountBaht?: number; dueDay: number }) =>
    request('/bills', { method: 'POST', body: JSON.stringify(body) }),
  updateBill: (
    id: string,
    body: { name?: string; amountBaht?: number | null; dueDay?: number; active?: boolean },
  ) => request(`/bills/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteBill: (id: string) => request(`/bills/${id}`, { method: 'DELETE' }),

  documents: () => request<{ items: DocumentItem[] }>('/documents'),
  addDocument: (body: { name: string; type: string; expiresAt: string }) =>
    request('/documents', { method: 'POST', body: JSON.stringify(body) }),
  updateDocument: (id: string, body: { name?: string; type?: string; expiresAt?: string }) =>
    request(`/documents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDocument: (id: string) => request(`/documents/${id}`, { method: 'DELETE' }),

  medications: () => request<{ items: MedicationItem[] }>('/medications'),
  addMedication: (body: { name: string; dosage?: string; times: string[] }) =>
    request('/medications', { method: 'POST', body: JSON.stringify(body) }),
  updateMedication: (
    id: string,
    body: { name?: string; dosage?: string | null; times?: string[]; active?: boolean },
  ) => request(`/medications/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteMedication: (id: string) => request(`/medications/${id}`, { method: 'DELETE' }),

  chores: () => request<{ items: ChoreItem[] }>('/chores'),
  addChore: (body: { name: string; cadence: string; rotationNames?: string[] }) =>
    request('/chores', { method: 'POST', body: JSON.stringify(body) }),
  updateChore: (
    id: string,
    body: { name?: string; cadence?: string; active?: boolean; rotationNames?: string[] },
  ) =>
    request(`/chores/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteChore: (id: string) => request(`/chores/${id}`, { method: 'DELETE' }),

  updateLoan: (
    id: string,
    body: {
      borrowerName?: string;
      principalAmountBaht?: number;
      repaidAmountBaht?: number;
      dueAt?: string | null;
      note?: string | null;
      active?: boolean;
    },
  ) => request(`/loans/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLoan: (id: string) => request(`/loans/${id}`, { method: 'DELETE' }),

  updateAsset: (
    id: string,
    body: {
      name?: string;
      category?: string;
      valueBaht?: number;
      acquiredAt?: string | null;
      note?: string | null;
    },
  ) => request(`/assets/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAsset: (id: string) => request(`/assets/${id}`, { method: 'DELETE' }),

  updateDeposit: (
    id: string,
    body: { name?: string; balanceBaht?: number; note?: string | null },
  ) => request(`/deposits/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDeposit: (id: string) => request(`/deposits/${id}`, { method: 'DELETE' }),

  deleteShoppingItem: (id: string) => request(`/shopping/${id}`, { method: 'DELETE' }),

  tasks: () => request<{ items: TaskItem[] }>('/tasks'),
  addTask: (body: { title: string; dueAt?: string; assigneeName?: string; note?: string }) =>
    request('/tasks', { method: 'POST', body: JSON.stringify(body) }),
  updateTask: (
    id: string,
    body: {
      title?: string;
      status?: 'TODO' | 'DOING' | 'DONE';
      assigneeName?: string | null;
      dueAt?: string | null;
      note?: string | null;
      sortOrder?: number;
    },
  ) => request(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: 'DELETE' }),
};
