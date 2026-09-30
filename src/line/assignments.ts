import { randomUUID } from 'node:crypto';

/**
 * Appointments just saved from the chat, waiting to be told whose they are.
 *
 * A school notice or "สอบว่ายน้ำ พรุ่งนี้" rarely says which child it is for,
 * and the confirm card is no place for a form. So once it is saved the bot
 * asks with one button per child, and the tap arrives here as a postback
 * carrying only a token — LINE postback data is too short for a list of ids.
 *
 * In memory on purpose, like the drafts: a question nobody answers within the
 * half hour, or across a restart, is simply not asked any more.
 */

const TTL_MS = 30 * 60_000;

interface Pending {
  familyId: string;
  eventIds: string[];
  expiresAt: number;
}

export class AssignmentStore {
  private readonly items = new Map<string, Pending>();

  put(familyId: string, eventIds: string[], now = Date.now()): string {
    this.sweep(now);
    const token = randomUUID();
    this.items.set(token, { familyId, eventIds, expiresAt: now + TTL_MS });
    return token;
  }

  /** Single use: a second tap on another name should not also apply. */
  take(token: string, now = Date.now()): Pending | null {
    this.sweep(now);
    const found = this.items.get(token) ?? null;
    if (found) this.items.delete(token);
    return found;
  }

  sweep(now = Date.now()): void {
    for (const [token, item] of this.items) if (item.expiresAt <= now) this.items.delete(token);
  }
}
