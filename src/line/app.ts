import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { validateSignature, type WebhookEvent } from '@line/bot-sdk';
import type { ApiDeps } from '../api/router.js';
import { createApiRouter } from '../api/router.js';
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
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, drafts: deps.pendingDrafts?.() ?? 0 }));

  if (deps.liffApi) {
    app.route('/api', createApiRouter(deps.liffApi));
  }

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
