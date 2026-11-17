# LinkedIn Reachout

A single-user tool that cold-contacts a list of LinkedIn profiles through Unipile. It sends a connection invitation with a personalized note. When the invitation is accepted, it sends a first message, then up to two follow-ups. It stops as soon as the person replies. You drive it from a small password-protected dashboard.

The full design is in [docs/spec.md](docs/spec.md). The README agrees with it. If they ever differ, the spec wins.

## Local development

You need Node 22.12 or newer.

1. Install the dependencies.

   ```bash
   npm install
   ```

2. Copy the example environment file.

   ```bash
   cp .env.example .env.local
   ```

3. Fill in `.env.local`. See [Environment variables](#environment-variables). Keep `DRY_RUN=true`.
4. Keep `DATABASE_URL=pglite:./.data/dev`. This is a local database stored in a folder. It is created on first use, and migrations are applied automatically.
5. Start the dev server.

   ```bash
   npm run dev
   ```

6. Open http://localhost:3000 and log in with `APP_PASSWORD`.

To run the tests:

```bash
npm test
```

Other checks: `npm run typecheck`, `npm run lint`, `npm run build`.

## Environment variables

| Name | Purpose |
|---|---|
| `UNIPILE_DSN` | Unipile base URL, for example `https://apiX.unipile.com:PORT` |
| `UNIPILE_API_KEY` | Unipile access token. Sent as `X-API-KEY` |
| `UNIPILE_ACCOUNT_ID` | The LinkedIn account you connected in the Unipile dashboard |
| `DATABASE_URL` | Neon connection string in production. `pglite:<dir>` is a local database for development only |
| `APP_PASSWORD` | Dashboard login password. At least 16 characters |
| `CRON_SECRET` | Required on `/api/tick`. At least 32 characters |
| `WEBHOOK_SECRET` | Expected in the `Unipile-Auth` header on webhook calls. At least 32 characters |
| `DRY_RUN` | When `true`, no Unipile write endpoint is called |

The app refuses to start with weak secrets. Generate each of the three secrets with:

```bash
openssl rand -base64 32
```

If a variable is missing or too short, `/api/tick` and `/api/webhooks/unipile` answer `500 {"error":"misconfigured"}`. The function log names the variable. Changing `APP_PASSWORD` logs out every session.

## Deployment

Do these steps in order.

1. **Unipile.**
   1. Start the 7-day trial.
   2. In the Unipile dashboard, connect your LinkedIn account.
   3. Copy the DSN, an access token (this is `UNIPILE_API_KEY`) and the account id.
2. **Vercel.**
   1. Import the repository as a new project. Fluid compute is on by default for new projects. Keep it on: the tick route can run for up to 180 s (`maxDuration = 180`), which needs it.
   2. Add Neon from the Vercel Marketplace. It sets `DATABASE_URL`.
   3. Set the other variables from the table above. Set `DRY_RUN=true`.
   4. Deploy.
3. **Migrations.** Production migrations are not automatic. Run them by hand against the Neon database, with the Neon URL in place of the placeholder:

   ```bash
   DATABASE_URL=<neon url> npm run db:migrate
   ```

   Run this again after any release that adds a migration.
4. **Unipile webhooks.** In the Unipile dashboard, go to Webhooks and create two webhooks:
   - One Messaging webhook, event `message_received`.
   - One Users webhook, event `new_relation`.

   Both use the URL `https://<app>.vercel.app/api/webhooks/unipile` and these two headers:
   - `Unipile-Auth: <WEBHOOK_SECRET>`
   - `Content-Type: application/json`
5. **cron-job.org.** Create a job:
   - Every 5 minutes.
   - `GET https://<app>.vercel.app/api/tick`
   - Header `Authorization: Bearer <CRON_SECRET>`. No other form is accepted.

## First run in dry run

With `DRY_RUN=true`, the full flow, the caps and the templates run, but no Unipile write endpoint is called. Profile fetches still happen.

1. Open Settings and save the four templates: invite note, first message, follow-up 1 and follow-up 2. Start is blocked until all four are saved and valid.
2. On the dashboard, paste 3 profile links, one per line. One of them should be an existing 1st-degree connection.

   Accepted links look like `linkedin.com/in/<slug>`. They can have `www.` or a country subdomain, a trailing slash, a query string, or a two-letter language suffix such as `/in/<slug>/en`. Other links (Sales Navigator, company pages) are rejected with an error on that line.
3. Press Start.
4. Wait a few ticks. Then check two things:
   - The event log shows `would send: …` lines.
   - Each lead's company and position look right. This also confirms the `work_experience` field mapping against a real Unipile response.
5. Remove the leads that were processed during the dry run. They carry dry-run invitation and chat ids, so their next step would fail once `DRY_RUN` is off.
6. Set `DRY_RUN=false` in Vercel and redeploy.
7. Paste your real list and press Start.

## Known limits

- An invitation you withdraw by hand inside LinkedIn is checked again on each poll, two or three times a day, until it expires after 21 days. Each check costs one profile view.
- A message you type by hand in LinkedIn counts as a manual message only when it is more than 2 minutes newer than the lead's last recorded action.
- The random wait in Settings is capped at 100 seconds, so that a tick always finishes inside the 180 s function limit.

## Costs

- Unipile: 49 EUR per month, which covers up to 10 accounts, after a 7-day free trial.
- Vercel Hobby, Neon free tier and cron-job.org: free.
