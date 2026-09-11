import type { messagingApi } from '@line/bot-sdk';

/**
 * Shown only when someone @-mentions the bot with a message neither parser
 * could read. Staying silent is still the default for ordinary chatter that
 * doesn't mention the bot — this card exists for the one case where silence
 * reads as broken rather than polite: someone deliberately addressed the bot
 * and got nothing back.
 */
export function buildClarifyCard(): messagingApi.FlexMessage {
  const examples = [
    'พรุ่งนี้บ่าย 3 พาแม่ไปหาหมอ',
    'ค่าข้าว 250',
    'ซื้อของ: นม, ไข่',
    'ตั้งงบ ค่าไฟ 1000 บาท',
  ];

  return {
    type: 'flex',
    altText: 'ไม่แน่ใจว่าหมายถึงอะไร ลองพิมพ์ให้ชัดเจนขึ้นนะครับ',
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
            text: 'ไม่แน่ใจว่าหมายถึงอะไร',
            weight: 'bold',
            size: 'md',
            color: '#06C755',
          },
          {
            type: 'text',
            text: 'ลองพิมพ์ให้ใกล้เคียงแบบนี้ดูนะครับ',
            size: 'sm',
            color: '#8C8C8C',
            wrap: true,
          },
          { type: 'separator' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: examples.map((e) => ({
              type: 'text' as const,
              text: `• ${e}`,
              size: 'sm' as const,
              color: '#111111',
              wrap: true,
            })),
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: { type: 'message', label: 'ดูวิธีใช้ทั้งหมด', text: 'ช่วย' },
          },
        ],
      },
    },
  };
}
