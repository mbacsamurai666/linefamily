import { describe, expect, it } from 'vitest';
import { ExportLinkStore } from '../src/api/exportLinks.js';

describe('ExportLinkStore', () => {
  it('hands back the family a token was issued for', () => {
    const store = new ExportLinkStore();
    const token = store.issue('fam_1');
    expect(store.resolve(token)).toBe('fam_1');
  });

  it('knows nothing about a token it never issued', () => {
    expect(new ExportLinkStore().resolve('made-up')).toBeNull();
  });

  it('stops working after ten minutes', () => {
    const store = new ExportLinkStore();
    const now = Date.UTC(2026, 8, 12, 10, 0);
    const token = store.issue('fam_1', now);

    expect(store.resolve(token, now + 9 * 60_000)).toBe('fam_1');
    expect(store.resolve(token, now + 11 * 60_000)).toBeNull();
  });

  it('does not pile up expired links in memory', () => {
    const store = new ExportLinkStore();
    const now = Date.UTC(2026, 8, 12, 10, 0);
    for (let i = 0; i < 5; i++) store.issue('fam_1', now);
    expect(store.size).toBe(5);

    store.issue('fam_1', now + 11 * 60_000);
    expect(store.size).toBe(1);
  });

  it('issues a token long enough not to be guessed', () => {
    const token = new ExportLinkStore().issue('fam_1');
    expect(token.length).toBeGreaterThanOrEqual(40);
  });
});
