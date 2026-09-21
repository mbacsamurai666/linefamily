import type { DateTime } from 'luxon';

/**
 * A Draft is what a parser produces. Nothing here is persisted until the user
 * taps confirm on the Flex card — see the plan: no LLM output ever reaches the
 * database directly.
 */
export type Draft =
  | EventDraft
  | ExpenseDraft
  | BillDraft
  | DocumentDraft
  | ShoppingDraft
  | MedDraft
  | ChoreDraft
  | LoanDraft
  | AssetDraft
  | DepositDraft
  | TaskDraft;

export interface EventDraft {
  kind: 'event';
  title: string;
  startAt: DateTime;
  /** Last day of a span such as "1-7 ต.ค." (inclusive); absent for one day. */
  endAt?: DateTime;
  allDay: boolean;
  category: 'MEDICAL' | 'SCHOOL' | 'GOVERNMENT' | 'SOCIAL' | 'WORK' | 'OTHER';
  location?: string;
  note?: string;
  /** Display name of who this event is about — "น้องพร สอบปลายภาค พรุ่งนี้". */
  attendeeName?: string;
  /** RFC 5545 RRULE body for a repeating appointment, e.g. "FREQ=WEEKLY;BYDAY=MO". */
  rrule?: string;
}

export interface ExpenseDraft {
  kind: 'expense';
  /** Satang. */
  amount: number;
  direction: 'IN' | 'OUT';
  categoryName?: string;
  note?: string;
  occurredAt: DateTime;
  /**
   * Display names to split the cost with, in addition to whoever paid.
   * "ค่าข้าว 300 หารกับ พี่เอ" -> the payer + พี่เอ split it evenly.
   */
  splitWithNames?: string[];
  /** LINE message id of the slip this was read from, when it came from a photo. */
  receiptFileId?: string;
}

export interface BillDraft {
  kind: 'bill';
  name: string;
  /** Satang. Omitted when the amount varies month to month. */
  amount?: number;
  dueDay: number;
}

export interface DocumentDraft {
  kind: 'document';
  name: string;
  type: 'ID_CARD' | 'PASSPORT' | 'DRIVER_LICENSE' | 'VEHICLE_TAX' | 'INSURANCE' | 'VISA' | 'OTHER';
  expiresAt: DateTime;
}

export interface ShoppingDraft {
  kind: 'shopping';
  items: Array<{ name: string; qty?: string }>;
}

export interface MedDraft {
  kind: 'med';
  name: string;
  dosage?: string;
  times: string[];
}

export interface ChoreDraft {
  kind: 'chore';
  name: string;
  cadence: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  /** Display names as typed; persist resolves these to member ids. */
  rotationNames: string[];
}

export interface LoanDraft {
  kind: 'loan';
  borrowerName: string;
  /** Satang. */
  principalSatang: number;
  dueAt?: DateTime;
  note?: string;
}

export interface AssetDraft {
  kind: 'asset';
  name: string;
  category: 'PROPERTY' | 'VEHICLE' | 'ELECTRONICS' | 'JEWELRY' | 'INVESTMENT' | 'OTHER';
  /** Satang. */
  valueSatang: number;
  acquiredAt?: DateTime;
  note?: string;
}

export interface DepositDraft {
  kind: 'deposit';
  name: string;
  /** Satang. */
  balanceSatang: number;
  note?: string;
}

export interface TaskDraft {
  kind: 'task';
  title: string;
  dueAt?: DateTime;
  /** Display name as typed; persist resolves it to a member. */
  assigneeName?: string;
  note?: string;
}

export type ParseResult =
  | { kind: 'unknown' }
  | {
      kind: Draft['kind'];
      /** 0..1. The chain escalates to the next parser below its threshold. */
      confidence: number;
      draft: Draft;
      /** Which parser produced this, for logging and for the confirm card. */
      source: 'rule' | 'llm';
    };

export interface FamilyContext {
  familyId: string;
  timezone: string;
  now: DateTime;
  /** Display names, so a parser can resolve "แม่" or "พี่" to a member. */
  memberNames: string[];
  /** Existing expense category names, to keep the LLM from inventing new ones. */
  categoryNames: string[];
}

export interface IntentParser {
  readonly name: string;
  parse(text: string, ctx: FamilyContext): Promise<ParseResult>;
}
