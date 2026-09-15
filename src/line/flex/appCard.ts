import type { messagingApi } from '@line/bot-sdk';

/**
 * The way into the app, as a card with one big button.
 *
 * A LIFF link posted once into a family group is a link nobody can find a week
 * later — and the rich menu that carries "เปิดแอป" is not something a relative
 * who just joined knows to look for. So the bot hands this card to whoever
 * needs it: when they join, when they ask for help, and when they ask for the
 * app by name. Every one of those is a reply, which costs no push quota.
 */

const PINK = '#d6488b';
const TEXT = '#4a3640';
const MUTED = '#a08c97';

export function buildAppCard(opts: {
  liffUrl: string;
  /** "ยินดีต้อนรับ คุณพ่อ" for someone joining; a plain heading otherwise. */
  heading: string;
  lines: string[];
}): messagingApi.FlexMessage {
  return {
    type: 'flex',
    altText: `${opts.heading} — เปิดปฏิทินบ้านเรา: ${opts.liffUrl}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: opts.heading, weight: 'bold', size: 'md', color: PINK, wrap: true },
          ...opts.lines.map(
            (line): messagingApi.FlexText => ({
              type: 'text',
              text: line,
              size: 'sm',
              color: TEXT,
              wrap: true,
            }),
          ),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: PINK,
            action: { type: 'uri', label: '📅 เปิดปฏิทินบ้านเรา', uri: opts.liffUrl },
          },
          {
            type: 'text',
            text: 'พิมพ์ "แอป" ในกลุ่มเมื่อไหร่ก็ได้ ถ้าหาปุ่มนี้ไม่เจอ',
            size: 'xxs',
            color: MUTED,
            align: 'center',
            wrap: true,
          },
        ],
      },
    },
  };
}

/** "แอป", "ขอลิงก์แอปหน่อย", "เปิดแอป", "link app" — asking for the way in. */
export const ASK_FOR_APP =
  /^(?:ขอ)?\s*(?:ลิงก์|ลิงค์|ลิ้งก์|ลิ้ง|ลิงก|link)?\s*(?:เปิด)?\s*(?:แอป|แอพ|app|liff)\s*(?:หน่อย|ด้วย|ครับ|ค่ะ|คะ|จ้า)?$/i;
