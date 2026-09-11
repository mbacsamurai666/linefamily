import { randomBytes } from 'node:crypto';

/**
 * Short-lived download links for the family's backup file.
 *
 * The app cannot simply save a file: LINE's in-app browser is not a place
 * where downloads reliably land anywhere the user can find. So the app asks
 * for a link and opens it in the real browser, which downloads it properly —
 * and a link in a URL bar cannot carry the LIFF id token, hence this.
 *
 * In memory on purpose. A restart invalidates outstanding links, which for a
 * ten-minute credential is the right side to fail on.
 */

const TTL_MS = 10 * 60_000;

export interface ExportLink {
  familyId: string;
  expiresAt: number;
}

export class ExportLinkStore {
  private readonly links = new Map<string, ExportLink>();

  /** Returns the token to put in the URL. */
  issue(familyId: string, now = Date.now()): string {
    this.sweep(now);
    const token = randomBytes(32).toString('base64url');
    this.links.set(token, { familyId, expiresAt: now + TTL_MS });
    return token;
  }

  /** The family this token may download, or null if it is unknown or expired. */
  resolve(token: string, now = Date.now()): string | null {
    this.sweep(now);
    return this.links.get(token)?.familyId ?? null;
  }

  get size(): number {
    return this.links.size;
  }

  private sweep(now: number): void {
    for (const [token, link] of this.links) {
      if (link.expiresAt <= now) this.links.delete(token);
    }
  }
}

export const EXPORT_LINK_TTL_MINUTES = TTL_MS / 60_000;
