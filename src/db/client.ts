import { PrismaClient } from '@prisma/client';

/**
 * Single client for the process. The reminder worker and the webhook handler
 * share it, which is what lets a confirm postback and the engine see the same
 * rows without a second pool.
 */
let client: PrismaClient | undefined;

export function db(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export async function disconnect(): Promise<void> {
  await client?.$disconnect();
  client = undefined;
}
