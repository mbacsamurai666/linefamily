import { randomUUID } from 'node:crypto';
import type { Draft } from '../intent/types.js';

/**
 * Pending drafts, held between the confirm card and the tap that accepts it.
 *
 * In memory on purpose: a draft is worthless after a restart anyway (the user
 * simply retypes), and persisting half-formed LLM output is exactly what the
 * confirm step exists to avoid. TTL keeps abandoned cards from accumulating.
 */

export interface PendingDraft {
  draft: Draft;
  familyId: string;
  memberId: string | null;
  createdAt: number;
  source: 'rule' | 'llm';
  confidence: number;
}

const TTL_MS = 30 * 60 * 1000;

export class DraftStore {
  private readonly items = new Map<string, PendingDraft>();

  put(entry: Omit<PendingDraft, 'createdAt'>): string {
    this.sweep();
    const token = randomUUID();
    this.items.set(token, { ...entry, createdAt: Date.now() });
    return token;
  }

  take(token: string): PendingDraft | null {
    this.sweep();
    const found = this.items.get(token);
    // Single use: a double tap on ยืนยัน must not create two rows.
    if (found) this.items.delete(token);
    return found ?? null;
  }

  peek(token: string): PendingDraft | null {
    this.sweep();
    return this.items.get(token) ?? null;
  }

  get size(): number {
    this.sweep();
    return this.items.size;
  }

  private sweep(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [token, item] of this.items) {
      if (item.createdAt < cutoff) this.items.delete(token);
    }
  }
}
