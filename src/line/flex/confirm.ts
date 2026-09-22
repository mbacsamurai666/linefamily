import type { messagingApi } from '@line/bot-sdk';
import type { DateTime } from 'luxon';
import { ASSET_CATEGORY_LABEL } from '../../intent/assetTypes.js';
import { CATEGORY_LABEL } from '../../intent/categories.js';
import { DOCUMENT_TYPE_LABEL } from '../../intent/documentTypes.js';
import type { Draft } from '../../intent/types.js';
import { formatSatang } from '../../thai/number.js';
import { recurrenceLabel } from '../../thai/recurrence.js';
import { formatThaiDate, formatThaiDateTime, formatThaiSpan } from '../format.js';

/**
 * The confirm card is the safety mechanism the whole intent pipeline rests on:
 * nothing a parser produces — least of all the LLM — is written until someone
 * taps ยืนยัน. It is sent with the reply token, so it costs no push quota.
 */

const COLORS = {
  accent: '#06C755',
  muted: '#8C8C8C',
  text: '#111111',
} as const;

function row(label: string, value: string): messagingApi.FlexBox {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, color: COLORS.muted, size: 'sm', flex: 2 },
      { type: 'text', text: value, color: COLORS.text, size: 'sm', flex: 5, wrap: true },
    ],
  };
}

/** "19 ก.ย." / "14–22 ก.ย." / "28 ก.ย.–3 ต.ค." — narrow enough for the label column. */
function shortSpan(start: DateTime, end: DateTime | undefined): string {
  const dayMonth = (d: DateTime) => formatThaiDate(d).replace(/^\S+ /, '').replace(/ \d{2}$/, '');
  if (!end || end.hasSame(start, 'day')) return dayMonth(start);
  if (end.hasSame(start, 'month')) return `${start.day}–${dayMonth(end)}`;
  return `${dayMonth(start)}–${dayMonth(end)}`;
}

interface CardContent {
  heading: string;
  rows: messagingApi.FlexBox[];
  altText: string;
}

function describe(draft: Draft, zone: string): CardContent {
  switch (draft.kind) {
    case 'events': {
      const kept = draft.skippedPast > 0 ? ` (ข้าม ${draft.skippedPast} รายการที่ผ่านไปแล้ว)` : '';
      return {
        heading: `ลงปฏิทิน ${draft.events.length} นัด`,
        altText: `ลงปฏิทิน ${draft.events.length} นัดจากรูป`,
        rows: [
          ...draft.events.map((ev) =>
            row(
              shortSpan(ev.startAt.setZone(zone), ev.endAt?.setZone(zone)),
              ev.allDay ? ev.title : `${ev.title} ${ev.startAt.setZone(zone).toFormat('HH:mm')}`,
            ),
          ),
          ...(kept
            ? [
                {
                  type: 'box' as const,
                  layout: 'vertical' as const,
                  contents: [{ type: 'text' as const, text: kept.trim(), size: 'xs' as const, color: COLORS.muted, wrap: true }],
                },
              ]
            : []),
        ],
      };
    }
    case 'event': {
      const when = formatThaiSpan(draft.startAt.setZone(zone), draft.endAt?.setZone(zone), draft.allDay);
      return {
        heading: 'นัดหมายใหม่',
        altText: `นัดหมาย: ${draft.title} ${when}`,
        rows: [
          row('เรื่อง', draft.title),
          row('เมื่อ', when),
          ...(draft.rrule ? [row('ทำซ้ำ', recurrenceLabel(draft.rrule))] : []),
          row('ประเภท', CATEGORY_LABEL[draft.category]),
          ...(draft.attendeeName ? [row('สำหรับ', draft.attendeeName)] : []),
          ...(draft.location ? [row('สถานที่', draft.location)] : []),
          ...(draft.note ? [row('หมายเหตุ', draft.note)] : []),
        ],
      };
    }
    case 'expense': {
      const sign = draft.direction === 'IN' ? 'รับเข้า' : 'จ่ายออก';
      return {
        heading: 'บันทึกเงิน',
        altText: `${sign} ${formatSatang(draft.amount)} บาท`,
        rows: [
          row('รายการ', draft.note && draft.note.length > 0 ? draft.note : '-'),
          row('จำนวน', `${formatSatang(draft.amount)} บาท`),
          row('ทิศทาง', sign),
          ...(draft.categoryName ? [row('หมวด', draft.categoryName)] : []),
          row('วันที่', formatThaiDateTime(draft.occurredAt.setZone(zone), true)),
          ...(draft.splitWithNames && draft.splitWithNames.length > 0
            ? [row('หารกับ', draft.splitWithNames.join(', '))]
            : []),
        ],
      };
    }
    case 'bill':
      return {
        heading: 'บิลประจำเดือน',
        altText: `บิล: ${draft.name}`,
        rows: [
          row('ชื่อบิล', draft.name),
          ...(draft.amount !== undefined
            ? [row('จำนวน', `${formatSatang(draft.amount)} บาท`)]
            : []),
          row('ครบกำหนด', `ทุกวันที่ ${draft.dueDay}`),
        ],
      };
    case 'document':
      return {
        heading: 'เอกสารใกล้หมดอายุ',
        altText: `เอกสาร: ${draft.name}`,
        rows: [
          row('ชื่อเอกสาร', draft.name),
          row('ประเภท', DOCUMENT_TYPE_LABEL[draft.type]),
          row('หมดอายุ', formatThaiDateTime(draft.expiresAt.setZone(zone), true)),
        ],
      };
    case 'shopping':
      return {
        heading: 'เพิ่มรายการซื้อของ',
        altText: `ซื้อของ: ${draft.items.map((i) => i.name).join(', ')}`,
        rows: [
          row(
            'รายการ',
            draft.items.map((i) => `• ${i.name}${i.qty ? ` (${i.qty})` : ''}`).join('\n'),
          ),
        ],
      };
    case 'med':
      return {
        heading: 'ยาประจำตัว',
        altText: `ยา: ${draft.name}`,
        rows: [
          row('ชื่อยา', draft.name),
          ...(draft.dosage ? [row('ขนาด', draft.dosage)] : []),
          row('เวลา', draft.times.join(', ')),
        ],
      };
    case 'chore': {
      const cadenceLabel = { DAILY: 'ทุกวัน', WEEKLY: 'ทุกสัปดาห์', MONTHLY: 'ทุกเดือน' }[
        draft.cadence
      ];
      return {
        heading: 'งานบ้านประจำ',
        altText: `เวร: ${draft.name}`,
        rows: [
          row('งาน', draft.name),
          row('ความถี่', cadenceLabel),
          ...(draft.rotationNames.length > 0
            ? [row('หมุนเวรกับ', draft.rotationNames.join(', '))]
            : []),
        ],
      };
    }
    case 'loan':
      return {
        heading: 'เงินให้ยืม',
        altText: `ให้ยืม: ${draft.borrowerName} ${formatSatang(draft.principalSatang)} บาท`,
        rows: [
          row('ให้ยืมกับ', draft.borrowerName),
          row('จำนวน', `${formatSatang(draft.principalSatang)} บาท`),
          ...(draft.dueAt
            ? [row('ครบกำหนดคืน', formatThaiDateTime(draft.dueAt.setZone(zone), true))]
            : []),
          ...(draft.note ? [row('หมายเหตุ', draft.note)] : []),
        ],
      };
    case 'asset':
      return {
        heading: 'ทรัพย์สิน',
        altText: `ทรัพย์สิน: ${draft.name}`,
        rows: [
          row('ชื่อ', draft.name),
          row('ประเภท', ASSET_CATEGORY_LABEL[draft.category]),
          row('มูลค่า', `${formatSatang(draft.valueSatang)} บาท`),
          ...(draft.note ? [row('หมายเหตุ', draft.note)] : []),
        ],
      };
    case 'task':
      return {
        heading: 'งานใหม่บนบอร์ด',
        altText: `งาน: ${draft.title}`,
        rows: [
          row('งาน', draft.title),
          ...(draft.assigneeName ? [row('ให้', draft.assigneeName)] : []),
          ...(draft.dueAt
            ? [row('ครบกำหนด', formatThaiDateTime(draft.dueAt.setZone(zone), true))]
            : []),
          ...(draft.note ? [row('หมายเหตุ', draft.note)] : []),
        ],
      };
    case 'deposit':
      return {
        heading: 'บัญชีเงินฝาก',
        altText: `เงินฝาก: ${draft.name}`,
        rows: [
          row('ชื่อบัญชี', draft.name),
          row('ยอดคงเหลือ', `${formatSatang(draft.balanceSatang)} บาท`),
          ...(draft.note ? [row('หมายเหตุ', draft.note)] : []),
        ],
      };
  }
}

export interface ConfirmCardOptions {
  draft: Draft;
  /** Opaque token the postback carries back so the draft can be recovered. */
  draftToken: string;
  timezone: string;
  /** Shown as a small hint so the family can tell a guess from a sure thing. */
  source: 'rule' | 'llm';
  confidence: number;
}

export function buildConfirmCard(opts: ConfirmCardOptions): messagingApi.FlexMessage {
  const { heading, rows, altText } = describe(opts.draft, opts.timezone);

  // A low-confidence read is worth flagging: it tells the reader to check the
  // details rather than tap through on autopilot.
  const uncertain = opts.confidence < 0.8;

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: heading,
            weight: 'bold',
            size: 'md',
            color: COLORS.accent,
          },
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
          ...(uncertain
            ? [
                {
                  type: 'text' as const,
                  text: 'ไม่แน่ใจ ลองตรวจดูก่อนกดยืนยันนะ',
                  size: 'xs' as const,
                  color: COLORS.muted,
                  wrap: true,
                },
              ]
            : []),
        ],
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: COLORS.accent,
            height: 'sm',
            action: {
              type: 'postback',
              label: 'ยืนยัน',
              data: `action=confirm&token=${encodeURIComponent(opts.draftToken)}`,
              displayText: 'ยืนยัน',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'แก้ไข',
              data: `action=edit&token=${encodeURIComponent(opts.draftToken)}`,
            },
          },
        ],
      },
    },
  };
}
