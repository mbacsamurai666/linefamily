# Deploy

The bot needs a process that stays up: the reminder engine ticks every 60
seconds and LINE delivers webhooks whenever someone types. Running it on a
laptop behind a `cloudflared` quick tunnel works for development, but the URL
changes every time the tunnel restarts and everything stops the moment the
machine sleeps — so the webhook has to be re-pasted into the LINE console each
time. Moving it to a small always-on host ends that.

One image contains both the bot and the LIFF page (the server serves
`liff/dist` itself), so there is only ever one thing to deploy.

The database stays where it is — the existing Supabase project. Nothing here
creates a new one.

## What the container does on boot

`prisma migrate deploy` runs first, then the server starts. A deploy that
includes a new migration applies it automatically; a deploy that does not is a
no-op.

## Environment variables

Copy the values from the local `.env`. The ones that must be set:

| Variable | Notes |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API channel |
| `LINE_CHANNEL_SECRET` | Messaging API channel |
| `LIFF_ID` | LIFF app id. Served to the page at runtime, so changing it needs only a restart — no rebuild |
| `LIFF_CHANNEL_ID` | The LINE **Login** channel id (different from the Messaging API one) |
| `DATABASE_URL` | The Supabase connection string, port **5432** (session pooler). Port 6543 is transaction mode and breaks migrations |
| `PUBLIC_BASE_URL` | `https://<your-domain>` once the host assigns one |
| `TZ` | `Asia/Bangkok` |
| `OPENAI_API_KEY` | Optional. Leave `AI_ENABLED=false` and the rule parser handles everything |

`PORT` is set by the platform; the server reads it.

## Railway

1. Push this repository to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**. The `Dockerfile` is
   detected automatically.
3. **Variables** → paste the values above.
4. **Settings → Networking → Generate Domain**. Copy the domain.
5. Set `PUBLIC_BASE_URL` to `https://<that-domain>` and redeploy.

## Fly.io

```bash
fly launch --no-deploy        # answer no to creating a Postgres
fly secrets set LINE_CHANNEL_ACCESS_TOKEN=... LINE_CHANNEL_SECRET=... \
  LIFF_ID=... LIFF_CHANNEL_ID=... DATABASE_URL=... TZ=Asia/Bangkok \
  PUBLIC_BASE_URL=https://<app>.fly.dev
fly deploy
```

Set `min_machines_running = 1` in `fly.toml`. A machine that scales to zero
misses the reminder ticks, which is the one thing this app cannot afford.

## After the first deploy

Two URLs point at the new host instead of the tunnel:

1. **LINE Developers Console → Messaging API → Webhook URL**
   → `https://<domain>/line/webhook`, then **Verify**.
2. **LINE Login channel → LIFF → Endpoint URL**
   → `https://<domain>/liff/`

Then reinstall the Rich Menu so its "open app" button points at the right
place:

```bash
npm run richmenu:install
```

## Checks

```bash
curl https://<domain>/health              # {"ok":true,...}
curl https://<domain>/liff/config.js      # window.__LIFF_ID__ = "..."
```

Send `ช่วย` in the family LINE group — a reply means the webhook is wired.

## Local production build

To run exactly what the container runs, without Docker:

```bash
npm run build && npm run liff:build && npm start
```
