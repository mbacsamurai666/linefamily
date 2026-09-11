import { describe, expect, it } from 'vitest';
import { settleUp, type MemberBalance } from '../src/modules/debts.js';

function bal(displayName: string, balanceSatang: number): MemberBalance {
  return { memberId: displayName, displayName, balanceSatang };
}

describe('settleUp', () => {
  it('pairs one debtor with one creditor', () => {
    expect(settleUp([bal('แม่', 5000), bal('พี่เอ', -5000)])).toEqual([
      { from: 'พี่เอ', to: 'แม่', amountSatang: 5000 },
    ]);
  });

  it('splits one debt across two creditors without routing through a third person', () => {
    const transfers = settleUp([bal('แม่', 30000), bal('พ่อ', 10000), bal('พี่เอ', -40000)]);
    expect(transfers).toEqual([
      { from: 'พี่เอ', to: 'แม่', amountSatang: 30000 },
      { from: 'พี่เอ', to: 'พ่อ', amountSatang: 10000 },
    ]);
  });

  it('settles everyone in fewer transfers than there are people', () => {
    const balances = [bal('ก', 7000), bal('ข', 3000), bal('ค', -2000), bal('ง', -8000)];
    const transfers = settleUp(balances);

    expect(transfers.length).toBeLessThan(balances.length);

    // Applying the transfers brings every balance to exactly zero.
    const left = new Map(balances.map((b) => [b.displayName, b.balanceSatang]));
    for (const t of transfers) {
      left.set(t.from, (left.get(t.from) ?? 0) + t.amountSatang);
      left.set(t.to, (left.get(t.to) ?? 0) - t.amountSatang);
    }
    expect([...left.values()].every((v) => v === 0)).toBe(true);
  });

  it('has nothing to do when nobody owes anything', () => {
    expect(settleUp([])).toEqual([]);
  });
});
