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
| `DRY_RUN` | Required: `true` or `false`. When `true`, no Unipile write endpoint is called |

The deploy succeeds even with weak secrets, but every request then fails until each secret is long enough. Generate each of the three secrets with:

```bash
openssl rand -base64 32
```

If a variable is missing or too short, or `DRY_RUN` is anything but `true` or `false`, `/api/tick` and `/api/webhooks/unipile` answer `500 {"error":"misconfigured"}`, and the login page answers every password with `The server is not configured correctly`. The function log names the variable. A typo in `DRY_RUN` therefore stops the app; it never switches it to live sending. Spaces and line breaks around a value are ignored.

A browser that is already logged in does not get that message. While a variable other than `APP_PASSWORD` is wrong, its dashboard shows the error page "This page couldn't load". The function log names the variable there too. A wrong `APP_PASSWORD` ends every session instead: that browser is sent to the login page and gets the message there.

Changing `APP_PASSWORD` logs out every session.

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
3. **Migrations.** Production migrations are not automatic. Run them by hand against the Neon database, with the Neon URL in place of the placeholder. Keep the single quotes: the URL can contain `&`, and without quotes the shell cuts the command there. The value is the `DATABASE_URL` that the Neon integration added. Read it in Vercel under Settings → Environment Variables. It is also shown in the Neon console:

   ```bash
   DATABASE_URL='<neon url>' npm run db:migrate
   ```

   Run this again after any release that adds a migration.

   If the dashboard shows the error page "This page couldn't load" right after a successful login, the app cannot read the database. Check `DATABASE_URL`, and check that this step ran.
4. **Unipile webhooks.** In the Unipile dashboard, go to Webhooks and create two webhooks:
   - One Messaging webhook, event `message_received`.
   - One Users webhook, event `new_relation`.

   Both use the URL `https://<app>.vercel.app/api/webhooks/unipile` and these two headers:
   - `Unipile-Auth: <WEBHOOK_SECRET>`
   - `Content-Type: application/json`
5. **Prove the webhooks.** Nothing else in the first run does: a wrong URL, header or event shows only later, as replies that are never recorded.
   1. Send any LinkedIn message by hand, to anyone.
   2. Open the dashboard and reload it. Within a minute the event log shows a `webhook_received` line, with `message_received` and an outcome under it. For a person who is not one of your leads, the outcome is `unknown_lead`.
   3. If no line appears, check the URL, the two headers and the event of the Messaging webhook. A wrong `Unipile-Auth` value is answered with 401 and leaves no line in the event log.
   4. If the outcome is `ignored`, the message was not matched to your account. Compare the account id of the webhook with `UNIPILE_ACCOUNT_ID`.
6. **cron-job.org.** Create a job:
   - `GET https://<app>.vercel.app/api/tick`
   - Header `Authorization: Bearer <CRON_SECRET>`. No other form is accepted.
   - Schedule it every minute, only inside the active hours, on the active days. For the default window: every minute, Monday to Friday, from 08:00 to 19:59, time zone `Europe/Paris`. If you change the active window in Settings, change the job to match.
   - Every minute, because each send is planned to the second (see [Spacing](#spacing)). A tick waits for a planned moment that is up to 90 seconds away, so a tick every minute reaches each planned moment. With a tick every 5 minutes, a send can be up to about 3.5 minutes late, and then also gets the random wait of 0 to 90 seconds.
   - Turn on the failure notifications of the job. `/api/tick` answers 202 when the tick is accepted, `500 {"error":"database_unreachable"}` when it cannot read the database, and `500 {"error":"misconfigured"}` when a variable is wrong. The failure e-mails are the monitoring of this app.

   Do not run the job around the clock. Every tick reads the database, even when the app is paused or outside the active window. A tick every minute, day and night, keeps the Neon database awake and uses about 180 compute-hours a month. The free allowance is 100. Neon then suspends the database until the next month: `/api/tick` and the webhooks answer 500, and replies are no longer recorded. Outside the active window a tick does nothing but mark finished sequences as `no_response`, so nothing is lost by not running it. Webhooks still wake the database when they arrive.

## First run in dry run

With `DRY_RUN=true`, the full flow, the caps and the templates run, but no Unipile write endpoint is called. Profile fetches and chat reads still happen. The dashboard shows the banner `Dry run: nothing is sent to LinkedIn`.

Do this rehearsal on the deployed app, against the real Neon database, and not only on your machine. Every automated test runs on the local test database, so the rehearsal is the first time this code runs on Neon.

1. Open Settings, write your four templates and save them: invite note, first message, follow-up 1 and follow-up 2. Start is blocked until all four are saved, valid, and no longer the placeholder texts the app ships with.
2. On the dashboard, paste 3 profile links, one per line. One of them should be an existing 1st-degree connection.

   Accepted links look like `linkedin.com/in/<slug>`. They can have `www.` or a country subdomain, a trailing slash, a query string, or a two-letter language suffix such as `/in/<slug>/en`. Other links (Sales Navigator, company pages) are rejected with an error on that line.
3. Press Start.
4. Wait for a few ticks. Ticks act only inside the active window (by default Mon–Fri, 08:30–19:00, `Europe/Paris`; editable in Settings), so a dry run started in the evening or at a weekend shows nothing until the next window opens. Each tick takes at most one action, and with the default spacing the pause between two sends on a light day is about 20 to 70 minutes (see [Spacing](#spacing)), so 3 leads take an hour or more. Then check two things:
   - The event log shows `would send: …` lines.
   - In the lead table on the dashboard, under each name, the line with position and company looks right. This also confirms the `work_experience` field mapping against a real Unipile response.
5. Remove the leads that were processed during the dry run. Otherwise they would never be contacted for real: a lead that got a dry-run message fails at its next step once `DRY_RUN` is off, and a lead that got a dry-run invite sits in `invite_sent` until it expires after 21 days, without ever being invited. Removing a lead keeps its events, so the dry run's invites and messages still count against today's caps and, for invites, the rolling 7 days.
6. Press Pause. The app is still running after the rehearsal, and it would send for real as soon as the next step is deployed.
7. Set `DRY_RUN=false` in Vercel and redeploy. The banner on the dashboard now reads `Live: actions are sent to LinkedIn`.
8. In Settings, set small caps for the first live week, for example 5 invites per day. The dry run never calls a Unipile write endpoint, so the first real invite, acceptance, message and withdrawal are the first real test of those calls.
9. Paste your real list and press Start.

## Spacing

Sends do not follow a clock: one action every 5 minutes from the moment the window opens is the rhythm that marks an account as automated. Each invite and message is planned for a random moment instead. Settings has four values for it, under Spacing:

- **Pause between sends, shortest and longest average** (4 and 45 minutes by default). After each send, the app divides the time left in today's active hours by the sends still planned for today. Kept between these two values, that is the average pause. The actual pause is drawn at random between half and one and a half times the average. A busy day is spread over the whole window, and a light day does not send everything in the first minutes. After an invite withdrawal, the next withdrawal waits a random 10 to 30 minutes.
- **First send of the day** (45 minutes). The first send waits for a random moment in this time after the active hours open. When that moment has already passed, for example when you press Start in the afternoon, the first send comes within two minutes.
- **Follow-up time** (180 minutes). A follow-up is due after its delay in days plus a random part of this time, so it does not come at the same hour as the message before it.

A longest pause of 0 turns off the pauses between sends and between withdrawals, and a first send or follow-up time of 0 turns that part off. Settings accepts at most 240 minutes for the pauses, 180 for the first send and 720 for the follow-up time, and the first send time must be shorter than the active hours. When you shorten these values, a send already planned further ahead than the new values allow is brought forward to that distance on the next tick. While the app runs, the dashboard shows when the next send may happen, under the usage line.

Spacing lowers how regular the account looks; it does not make automation invisible and it does not replace low volumes.

## Known limits

- An invitation that the person declines, or that you withdraw by hand inside LinkedIn, leaves the list of sent invitations. The poll notices, and one profile view checks whether it was accepted. When the next poll, three to five hours later, still does not find it and the person is still not a connection, the lead is set to `invite_expired`. This costs two profile views in all.
- Removing a lead does not withdraw its pending invitation on LinkedIn. Withdraw it there by hand if you want it gone. If the person accepts it later, nothing is sent.
- A message you type by hand in LinkedIn counts as a manual message only when it is more than 2 minutes newer than the lead's last recorded action.
- The random wait in Settings is capped at 100 seconds, so that a tick always finishes inside the 180 s function limit. The other limits are capped too: 80 invites per day, 200 per 7 days, 100 messages per day and 100 profile views per day. Delays counted in days are at least 1 day.

## Costs

- Unipile: 49 EUR per month, which covers up to 10 accounts, after a 7-day free trial.
- Vercel Hobby and cron-job.org: free.
- Neon free tier: free only while cron-job.org calls the tick during the active hours alone. Called around the clock, the tick uses about 180 compute-hours a month against a free allowance of 100, and Neon then suspends the database until the next month.
- Vercel's Hobby plan is for personal, non-commercial use. Commercial use needs the Pro plan.
