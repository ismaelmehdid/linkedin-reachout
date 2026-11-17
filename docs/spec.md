# LinkedIn Reachout — Specification

Single-user tool to cold-contact a list of LinkedIn profiles through Unipile: send connection invitations with a personalized note, then a first message once accepted, then follow-ups until the person replies or the sequence ends.

Status: agreed design, 2026-11-17.

## 1. Scope

- One user, one LinkedIn account (Premium). No multi-user, no campaigns.
- Deployed on Vercel. Driven from a small password-protected dashboard.
- Out of scope for v1: branching sequences, sentiment detection, reply notifications, Sales Navigator / Recruiter, InMail.

## 2. Stack

| Concern | Choice |
|---|---|
| App | Next.js (App Router) + TypeScript |
| Hosting | Vercel Hobby |
| Database | Neon Postgres (Vercel Marketplace) + Drizzle ORM |
| LinkedIn access | Unipile API **v1**, via a small in-house typed `fetch` wrapper (no `unipile-node-sdk`) |
| Scheduler | cron-job.org calls `GET /api/tick` every 5 minutes with `CRON_SECRET` |
| Tests | Vitest; flow engine tested with a fake clock and a mocked Unipile client |

## 3. Configuration

Environment variables:

| Name | Purpose |
|---|---|
| `UNIPILE_DSN` | Unipile base URL, e.g. `https://apiX.unipile.com:PORT` |
| `UNIPILE_API_KEY` | Sent as `X-API-KEY` |
| `UNIPILE_ACCOUNT_ID` | The LinkedIn account connected once in the Unipile dashboard |
| `DATABASE_URL` | Neon connection string. `pglite:<dir>` uses a local PGlite database instead (development only) |
| `APP_PASSWORD` | Dashboard login password, at least 16 characters |
| `CRON_SECRET` | Required on `/api/tick`. At least 32 characters; generate with `openssl rand -base64 32` |
| `WEBHOOK_SECRET` | Expected in the `Unipile-Auth` header on webhook calls. At least 32 characters; generate with `openssl rand -base64 32` |
| `DRY_RUN` | When `true`, no Unipile write endpoint is called |

The LinkedIn account is connected manually in the Unipile dashboard. There is no hosted-auth flow in the app.

## 4. Access control

- Next.js middleware requires a signed session cookie on every page and API route, except `/api/tick`, `/api/webhooks/unipile` and the login route.
- Login compares the submitted password with `APP_PASSWORD` (constant-time) and sets the signed cookie.
- The app refuses to start with weak secrets: `APP_PASSWORD` under 16 characters, or `CRON_SECRET` or `WEBHOOK_SECRET` under 32. The app is public, and the only brake on password guessing is a 1 s wait per wrong attempt.
- `/api/tick` rejects requests without the header `Authorization: Bearer <CRON_SECRET>`.
- `/api/webhooks/unipile` rejects requests without `Unipile-Auth: <WEBHOOK_SECRET>`. Unipile v1 webhooks are not signed, so this header is the only check.

## 5. Lead input

- The dashboard has a textarea: one LinkedIn URL per line.
- Accepted format: `linkedin.com/in/{slug}` only, with or without `www.` or a country subdomain, trailing slash, query string, or a two-letter language suffix such as `/in/{slug}/en`. Other URLs (Sales Navigator, company pages, malformed) are rejected with a per-line error.
- The normalized slug (`public_identifier`) is the dedupe key until the `provider_id` is known; from then on `provider_id` is the key.
- A person already present in the database, in any status, is skipped and reported as "already contacted". The tool never contacts the same person twice. A `failed` lead can be retried manually from its row.
- New leads are inserted with status `queued`.
- If the profile fetch shows that a lead's `provider_id` already belongs to another lead (the same person pasted under a different URL), the new lead is set to `failed` with reason `duplicate_person`.
- A global **Start / Pause** toggle controls all sending. Start is blocked until all four templates are saved and valid.

## 6. Sequence (fixed flow)

1. **Profile fetch** — `GET /api/v1/users/{slug}?account_id=…&linkedin_sections=experience_preview`. Store `provider_id` and variable values.
   - If `network_distance` is `FIRST_DEGREE`: status `already_connected`, skip to step 3 (first message due now).
2. **Invite** — `POST /api/v1/users/invite` with the rendered invite note (≤ 300 characters). Status `invite_sent`. Store `invitation_id`.
3. **Acceptance** — when detected (see §7), status `accepted`, first message scheduled at a random delay of 1–3 hours.
4. **First message** — `POST /api/v1/chats` (new chat with `attendees_ids=[provider_id]`) or `POST /api/v1/chats/{chat_id}/messages` if a chat already exists. Status `messaged`.
5. **Follow-up 1** — 2 calendar days after the previous message with no reply. Status `followup_1`.
6. **Follow-up 2** — 3 calendar days after follow-up 1 with no reply. Status `followup_2`.
7. **End** — 3 calendar days after follow-up 2 with no reply. Status `no_response`. (The end delay is editable like the others.)

Rules that apply at every step:

- **Stop on reply**: any message from the lead, at any time (including a reply to the invite note without accepting), sets status `replied` and cancels all pending actions for that lead permanently.
- **Manual messages**: an outgoing message the user sends directly on LinkedIn counts as a step having been sent. Before the first message, it replaces the first message (status `messaged`). After that, it resets the follow-up timer without changing the step.
- **Invite expiry**: an invite still pending 21 days after sending is withdrawn (`DELETE /api/v1/users/invite/sent/{invitation_id}`) and the lead is set to `invite_expired`.
- **Active window**: an action that becomes due outside the active window waits for the next window.
- **Paused app**: while the app is paused, ticks do nothing. Webhooks still record replies and acceptances.
- Delays (2 / 3 / 3 days, 1–3 h, 21 days) are editable in Settings.

## 7. Detection

### Acceptance

- **Messaging webhook** (`source: messaging`, `message_received`): accepting an invite that had a note creates a chat containing the note, which fires in near real time. When this fires for a lead in `invite_sent`, confirm with a profile fetch (`network_distance === FIRST_DEGREE`), because a reply without accepting also creates a chat.
- **Users webhook** (`source: users`, `new_relation`): matched by `user_provider_id`. May arrive up to 8 hours after acceptance.
- **Safety-net poll**: `GET /api/v1/users/invite/sent` 2–3 times per day at random hours within the active window. An invite that disappeared from the list is checked with a profile fetch (accepted vs ignored).

### Replies

- From `message_received`: a message is a reply when `sender.attendee_provider_id !== account_info.user_id` and the sender's provider id matches a lead.
- A message where the sender is the account owner is treated as a manual outgoing message (see §6). For a lead in `invite_sent`, it is the acceptance signal described above instead. An owner message counts as manual only when it is more than 2 minutes newer than the lead's last recorded action. Anything else is ignored: the echo of the app's own send, a late or retried copy of the invite note, or an out-of-order delivery.
- Before sending any message in an existing chat (the first message after an invite with a note, and every follow-up), fetch the latest messages of the chat (`GET /api/v1/chats/{chat_id}/messages`) and abort if a reply exists, in case a webhook was missed.

Webhooks are registered once in the Unipile dashboard with the header `Unipile-Auth: <WEBHOOK_SECRET>` and `Content-Type: application/json`. The handler returns 200 quickly (Unipile retries after 30 s).

## 8. Pace and limits

| Limit | Default |
|---|---|
| Invites per day | 35 |
| Invites per rolling 7 days | 190 |
| Messages per day (first messages + follow-ups) | 90 |
| Profile views per day | 90 |
| Actions per tick | 1 |
| Random wait before each action | 0–90 s |
| Active window | Mon–Fri, 08:30–19:00, `Europe/Paris` |
| Warm-up ramp | none |

- Due messages take priority over new invites.
- When several actions are due, one is picked at random. After the random wait, the tick reads the app state, the settings and the picked lead again. It sends nothing if the app was paused, the active window closed, or the lead changed in the meantime (a reply, a manual message, a pause); a template saved during the wait is the one that is sent.
- Housekeeping runs before the outreach action of each tick and does not use its slot: marking `no_response`, up to 3 acceptance checks (profile views, inside the daily cap), at most 1 invite withdrawal, and the invite poll when it is due.
- All values are editable in Settings.

These defaults stay under the limits Unipile documents for paid accounts (80–100 invites per day, about 200 per week; about 100 profile views and 100 actions of each type per day).

## 9. Templates and variables

- Four templates: invite note, first message, follow-up 1, follow-up 2. Written by the user in Settings; the app ships short placeholder drafts.
- Variables: `first_name`, `last_name`, `headline`, `company`, `position`, `location`. `company` and `position` come from the current entry of `work_experience`.
- Syntax: `{{first_name}}`; fallback with `{{company|your team}}`.
- A variable with no value and no fallback blocks the action and sets the lead to `failed` with reason `missing_variable`. A raw `{{…}}` is never sent.
- Right after a lead's profile fetch, before the invite, all four templates are rendered for that lead. A missing variable (`missing_variable: …`) or a rendered invite note over 300 characters (`note_too_long`) sets the lead to `failed` before anything is sent.
- Settings shows a live preview of each template rendered against one real lead, and a character counter for the invite note (limit 300).

## 10. Error handling

| Unipile error | Action |
|---|---|
| `errors/cannot_resend_yet`, `limit_exceeded`, `connection_limit_reached`, HTTP 429 | Pause the action type that hit the limit (invites or messages) until the next active day (or `retry_after`). Lead unchanged. |
| HTTP 5xx, network error, timeout | Lead unchanged; tried again on a later tick. |
| `errors/already_connected` | Status `already_connected`; first message due now. |
| `errors/already_invited_recently` | Status `invite_sent` without a new invite. |
| `errors/cannot_invite_attendee`, `invalid_recipient`, `blocked_recipient`, `user_unreachable`, `no_connection_with_recipient`, profile 404 | Status `failed` with the reason. |
| Any other error | Retry once on the next tick, then `failed`. |
| 3 limit, 5xx or network errors in a row, with no successful send in between | Auto-pause all sending and show a banner on the dashboard. |

## 11. Dashboard

- Counters by status at the top; pause/limit banner when relevant.
- One table: name, headline, URL, status, last action + date, next action + due date. Filter by status.
- Per-row actions: pause, retry (failed only; the lead goes back to the status it failed in), remove (deletes the lead but keeps its events, so caps stay correct; the person can be pasted again).
- Settings page: templates with preview, delays, caps, active window.
- No reply notifications in v1; the "Replied" filter is the inbox.

## 12. Statuses

`queued`, `invite_sent`, `already_connected`, `accepted`, `messaged`, `followup_1`, `followup_2`, `replied`, `no_response`, `invite_expired`, `failed`

## 13. Safety and reliability

- `DRY_RUN=true` runs the full flow, caps and templates, but calls no Unipile write endpoint. The dashboard shows "would send: <rendered text>". Profile fetches still happen.
- Each tick takes a lease lock: a conditional update of `tick_lock_until` on the single app-state row. Neon's HTTP driver has no sessions, so session advisory locks do not apply. A tick that cannot take the lock exits immediately, so ticks never overlap. A crashed tick's lease expires after 4 minutes.
- All pending work is stored as rows with a `due_at`; a missed tick only delays work.
- Every action sent and every webhook received is logged in an `events` table for debugging.

## 14. Cost

- Unipile: €49/month (covers up to 10 accounts), after a 7-day free trial.
- Vercel Hobby, Neon free tier, cron-job.org: free.

## 15. References

- Unipile docs index: https://developer.unipile.com/llms.txt
- Provider limits: https://developer.unipile.com/docs/provider-limits-and-restrictions
- Invitations: https://developer.unipile.com/docs/invite-users
- Detecting accepted invitations: https://developer.unipile.com/docs/detecting-accepted-invitations
- Sending messages: https://developer.unipile.com/docs/send-messages
- New messages webhook: https://developer.unipile.com/docs/new-messages-webhook
