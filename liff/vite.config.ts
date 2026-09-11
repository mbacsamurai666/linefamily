import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the same Hono server as the bot, under /liff/ — see server.ts.
// The LIFF endpoint URL configured in the LINE Developers Console must point
// at <PUBLIC_BASE_URL>/liff/.
export default defineConfig({
  base: '/liff/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
});
