import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Imported by name because this script runs through tsx's classic JSX
// transform, not Vite's automatic one.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mascot, type MascotMood, type MascotWho } from '../src/Mascot.js';

/**
 * `npm run mascots:export` — writes the mascots out as standalone SVG files
 * for the server to draw into the digest image (src/line/digestImage.ts).
 *
 * The characters are drawn once, in Mascot.tsx, and the app renders them
 * directly. Redrawing them a second time in server code would mean two
 * versions of the same two children, drifting apart at the first change; this
 * exports the same component instead. Re-run it after editing Mascot.tsx and
 * commit what changes.
 */

const OUT_DIR = join(import.meta.dirname, '..', '..', 'assets', 'mascots');
const WHO: MascotWho[] = ['boy', 'girl'];
const MOODS: MascotMood[] = ['happy', 'wave', 'cheer', 'sleepy'];

mkdirSync(OUT_DIR, { recursive: true });

for (const who of WHO) {
  for (const mood of MOODS) {
    // A standalone file needs the namespace a React-rendered inline SVG omits.
    const svg = renderToStaticMarkup(<Mascot who={who} mood={mood} size={400} />).replace(
      '<svg ',
      '<svg xmlns="http://www.w3.org/2000/svg" ',
    );
    const file = join(OUT_DIR, `${who}-${mood}.svg`);
    writeFileSync(file, `${svg}\n`, 'utf8');
    console.log(`wrote ${file} (${svg.length} bytes)`);
  }
}
