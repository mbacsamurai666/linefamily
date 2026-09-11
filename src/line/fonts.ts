import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';

/**
 * The faces every picture this bot draws is set in — the same Prompt and
 * Sarabun the LIFF app uses, shipped in assets/fonts rather than looked for on
 * the machine.
 *
 * Hunting for a system Thai font is how the rich menu first came out blank,
 * and it is what failed CI the first time it ran: @napi-rs/canvas bundles no
 * fonts and silently draws nothing for a family it does not have, and neither
 * a GitHub runner nor the production container has a Thai font installed.
 */

export const FONTS = {
  display: 'FamilyDisplay',
  body: 'FamilyBody',
  bodyBold: 'FamilyBodyBold',
} as const;

const FILES: Array<[string, string]> = [
  ['Prompt-SemiBold.ttf', FONTS.display],
  ['Sarabun-Regular.ttf', FONTS.body],
  ['Sarabun-SemiBold.ttf', FONTS.bodyBold],
];

let registered = false;

export function registerAppFonts(): void {
  if (registered) return;

  for (const [file, family] of FILES) {
    const path = join(process.cwd(), 'assets', 'fonts', file);
    if (!existsSync(path)) {
      throw new Error(
        `Missing ${path}. The drawing code needs the fonts in assets/fonts — ` +
          'check they were copied into the image (Dockerfile) and not ignored.',
      );
    }
    GlobalFonts.registerFromPath(path, family);
  }
  registered = true;
}
