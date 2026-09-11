import liff from '@line/liff';

/**
 * Thin wrapper around the LIFF SDK. Everything the API needs from LIFF is the
 * ID token — the backend re-derives who the user is from that, so this file
 * has no state of its own beyond "has init run yet".
 */

let ready: Promise<void> | null = null;

export function initLiff(): Promise<void> {
  const liffId = import.meta.env.VITE_LIFF_ID as string | undefined;
  if (!liffId) {
    return Promise.reject(new Error('VITE_LIFF_ID is not set — see .env.example'));
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
