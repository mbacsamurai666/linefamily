import { messagingApi } from '@line/bot-sdk';
import { loadConfig } from '../config/index.js';
import { cellBounds, renderRichMenuImage, RICH_MENU_GRID, RICH_MENU_SIZE } from './richmenuImage.js';
import type { RichMenuCell } from './richmenuImage.js';

/**
 * `npm run richmenu:install` — creates the rich menu, uploads its image, and
 * sets it as the default for every user. Safe to re-run: any rich menus this
 * bot created previously are deleted first, so running it again after
 * changing a label does not leave orphaned menus behind.
 */

interface Cell extends RichMenuCell {
  action: messagingApi.Action;
}

function buildCells(liffUrl: string | undefined): Cell[] {
  const openApp: messagingApi.Action = liffUrl
    ? { type: 'uri', label: 'ปฏิทิน', uri: liffUrl }
    : { type: 'message', label: 'ช่วย', text: 'ช่วย' };

  // Six slots for more than six features, so the menu carries what is either
  // used daily or hard to remember how to type. "ช่วย" is neither — it is one
  // word, and the bot answers it — so the board takes that slot instead.
  return [
    {
      label: 'บอร์ดงาน',
      sublabel: 'งานที่ค้างอยู่',
      action: { type: 'message', label: 'บอร์ดงาน', text: 'บอร์ดงาน' },
    },
    {
      label: 'ฉุกเฉิน',
      sublabel: 'กรุ๊ปเลือด/แพ้ยา',
      action: { type: 'message', label: 'ข้อมูลฉุกเฉิน', text: 'ข้อมูลฉุกเฉิน' },
    },
    {
      label: 'กินยาแล้ว',
      sublabel: 'บันทึกโดสล่าสุด',
      action: { type: 'message', label: 'กินยาแล้ว', text: 'กินยาแล้ว' },
    },
    { label: 'ทำแล้ว', sublabel: 'เวรวันนี้', action: { type: 'message', label: 'ทำแล้ว', text: 'ทำแล้ว' } },
    {
      label: liffUrl ? 'ปฏิทิน' : 'ช่วย',
      ...(liffUrl ? { sublabel: 'เปิดแอปบ้านเรา' } : {}),
      action: openApp,
    },
    {
      label: 'ซื้อของ',
      sublabel: 'เพิ่มลิสต์',
      action: { type: 'message', label: 'ซื้อของ', text: 'ซื้อของ: ' },
    },
  ];
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: cfg.LINE_CHANNEL_ACCESS_TOKEN,
  });
  const blobClient = new messagingApi.MessagingApiBlobClient({
    channelAccessToken: cfg.LINE_CHANNEL_ACCESS_TOKEN,
  });

  const liffUrl = cfg.LIFF_ID ? `https://liff.line.me/${cfg.LIFF_ID}` : undefined;
  if (!liffUrl) {
    console.log('LIFF_ID is not set — the "เปิดแอป" button will fall back to help text.');
  }

  const cells = buildCells(liffUrl);

  const existing = await client.getRichMenuList();
  for (const menu of existing.richmenus) {
    console.log(`deleting existing rich menu ${menu.richMenuId} (${menu.name})`);
    await client.deleteRichMenu(menu.richMenuId);
  }

  const created = await client.createRichMenu({
    size: RICH_MENU_SIZE,
    selected: true,
    name: `family-bot-${new Date().toISOString().slice(0, 10)}`,
    chatBarText: 'เมนู',
    areas: cells.map((cell, i) => ({
      bounds: cellBounds(i % RICH_MENU_GRID.cols, Math.floor(i / RICH_MENU_GRID.cols)),
      action: cell.action,
    })),
  });
  console.log(`created rich menu ${created.richMenuId}`);

  const image = renderRichMenuImage(cells);
  await blobClient.setRichMenuImage(created.richMenuId, new Blob([image], { type: 'image/png' }));
  console.log('uploaded rich menu image');

  await client.setDefaultRichMenu(created.richMenuId);
  console.log('set as default rich menu for all users');
}

main().catch((err) => {
  console.error('rich menu install failed:', err);
  process.exit(1);
});
