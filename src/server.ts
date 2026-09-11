import { serve } from '@hono/node-server';
import { messagingApi } from '@line/bot-sdk';
import { DateTime } from 'luxon';
import OpenAI from 'openai';
import { loadConfig, aiEnabledForModule, type Config } from './config/index.js';
import { db, disconnect } from './db/client.js';
import { ChainedIntentParser } from './intent/ChainedIntentParser.js';
import { OpenAiIntentParser } from './intent/OpenAiIntentParser.js';
import { RuleIntentParser } from './intent/RuleIntentParser.js';
import type { IntentParser } from './intent/types.js';
import { VisionParser } from './intent/VisionParser.js';
import { verifyLiffIdToken } from './api/liffAuth.js';
import { createApp } from './line/app.js';
import { DraftStore } from './line/drafts.js';
import { PhotoTargetStore } from './line/photoTargets.js';
import { ReminderEngine, yearMonthOf } from './reminders/engine.js';
import { refreshRecurring } from './reminders/generate.js';
import {
  LineNotifier,
  PrismaBudgetStore,
  PrismaFamilyStore,
  PrismaJobStore,
  reconcilePushBudget,
} from './reminders/prisma-stores.js';

const log = (msg: string, meta?: Record<string, unknown>) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...meta }));
};

/**
 * Builds the intent chain. Turning AI off is not a branch inside the parsers —
 * it is this function returning a chain with one parser in it.
 */
function buildParser(cfg: Config, openai: OpenAI | null): IntentParser {
  const parsers: IntentParser[] = [new RuleIntentParser()];

  if (openai && aiEnabledForModule(cfg, 'intent')) {
    parsers.push(
      new OpenAiIntentParser({
        client: openai,
        model: cfg.OPENAI_TEXT_MODEL,
        onError: (err) => log('llm parse failed', { err: String(err) }),
      }),
    );
    log('intent chain: rule -> llm', { model: cfg.OPENAI_TEXT_MODEL });
  } else {
    log('intent chain: rule only (AI disabled)');
  }

  return new ChainedIntentParser(parsers, {
    onParserUsed: (name, result) => log('parser used', { parser: name, kind: result.kind }),
  });
}

/** Receipts have their own module switch — vision can stay off even with text AI on. */
function buildVisionParser(cfg: Config, openai: OpenAI | null): VisionParser | undefined {
  if (!openai || !aiEnabledForModule(cfg, 'receipts')) {
    log('receipt OCR: disabled');
    return undefined;
  }
  log('receipt OCR: enabled', { model: cfg.OPENAI_VISION_MODEL });
  return new VisionParser({
    client: openai,
    model: cfg.OPENAI_VISION_MODEL,
    onError: (err) => log('vision parse failed', { err: String(err) }),
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const prisma = db();

  const api = new messagingApi.MessagingApiClient({
    channelAccessToken: cfg.LINE_CHANNEL_ACCESS_TOKEN,
  });

  const drafts = new DraftStore();
  const photoTargets = new PhotoTargetStore();
  const openai = cfg.aiUsable ? new OpenAI({ apiKey: cfg.OPENAI_API_KEY }) : null;
  const parser = buildParser(cfg, openai);
  const visionParser = buildVisionParser(cfg, openai);
  const blobApi = new messagingApi.MessagingApiBlobClient({
    channelAccessToken: cfg.LINE_CHANNEL_ACCESS_TOKEN,
  });
  const liffUrl = cfg.LIFF_ID ? `https://liff.line.me/${cfg.LIFF_ID}` : undefined;

  const engine = new ReminderEngine({
    jobs: new PrismaJobStore(prisma),
    budget: new PrismaBudgetStore(prisma, cfg.PUSH_MONTHLY_QUOTA),
    notifier: new LineNotifier(api, prisma, liffUrl),
    families: new PrismaFamilyStore(prisma),
    clock: { now: () => DateTime.now().setZone(cfg.TZ) },
    morningHour: cfg.DIGEST_MORNING_HOUR,
    eveningHour: cfg.DIGEST_EVENING_HOUR,
    reserveThreshold: cfg.PUSH_RESERVE_THRESHOLD,
    onEvent: (e) => log('reminder', { ...e }),
  });

  const app = createApp({
    prisma,
    api,
    blobApi,
    ...(visionParser ? { visionParser } : {}),
    parser,
    drafts,
    photoTargets,
    defaultTimezone: cfg.TZ,
    channelSecret: cfg.LINE_CHANNEL_SECRET,
    pendingDrafts: () => drafts.size,
    log,
    ...(cfg.LIFF_ID ? { liffId: cfg.LIFF_ID } : {}),
    ...(cfg.LIFF_CHANNEL_ID
      ? {
          liffApi: {
            prisma,
            defaultTimezone: cfg.TZ,
            verifyToken: (idToken: string) => verifyLiffIdToken(idToken, cfg.LIFF_CHANNEL_ID),
            log,
          },
        }
      : {}),
  });

  const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
    log('listening', { port: info.port, webhook: `${cfg.PUBLIC_BASE_URL}/line/webhook` });
  });

  // The reminder worker. A plain interval is enough because every job is
  // claimed and marked, so a missed or repeated tick changes nothing.
  const tick = setInterval(() => {
    engine.tick().catch((err) => log('tick failed', { err: String(err) }));
  }, 60_000);

  // Drift between our tally and LINE's own counter is what silently eats the
  // quota, so reconcile daily.
  const reconcile = setInterval(
    () => {
      reconcilePushBudget(prisma, api, yearMonthOf(DateTime.now().setZone(cfg.TZ))).catch((err) =>
        log('reconcile failed', { err: String(err) }),
      );
    },
    24 * 60 * 60_000,
  );

  // Birthdays and repeating appointments are only ever scheduled a little way
  // ahead, so something has to walk them forward. Runs at boot and daily.
  const rollRecurring = () => {
    photoTargets.sweep();
    refreshRecurring(prisma, DateTime.now().setZone(cfg.TZ))
      .then(() => log('recurring refreshed'))
      .catch((err) => log('recurring refresh failed', { err: String(err) }));
  };
  rollRecurring();
  const recurring = setInterval(rollRecurring, 24 * 60 * 60_000);

  const shutdown = async () => {
    clearInterval(tick);
    clearInterval(reconcile);
    clearInterval(recurring);
    server.close();
    await disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('fatal', { err: String(err) });
  process.exit(1);
});
