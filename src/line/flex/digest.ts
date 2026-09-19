import type { messagingApi } from '@line/bot-sdk';
import type { DateTime } from 'luxon';
import type { JobKind, ReminderJob } from '../../reminders/ports.js';
import { formatThaiDate } from '../format.js';

/**
 * The digest is the only routine push this bot sends. Everything the family
 * would otherwise have received as N separate notifications arrives here as
 * one message — which is what keeps ~360 monthly reminders inside a ~500
 * message budget with room to spare.
 */

export const SECTION_ORDER: JobKind[] = [
  'MEDICATION',
  'EVENT',
  'TASK',
  'BILL',
  'LOAN_DUE',
  'DOCUMENT',
  'CHORE',
  'BUDGET_ALERT',
  'MONTH_SUMMARY',
  'BIRTHDAY',
];

export const SECTION_LABEL: Record<JobKind, string> = {
  MEDICATION: 'ยา',
  EVENT: 'นัดหมาย',
  TASK: 'งานบนบอร์ด',
  BILL: 'บิลที่ต้องจ่าย',
  LOAN_DUE: 'เงินกู้ครบกำหนดคืน',
  DOCUMENT: 'เอกสารใกล้หมดอายุ',
  CHORE: 'งานบ้าน',
  BUDGET_ALERT: 'งบประมาณ',
  MONTH_SUMMARY: 'สรุปเดือน',
  BIRTHDAY: 'วันเกิด',
};

const COLORS = {
  accent: '#06C755',
  muted: '#8C8C8C',
  text: '#111111',
} as const;

function section(kind: JobKind, jobs: ReminderJob[]): messagingApi.FlexBox {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'xs',
    margin: 'md',
    contents: [
      {
        type: 'text',
        text: `${SECTION_LABEL[kind]} (${jobs.length})`,
        size: 'xs',
        weight: 'bold',
        color: COLORS.muted,
      },
      ...jobs.map(
        (j): messagingApi.FlexText => ({
          type: 'text',
          text: `• ${j.payload.text}`,
          size: 'sm',
          color: COLORS.text,
          wrap: true,
        }),
      ),
    ],
  };
}

/** An appointment coming up, already worded for the digest: "พ. 16 ก.ย. 15:00". */
export interface UpcomingLine {
  when: string;
  title: string;
  /** Calendar days from the digest's own day: 0 is today. */
  daysAway: number;
}

/** Most lines a quiet day lists — it is a glance, not the calendar. */
export const UPCOMING_MAX = 7;

/**
 * The week ahead in the same three groups as the app's หน้าหลัก, so the
 * message and the page it opens read alike. Empty groups are left out.
 */
export function groupUpcoming(upcoming: UpcomingLine[]): Array<{ label: string; items: UpcomingLine[] }> {
  const shown = upcoming.slice(0, UPCOMING_MAX);
  return [
    { label: 'วันนี้', items: shown.filter((u) => u.daysAway <= 0) },
    { label: 'ใน 3 วัน', items: shown.filter((u) => u.daysAway >= 1 && u.daysAway <= 3) },
    { label: 'ใน 7 วัน', items: shown.filter((u) => u.daysAway >= 4) },
  ].filter((g) => g.items.length > 0);
}

/** What the top line says: a quiet day with an all-day appointment is not "nothing". */
export function quietIntro(upcoming: UpcomingLine[], morning: boolean): string {
  const today = upcoming.filter((u) => u.daysAway <= 0).length;
  if (morning && today > 0) return `วันนี้มีนัด ${today} รายการ`;
  return `${morning ? 'วันนี้' : 'คืนนี้'}ไม่มีอะไรต้องเตือน`;
}

/**
 * A day with nothing due still gets its morning message — the family asked
 * for one every day — so it carries the week ahead instead of an empty card.
 */
function quietDay(upcoming: UpcomingLine[], morning: boolean): messagingApi.FlexComponent[] {
  const intro: messagingApi.FlexText = {
    type: 'text',
    text: `${quietIntro(upcoming, morning)}ครับ ${morning ? '☀️' : '🌙'}`,
    size: 'sm',
    color: COLORS.text,
    margin: 'md',
    wrap: true,
  };
  if (upcoming.length === 0) {
    return [
      intro,
      { type: 'text', text: 'สัปดาห์นี้ยังว่างทั้งสัปดาห์', size: 'xs', color: COLORS.muted, margin: 'sm' },
    ];
  }

  const groups = groupUpcoming(upcoming).map(
    (g): messagingApi.FlexBox => ({
      type: 'box',
      layout: 'vertical',
      spacing: 'xs',
      margin: 'md',
      contents: [
        { type: 'text', text: `${g.label} (${g.items.length})`, size: 'xs', weight: 'bold', color: COLORS.muted },
        ...g.items.map(
          (u): messagingApi.FlexText => ({
            type: 'text',
            text: `• ${u.when}  ${u.title}`,
            size: 'sm',
            color: COLORS.text,
            wrap: true,
          }),
        ),
      ],
    }),
  );
  if (upcoming.length > UPCOMING_MAX) {
    groups.push({
      type: 'box',
      layout: 'vertical',
      margin: 'sm',
      contents: [
        {
          type: 'text',
          text: `…และอีก ${upcoming.length - UPCOMING_MAX} นัด — เปิดแอปดูได้`,
          size: 'xs',
          color: COLORS.muted,
        },
      ],
    });
  }
  return [intro, ...groups];
}

export function buildDigest(
  jobs: ReminderJob[],
  slot: DateTime,
  liffUrl?: string,
  /** The week ahead, for a day with nothing due. */
  upcoming: UpcomingLine[] = [],
): messagingApi.FlexMessage {
  const morning = slot.hour < 12;
  const heading = morning ? 'สรุปเช้านี้' : 'สรุปเย็นนี้';
  const quiet = jobs.length === 0;

  const grouped = new Map<JobKind, ReminderJob[]>();
  for (const job of jobs) {
    const bucket = grouped.get(job.kind);
    if (bucket) bucket.push(job);
    else grouped.set(job.kind, [job]);
  }

  const sections = quiet
    ? quietDay(upcoming, morning)
    : SECTION_ORDER.filter((k) => grouped.has(k)).map((k) =>
        section(k, grouped.get(k) as ReminderJob[]),
      );

  return {
    type: 'flex',
    altText: quiet
      ? `${heading} — ${quietIntro(upcoming, morning)}`
      : `${heading} — มี ${jobs.length} รายการ`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'box',
            layout: 'baseline',
            contents: [
              {
                type: 'text',
                text: heading,
                weight: 'bold',
                size: 'md',
                color: COLORS.accent,
                flex: 3,
              },
              {
                type: 'text',
                text: formatThaiDate(slot),
                size: 'xs',
                color: COLORS.muted,
                align: 'end',
                flex: 4,
              },
            ],
          },
          { type: 'separator', margin: 'md' },
          ...sections,
        ],
      },
      ...(liffUrl
        ? {
            footer: {
              type: 'box' as const,
              layout: 'vertical' as const,
              contents: [
                {
                  type: 'button' as const,
                  style: 'link' as const,
                  height: 'sm' as const,
                  action: {
                    type: 'uri' as const,
                    label: 'เปิดปฏิทินทั้งหมด',
                    uri: liffUrl,
                  },
                },
              ],
            },
          }
        : {}),
    },
  };
}
