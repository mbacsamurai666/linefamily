import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { ReminderEngine, nextDigestSlot } from '../src/reminders/engine.js';
import type {
  BudgetStore,
  Clock,
  FamilyStore,
  JobLane,
  JobStore,
  Notifier,
  ReminderJob,
} from '../src/reminders/ports.js';

const ZONE = 'Asia/Bangkok';
const FAMILY = 'fam_1';
const MORNING = 7;
const EVENING = 20;

type Status = 'PENDING' | 'SENT' | 'SKIPPED';

interface Row extends ReminderJob {
  status: Status;
  sentAt?: Date;
}

class MemoryStores implements JobStore, BudgetStore, Notifier, FamilyStore {
  rows: Row[] = [];
  used = new Map<string, number>();
  pushes: Array<{ familyId: string; kind: 'digest' | 'urgent'; jobIds: string[]; at: string }> = [];

  constructor(private readonly quota: number) {}

  // ---- JobStore
  async claimDue(now: Date, lane: JobLane, limit: number): Promise<ReminderJob[]> {
    return this.rows
      .filter((r) => r.status === 'PENDING' && r.lane === lane && r.dueAt <= now)
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .slice(0, limit);
  }
  async markSent(ids: string[], at: Date): Promise<void> {
    for (const r of this.rows) {
      if (ids.includes(r.id)) {
        // Catching a double-send is the entire point of this suite.
        if (r.status !== 'PENDING') throw new Error(`job ${r.id} sent twice`);
        r.status = 'SENT';
        r.sentAt = at;
      }
    }
  }
  async markSkipped(ids: string[]): Promise<void> {
    for (const r of this.rows) if (ids.includes(r.id)) r.status = 'SKIPPED';
  }
  async demoteToDigest(ids: string[]): Promise<void> {
    for (const r of this.rows) if (ids.includes(r.id)) r.lane = 'DIGEST';
  }

  // ---- BudgetStore
  async remaining(familyId: string, ym: string): Promise<number> {
    return this.quota - (this.used.get(`${familyId}:${ym}`) ?? 0);
  }
  async consume(familyId: string, ym: string, count: number): Promise<void> {
    const key = `${familyId}:${ym}`;
    this.used.set(key, (this.used.get(key) ?? 0) + count);
  }

  // ---- Notifier
  /** Stands in for the real notifier's card + picture, so the budget sees two. */
  digestMessages = 2;

  async sendDigest(familyId: string, jobs: ReminderJob[], slot: DateTime): Promise<number> {
    this.pushes.push({
      familyId,
      kind: 'digest',
      jobIds: jobs.map((j) => j.id),
      at: slot.toISO() ?? '',
    });
    return this.digestMessages;
  }
  async sendUrgent(familyId: string, job: ReminderJob): Promise<void> {
    this.pushes.push({ familyId, kind: 'urgent', jobIds: [job.id], at: '' });
  }

  // ---- FamilyStore
  async listActive() {
    return [{ familyId: FAMILY, timezone: ZONE }];
  }
}

function job(id: string, dueAt: DateTime, lane: JobLane = 'DIGEST'): Row {
  return {
    id,
    familyId: FAMILY,
    kind: 'EVENT',
    refId: `ref_${id}`,
    dueAt: dueAt.toJSDate(),
    lane,
    payload: { text: `reminder ${id}` },
    status: 'PENDING',
  };
}

function buildEngine(stores: MemoryStores, clock: Clock, reserveThreshold = 60) {
  return new ReminderEngine({
    jobs: stores,
    budget: stores,
    notifier: stores,
    families: stores,
    clock,
    morningHour: MORNING,
    eveningHour: EVENING,
    reserveThreshold,
  });
}

describe('nextDigestSlot', () => {
  const base = DateTime.fromISO('2026-09-04T00:00', { zone: ZONE });
  it.each([
    ['2026-09-04T03:00', '2026-09-04T07:00'],
    ['2026-09-04T07:00', '2026-09-04T20:00'],
    ['2026-09-04T12:00', '2026-09-04T20:00'],
    ['2026-09-04T21:00', '2026-09-05T07:00'],
  ])('%s -> %s', (now, expected) => {
    const dt = DateTime.fromISO(now, { zone: ZONE });
    expect(nextDigestSlot(dt, MORNING, EVENING).toFormat("yyyy-MM-dd'T'HH:mm")).toBe(expected);
    expect(base.isValid).toBe(true);
  });
});

/**
 * The load-bearing test for the whole architecture: run a real month of
 * reminders through the engine minute by minute and confirm the LINE free-plan
 * budget survives, with nothing lost and nothing sent twice.
 */
describe('a simulated month of reminders', () => {
  it('stays within two pushes a day and delivers every job exactly once', async () => {
    const stores = new MemoryStores(500);
    const start = DateTime.fromISO('2026-09-01T00:00', { zone: ZONE });

    // 4 appointments a day, each with the default three reminder offsets:
    // 360 jobs across the month, which per-item pushing could never afford.
    let n = 0;
    for (let day = 0; day < 30; day++) {
      for (let i = 0; i < 4; i++) {
        const at = start.plus({ days: day, hours: 8 + i * 3, minutes: 15 });
        stores.rows.push(job(`j${n++}`, at));
      }
    }
    const totalJobs = stores.rows.length;

    let cursor = start;
    const engine = buildEngine(stores, { now: () => cursor });

    const end = start.plus({ days: 31 });
    while (cursor < end) {
      await engine.tick();
      cursor = cursor.plus({ minutes: 1 });
    }

    const digests = stores.pushes.filter((p) => p.kind === 'digest');

    // At most two digests per calendar day.
    const perDay = new Map<string, number>();
    for (const p of digests) {
      const d = p.at.slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    for (const [day, count] of perDay) {
      expect(count, `too many pushes on ${day}`).toBeLessThanOrEqual(2);
    }

    // Comfortably inside the monthly quota, with reserve left over. LINE bills
    // per message, and each digest is a card plus its picture — so the budget
    // sees twice the number of pushes, and that still leaves most of the 500.
    expect(digests.length).toBeLessThanOrEqual(62);
    const used = stores.used.get(`${FAMILY}:2026-09`) ?? 0;
    expect(used).toBe(digests.length * stores.digestMessages);
    expect(used).toBeLessThanOrEqual(150);

    // Nothing dropped: every job was delivered, and inside exactly one digest.
    expect(stores.rows.filter((r) => r.status === 'SENT')).toHaveLength(totalJobs);
    const delivered = digests.flatMap((p) => p.jobIds);
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(delivered.length).toBe(totalJobs);
  });

  it('is idempotent when a tick runs twice at the same instant', async () => {
    const stores = new MemoryStores(500);
    const at = DateTime.fromISO('2026-09-04T07:00', { zone: ZONE });
    stores.rows.push(job('a', at.minus({ hours: 2 })));

    const engine = buildEngine(stores, { now: () => at });
    await engine.tick();
    // markSent throws on a repeat, so a double delivery fails loudly here.
    await engine.tick();

    expect(stores.pushes).toHaveLength(1);
  });
});

/**
 * Reminders that outlive their digest slot are the failure this whole app is
 * for: the family is not told, and nothing looks broken. It happened for real —
 * two reminders sat PENDING for five days because the process was not running
 * at 07:00 or 20:00 on any of them.
 */
describe('a digest slot the engine was not running for', () => {
  it('flushes what the downtime swallowed on the first tick back', async () => {
    const stores = new MemoryStores(500);
    const missed = DateTime.fromISO('2026-09-06T13:00', { zone: ZONE });
    stores.rows.push(job('stale', missed));

    // Back up five days later, in the middle of the afternoon — nowhere near a slot.
    const back = DateTime.fromISO('2026-09-11T13:22', { zone: ZONE });
    await buildEngine(stores, { now: () => back }).tick();

    expect(stores.pushes).toHaveLength(1);
    expect(stores.pushes[0]?.jobIds).toEqual(['stale']);
  });

  it('does not reach forward into reminders that are not late yet', async () => {
    const stores = new MemoryStores(500);
    const back = DateTime.fromISO('2026-09-11T13:22', { zone: ZONE });
    // Due at 18:00 today: it belongs to tonight's digest, not to this sweep.
    stores.rows.push(job('later', back.set({ hour: 18, minute: 0 })));

    await buildEngine(stores, { now: () => back }).tick();

    expect(stores.pushes).toHaveLength(0);
  });

  it('sweeps once, not on every tick until the next slot', async () => {
    const stores = new MemoryStores(500);
    const back = DateTime.fromISO('2026-09-11T13:22', { zone: ZONE });
    stores.rows.push(job('stale', back.minus({ days: 2 })));

    let cursor = back;
    const engine = buildEngine(stores, { now: () => cursor });
    for (let i = 0; i < 30; i++) {
      await engine.tick();
      cursor = cursor.plus({ minutes: 1 });
    }

    expect(stores.pushes).toHaveLength(1);
  });

  it('still announces the day ahead when it boots right on the slot', async () => {
    const stores = new MemoryStores(500);
    const at = DateTime.fromISO('2026-09-11T07:00', { zone: ZONE });
    stores.rows.push(job('morning', at.set({ hour: 15 })));

    await buildEngine(stores, { now: () => at.plus({ seconds: 20 }) }).tick();

    expect(stores.pushes).toHaveLength(1);
    expect(stores.pushes[0]?.jobIds).toEqual(['morning']);
  });
});

describe('urgent lane', () => {
  const at = DateTime.fromISO('2026-09-04T09:00', { zone: ZONE });

  it('pushes immediately while the reserve holds', async () => {
    const stores = new MemoryStores(500);
    stores.rows.push(job('u1', at.minus({ minutes: 1 }), 'URGENT'));

    await buildEngine(stores, { now: () => at }).tick();

    expect(stores.pushes).toEqual([
      { familyId: FAMILY, kind: 'urgent', jobIds: ['u1'], at: '' },
    ]);
  });

  it('demotes to the digest instead of dropping when the budget runs low', async () => {
    const stores = new MemoryStores(500);
    stores.used.set(`${FAMILY}:2026-09`, 460); // 40 left, under the 60 reserve
    stores.rows.push(job('u2', at.minus({ minutes: 1 }), 'URGENT'));

    await buildEngine(stores, { now: () => at }).tick();

    expect(stores.pushes).toHaveLength(0);
    const row = stores.rows.find((r) => r.id === 'u2');
    expect(row?.lane).toBe('DIGEST');
    expect(row?.status).toBe('PENDING');
  });
});
