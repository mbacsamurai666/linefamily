import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness.js';

/**
 * Supabase serves every table in `public` over its REST API unless row-level
 * security is on. The bot never uses that API, so every table must have RLS
 * on — including tables that later migrations add.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('the public schema', () => {
  it('has row-level security on every table', async () => {
    const open = await db.prisma.$queryRawUnsafe<Array<{ relname: string }>>(
      `select c.relname from pg_class c
         where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity
           and c.relname <> '_prisma_migrations'`,
    );
    // A table listed here was added by a migration that did not turn RLS on.
    expect(open.map((r) => r.relname)).toEqual([]);
  });

  it('still lets the owner read and write — RLS does not touch the bot', async () => {
    const family = await db.prisma.family.create({ data: { lineGroupId: 'G_security' } });
    expect(await db.prisma.family.count({ where: { id: family.id } })).toBe(1);
  });
});
