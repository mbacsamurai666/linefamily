import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { validateSignature, type WebhookEvent } from '@line/bot-sdk';
import type { ApiDeps } from '../api/router.js';
import { createApiRouter } from '../api/router.js';
import type { HealthReport } from '../modules/health.js';
import type { WebhookDeps } from './webhook.js';
import { handleEvent } from './webhook.js';

export interface AppDeps extends WebhookDeps {
  channelSecret: string;
  /** Extra state for /health. */
  pendingDrafts?: () => number;
  /**
   * Await event processing instead of letting it run detached. Production
   * acknowledges LINE first and works afterwards; tests need determinism.
   */
  processSynchronously?: boolean;
  /** Omit to run without the /api surface (webhook-only tests). */
  liffApi?: ApiDeps;
  /** Handed to the LIFF page at runtime so a rebuild is never needed to change it. */
  liffId?: string;
  /** Omit to keep /health a plain liveness check with no database round trip. */
  health?: () => Promise<HealthReport>;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  /**
   * 503 when the queue has stopped draining, so an uptime monitor pointed here
   * raises an alarm instead of only noticing a process that is fully dead. A
   * bot that is up but silently not reminding anyone is the failure that
   * actually costs a family something.
   */
  app.get('/health', async (c) => {
    const drafts = deps.pendingDrafts?.() ?? 0;

    if (!deps.health) return c.json({ ok: true, drafts });

    try {
      const report = await deps.health();
      return c.json({ ...report, drafts }, report.ok ? 200 : 503);
    } catch (err) {
      deps.log?.('health check failed', { err: String(err) });
      return c.json({ ok: false, drafts, error: 'database unreachable' }, 503);
    }
  });

  /**
   * The digest picture, fetched by LINE (and then by every phone in the group)
   * after the push names this URL. Unguessable id, no listing, and nothing in
   * it that is not already in the message it belongs to.
   */
  app.get('/digest/:id/board.png', async (c) => {
    const row = await deps.prisma.digestImage.findUnique({
      where: { id: c.req.param('id') },
      select: { png: true },
    });
    if (!row) return c.text('not found', 404);

    c.header('content-type', 'image/png');
    // It never changes, and LINE's own cache should keep it out of our queries.
    c.header('cache-control', 'public, max-age=604800, immutable');
    return c.body(new Uint8Array(row.png));
  });

  if (deps.liffApi) {
    app.route('/api', createApiRouter(deps.liffApi));
  }

  // The page asks the server which LIFF app it belongs to, rather than
  // trusting whatever Vite inlined when the bundle was built. Registered
  // before the static handler so it wins over any file of the same name.
  app.get('/liff/config.js', (c) => {
    c.header('content-type', 'application/javascript; charset=utf-8');
    c.header('cache-control', 'no-store');
    return c.body(`window.__LIFF_ID__ = ${JSON.stringify(deps.liffId ?? '')};`);
  });

  // Served from the same process the plan calls for: no separate deploy for
  // the LIFF page. 404s harmlessly if `liff/dist` has not been built yet.
  app.use(
    '/liff/*',
    serveStatic({
      root: './liff/dist',
      rewriteRequestPath: (path) => {
        const stripped = path.replace(/^\/liff/, '') || '/';
        return stripped === '/' ? '/index.html' : stripped;
      },
    }),
  );

  app.post('/line/webhook', async (c) => {
    // The signature covers the exact bytes LINE sent, so the raw body must be
    // read before anything parses it.
    const raw = await c.req.text();
    const signature = c.req.header('x-line-signature');

    if (!signature || !validateSignature(raw, deps.channelSecret, signature)) {
      deps.log?.('rejected webhook: bad signature');
      return c.text('invalid signature', 401);
    }

    let events: WebhookEvent[];
    try {
      events = (JSON.parse(raw) as { events?: WebhookEvent[] }).events ?? [];
    } catch {
      return c.text('bad request', 400);
    }

    const work = async () => {
      for (const event of events) {
        try {
          await handleEvent(event, deps);
        } catch (err) {
          deps.log?.('event handler failed', { type: event.type, err: String(err) });
        }
      }
    };

    // LINE retries anything slow, and the LLM fallback can take seconds.
    // Acknowledge first, then work — reply tokens stay valid long enough.
    if (deps.processSynchronously) await work();
    else void work();

    return c.text('ok', 200);
  });

  return app;
}
