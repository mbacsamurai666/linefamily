import liff from '@line/liff';

/**
 * Thin wrapper around the LIFF SDK. Everything the API needs from LIFF is the
 * ID token — the backend re-derives who the user is from that, so this file
 * has no state of its own beyond "has init run yet".
 */

let ready: Promise<void> | null = null;

declare global {
  interface Window {
    /** Served at runtime by the bot itself — see /liff/config.js in line/app.ts. */
    __LIFF_ID__?: string;
  }
}

/**
 * The id is read from the server at runtime first, and only falls back to the
 * one Vite baked in at build time.
 *
 * Vite inlines import.meta.env at build time, so a deployed bundle built
 * before the LIFF id existed — or built against a different channel — fails
 * with no clue why. Serving it alongside the page means the bot and the page
 * can never disagree about which LIFF app this is.
 */
function resolveLiffId(): string | undefined {
  return window.__LIFF_ID__ || (import.meta.env.VITE_LIFF_ID as string | undefined);
}

export function initLiff(): Promise<void> {
  const liffId = resolveLiffId();
  if (!liffId) {
    return Promise.reject(new Error('ไม่พบ LIFF ID — ตั้ง LIFF_ID ที่เซิร์ฟเวอร์ หรือ VITE_LIFF_ID ตอน build'));
  }
  ready ??= liff.init({ liffId });
  return ready;
}

export async function getIdToken(): Promise<string> {
  await initLiff();
  if (!liff.isLoggedIn()) {
    liff.login();
    // login() redirects away; nothing after this line runs in this tab.
    return new Promise(() => {});
  }
  const token = liff.getIDToken();
  if (!token) throw new Error('LIFF returned no ID token');
  return token;
}
