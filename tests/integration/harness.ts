import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PrismaClient } from '@prisma/client';

/**
 * A real Postgres for tests, with nothing to install.
 *
 * PGlite is Postgres compiled to WASM; pglite-socket puts it behind the actual
 * Postgres wire protocol, so Prisma connects to it exactly as it would to a
 * server. That means these tests exercise the generated DDL, the enums, the
 * array defaults and the compound-key upserts for real — not a mock of them.
 *
 * docker-compose.yml runs a stock Postgres for parity checks before deploying;
 * point DATABASE_URL at that and these same tests run against it unchanged.
 */

const MIGRATIONS_DIR = path.join('src', 'db', 'migrations');

/** Every migration.sql under src/db/migrations, in folder-name (chronological) order. */
function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
}

export interface TestDb {
  prisma: PrismaClient;
  /** Wipe every row between tests. Family cascades to everything else. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Ephemeral high port, re-rolled if something else already holds it. */
function randomPort(): number {
  return 49152 + Math.floor(Math.random() * 15000);
}

export async function createTestDb(): Promise<TestDb> {
  const pg = await PGlite.create();

  let server: PGLiteSocketServer | undefined;
  let port = 0;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 8; attempt++) {
    port = randomPort();
    const candidate = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' });
    try {
      await candidate.start();
      server = candidate;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!server) {
    await pg.close();
    throw new Error(`could not bind a port for PGlite: ${String(lastErr)}`);
  }

  for (const sql of allMigrations()) {
    await pg.exec(sql);
  }

  const prisma = new PrismaClient({
    // connection_limit=1: pglite-socket backs one in-process WASM Postgres
    // instance — a second physical connection from Prisma's pool (opened the
    // moment application code issues two queries via Promise.all) hangs
    // rather than erroring, so every query must serialize onto the same
    // connection instead of pooling.
    datasources: {
      db: { url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?connection_limit=1` },
    },
  });

  return {
    prisma,
    async reset() {
      await prisma.$executeRawUnsafe('TRUNCATE "Family" CASCADE');
    },
    async close() {
      await prisma.$disconnect();
      await server.stop();
      await pg.close();
    },
  };
}
