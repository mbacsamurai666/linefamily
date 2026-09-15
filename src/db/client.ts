import { PrismaClient } from '@prisma/client';

/**
 * Single client for the process. The reminder worker and the webhook handler
 * share it, which is what lets a confirm postback and the engine see the same
 * rows without a second pool.
 */
let client: PrismaClient | undefined;

/**
 * How many database connections this process may hold.
 *
 * Prisma's default is two per CPU plus one, and the Supabase pooler in session
 * mode allows fifteen clients in total — shared by this server, the one a
 * deploy is replacing (both run while Railway swaps them), and any script run
 * from a laptop. A container reporting eight CPUs asks for seventeen on its
 * own, which is how a one-line query from a laptop first failed with
 * "max clients reached" while the bot itself looked healthy. A family bot
 * never needs more than a handful at once.
 */
export const DEFAULT_CONNECTION_LIMIT = 5;

/** The database URL with a connection cap added, unless one was set explicitly. */
export function withConnectionLimit(url: string, limit = DEFAULT_CONNECTION_LIMIT): string {
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${limit}`;
}

export function db(): PrismaClient {
  const url = process.env.DATABASE_URL;
  client ??= url
    ? new PrismaClient({ datasources: { db: { url: withConnectionLimit(url) } } })
    : new PrismaClient();
  return client;
}

export async function disconnect(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
