/**
 * "Send me a photo of it" — a short-lived note of what the next picture from
 * this person is for.
 *
 * LINE image messages carry no caption, so the only way to tell a photo of a
 * driving licence from a photo of dinner is the conversation around it. After
 * a document is saved the bot offers to keep a picture of it; whatever that
 * person sends next, within the window, is filed against that document.
 *
 * In memory on purpose, like DraftStore: losing these on restart costs the
 * family nothing more than sending the photo again.
 */

export interface PhotoTarget {
  documentId: string;
  documentName: string;
  createdAt: Date;
}

const WINDOW_MINUTES = 15;

export class PhotoTargetStore {
  private readonly targets = new Map<string, PhotoTarget>();

  /** Keyed by member — two people can be asked for a photo at once. */
  expect(memberId: string, documentId: string, documentName: string): void {
    this.targets.set(memberId, { documentId, documentName, createdAt: new Date() });
  }

  /** Returns and consumes the pending target, if it has not gone stale. */
  take(memberId: string): PhotoTarget | null {
    const found = this.targets.get(memberId);
    if (!found) return null;

    this.targets.delete(memberId);
    const ageMinutes = (Date.now() - found.createdAt.getTime()) / 60_000;
    return ageMinutes <= WINDOW_MINUTES ? found : null;
  }

  get size(): number {
    return this.targets.size;
  }

  /** Drops anything past the window; called on the same sweep as drafts. */
  sweep(): void {
    const cutoff = Date.now() - WINDOW_MINUTES * 60_000;
    for (const [memberId, target] of this.targets) {
      if (target.createdAt.getTime() < cutoff) this.targets.delete(memberId);
    }
  }
}
