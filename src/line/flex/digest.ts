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

export function buildDigest(
  jobs: ReminderJob[],
  slot: DateTime,
  liffUrl?: string,
): messagingApi.FlexMessage {
  const morning = slot.hour < 12;
  const heading = morning ? 'สรุปเช้านี้' : 'สรุปเย็นนี้';

  const grouped = new Map<JobKind, ReminderJob[]>();
  for (const job of jobs) {
    const bucket = grouped.get(job.kind);
    if (bucket) bucket.push(job);
    else grouped.set(job.kind, [job]);
  }

  const sections = SECTION_ORDER.filter((k) => grouped.has(k)).map((k) =>
    section(k, grouped.get(k) as ReminderJob[]),
  );

  return {
    type: 'flex',
    altText: `${heading} — มี ${jobs.length} รายการ`,
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
