# Rulings made while building v1

The plan in `docs/superpowers/plans/2026-11-17-linkedin-reachout.md` was executed by a team of agents: one implementer per task, one reviewer for all 17 tasks, a separate final reviewer for the whole branch, and one fix wave. The controller of that team decided the points below without asking the owner, so that the work did not stop. Each line says what was decided, why, and what it costs if the decision is wrong. They are in the order they were made. `docs/spec.md` already reflects every one of them.

Read this list once. Anything here can be changed.

## How the work was organised

1. **Work on branch `feat/v1` in this folder, with no separate worktree for the plan.** The repo had no commits, so there was nothing to isolate from. If wrong: move the branch.
2. **Independent tasks were built in parallel, each in its own git worktree, and merged after review.** The owner asked for team mode. If wrong: a merge conflict, fixed by hand (it happened once, in `next.config.ts`).
3. **The controller committed the spec, the plan and later doc changes itself.** If wrong: extra docs commits.
4. **Commit trailers name the model that wrote each commit**, not one fixed model. If wrong: trailers differ between commits.
5. **Some tasks started on top of a task that was built but not yet reviewed**, to save time (Tasks 9 to 16). If wrong: a fix round on the later task. It did not happen.
6. **A fresh reviewer on the most capable model did the whole-branch review**, not the reviewer of the 17 tasks, so that the last look was not anchored on its own approvals. If wrong: the cost of one more agent.
7. **One config line was changed by the controller, not by an implementer**: the Vitest hook timeout went from 10 s to 30 s, because test setup timed out when several agents ran suites at once. If wrong: revert one line.

## Platform and tooling

8. **Node 22.12 or newer** (the plan said Node 20). Vitest 5 does not run on Node 20, which is past end of life. If wrong: pin Vitest 4 and Node 20 types.
9. **Next.js Cache Components are off.** The scaffold turned them on. Every page here is rendered per request, behind a login, from live data. If wrong: turn the flag back on and add Suspense boundaries.
10. **"No row matched" is detected with `RETURNING`, never with a row count.** Neon and the test database report row counts differently, so a count check would pass the tests and fail in production. If wrong: nothing; this is strictly safer.
11. **The tick lock is a lease in the database row, not a Postgres advisory lock.** Neon's HTTP driver has no sessions. If wrong: nothing observable.
12. **The database connection is kept on `globalThis` in development**, so a hot reload never opens the local database twice. If wrong: nothing in production.

## Lead input

13. **Profile links with a two-letter language suffix are accepted** (`/in/jane-doe/fr`). They are the same profile. If wrong: one regex change back to the strict form.
14. **Two imports that overlap (a double click) never show an error.** If wrong: nothing.
15. **The same person under two links is caught after the profile fetch** and the second lead fails with `duplicate_person`; the check ignores the lead itself, so a retried lead is not its own duplicate. If wrong: nothing.

## Templates and settings

16. **A template can never put raw `{{` into a sent message.** A fallback may not contain braces, and a rendered text that still contains `{{` (for example from a lead's own headline) fails the lead. If wrong: a lead whose headline contains `{{` is not contacted.
17. **A closed tag with a wrong or wrong-case name is reported as an unknown variable**, not as an unclosed tag. If wrong: nothing.
18. **A known variable in single braces, such as `{first_name}`, is refused at save.** It would be sent as written. If wrong: nothing.
19. **Saving settings replaces list values whole** (the active days), never position by position. If wrong: nothing.
20. **The random wait is capped at 100 seconds.** A tick has to finish inside Vercel's 180-second function limit. If wrong: nothing; a longer wait would get ticks killed.
21. **Caps cannot be set above LinkedIn's documented limits**: 80 invites a day, 200 per 7 days, 100 messages a day, 100 profile views a day; delays are at least 1 day. If wrong: the owner cannot set a higher cap without a code change.
22. **Start stays blocked while any template is still the shipped draft.** Saving other settings stays possible. If wrong: the owner must edit each of the four drafts before starting.

## Sending

23. **After the random wait, the tick reads the app state, the settings and the lead again**, and sends nothing if the app was paused, the active hours ended, the lead replied, was paused, was messaged by hand, or is no longer due. A template saved during the wait is the one sent. If wrong: nothing; every check can only stop a send.
24. **Before any message, the app finds and reads the chat with that person.** It stops on a reply. If its own text is already there, it records the step and does not send again. If the owner wrote something else by hand, that counts as a manual message. If wrong: a hand-written message is missed and the app still sends, which is the harmless direction.
25. **A message from the owner's own account counts as manual only when it is more than 2 minutes newer than the lead's last recorded action.** A late copy of the invite note must never be taken for a hand-written first message, because that would cancel the real first message. If wrong: a message typed by hand within those 2 minutes is not counted.
26. **A send that Unipile accepted is never retried**, even when its answer carries no id. If wrong: nothing; the alternative sends twice.
27. **Housekeeping does not use the tick's one sending slot**: marking no-response leads, up to 3 acceptance checks, at most 1 invite withdrawal, and the poll. If wrong: a few more profile views per tick.
28. **A tick skips sending when housekeeping took more than 30 seconds**, and shortens the random wait when time is short, so the function is never killed between a send and its record. If wrong: one tick sends nothing.
29. **Start and Pause each ask for a state; neither is a toggle.** A stale page showing "Pause" after an automatic pause must not restart sending. If wrong: nothing.
30. **Every lead update records when it happened and what the last action was.** The dashboard and the 2-minute rule depend on it. If wrong: nothing.

## Invites

31. **In dry run, the poll ignores dry-run invites.** Unipile never saw them, and re-checking them would spend real profile views. If wrong: nothing.
32. **An invite that leaves LinkedIn's sent list without the person connecting is marked `invite_expired`** after the poll found it missing and an hour passed. Declined invites and invites withdrawn by hand both do this, and re-checking them forever would eat the daily profile-view budget. If wrong: a pending invite is written off after a wrong read of the list, and a later acceptance is ignored. This is the first thing to harden; see "Left open".
33. **An invite is not withdrawn while its acceptance check is still pending.** If wrong: nothing.

## Errors

34. **A LinkedIn limit pauses the kind of action that hit it**, invites or messages, not only invites. If wrong: nothing.
35. **A Unipile outage (5xx, timeout) leaves the lead untouched** and counts toward the automatic pause after 3 errors in a row. If wrong: nothing; the alternative marks leads as failed during an outage.
36. **An account-level error (401, 403, disconnected account, expired credentials) pauses the app at once.** Otherwise leads fail one by one with no banner. If wrong: a 403 about a single lead pauses everything until that lead is removed; see "Left open".
37. **Five failed actions in a row with no successful send pause the app.** If wrong: an extra pause that Start clears.
38. **A retry delay of 0 from Unipile is not a pause**; the pause then runs to the next active day. If wrong: nothing.

## Access and configuration

39. **The app refuses weak secrets**: `APP_PASSWORD` under 16 characters, `CRON_SECRET` or `WEBHOOK_SECRET` under 32. The app is public and the only brake on password guessing is a 1-second wait. There is no login lockout: with 16 characters guessing is not feasible, and a lockout would let an attacker lock the owner out. If wrong: lower the numbers in `src/lib/env.ts`, or add a lockout.
40. **`/api/tick` accepts only `Authorization: Bearer <CRON_SECRET>`.** The spec had also allowed a plain header. If wrong: add the second form.
41. **`DRY_RUN` must be exactly `true` or `false`.** A typo or a missing variable used to mean live sending. If wrong: a deployment without `DRY_RUN` answers "misconfigured" until it is set.
42. **A misconfigured deployment answers `500 {"error":"misconfigured"}`** on the tick and webhook routes and names the variable in the function log. If wrong: nothing.
43. **`/api/tick` checks the database before answering**, so cron-job.org's failure e-mails work as monitoring. If wrong: nothing.

## Dashboard and guide

44. **The lead table shows each person's current role under the name.** The dry-run check of company and position needs a place to look. If wrong: one more line per row.
45. **Removing a lead keeps its events**, so the caps stay correct, and the person can be pasted again. It does not withdraw a pending invitation on LinkedIn. If wrong: nothing for the caps; the invitation stays pending.
46. **The event log shows the reason of each failed action and the outcome of each webhook.** If wrong: nothing.
47. **The guide schedules cron-job.org inside the active hours only.** A tick every 5 minutes around the clock keeps the Neon database awake and uses up the free tier around day 17. If wrong: budget for Neon's paid plan.

## Random spacing between sends (added after v1, branch `feat/random-pacing`)

The owner asked for random timestamps and spacing, so that sends do not follow a clock. Spec §8 "Spacing" describes the result. These points were decided without asking:

48. **The pause after a send adapts to the day.** Its average is the time left in the active hours divided by the sends still planned today, kept between 4 and 45 minutes; each pause is drawn between 50% and 150% of that. A fixed range would either fire a light day's sends in the first minutes or fail to fit a full day. If wrong: change the two numbers in Settings, or set them to 0 to turn spacing off.
49. **Each send is planned to the second, and the guide now asks for a tick every minute.** With a tick every 5 minutes every send would land within about 100 seconds after a 5-minute mark, which is a pattern of its own. If wrong: keep 5 minutes; sends are then up to about 3.5 minutes late.
50. **A tick waits for a planned moment that is up to 90 seconds away, whatever the random-wait setting is.** Otherwise lowering that setting would put every send on a tick boundary. If wrong: nothing; the wait stays inside the limits the tick was sized for.
51. **The first send of each day waits for a random moment in the first 45 minutes of the active hours**, and that value must be shorter than the active hours. If wrong: set it to 0.
52. **A follow-up is due after its days plus a random 0 to 3 hours**, also when the timer was restarted by a hand-written message. If wrong: set it to 0.
53. **After an invite withdrawal the next one waits a random 10 to 30 minutes.** With a tick every minute, withdrawals would otherwise run one per minute. If wrong: nothing; withdrawals are only delayed.
54. **A planned moment is trusted only as far ahead as the current settings could have planned it**, so shortening the pauses or turning spacing off applies on the next tick. If wrong: nothing.
55. **The next send is planned after every attempt, including a failed one.** If wrong: nothing; it only delays.
56. **Not built: varying the number of invites per day.** Sending exactly the daily cap every day is a regularity too, but varying it would lower the volume the owner asked to maximise. It is the owner's call.

Spacing lowers how regular the account looks. It does not make automation invisible, and it does not replace low volumes.

Two Minor points from the review of this task were left open: with a day-start value of 1 minute and pauses of 1 minute or less, a first send in the middle of the day can come a little earlier than planned; and when planning the next send fails right after an action error, nothing is logged.

## Login on a misconfigured server (added after the first deployment, branch `fix/login-misconfigured-message`)

The first deployment had three of the eight variables. The login form then answered with Next's error page ("This page couldn't load"), which names nothing. The owner asked for a readable message there. These points were decided without asking:

57. **A login on a misconfigured server answers with a message instead of failing.** The message points to the function log and names no variable; the log names it, as on the tick and webhook routes (ruling 42). No session is opened. If wrong: nothing.
58. **The message appears when the form is sent, not when the page opens.** The login page stays a static page. If wrong: the owner types a password once before reading the message.
59. **Nothing else changed: the request filter and the dashboard still let the error through.** A browser that already holds a session sees Next's error page while a variable other than `APP_PASSWORD` is wrong. A wrong `APP_PASSWORD` ends its session, and the login page then shows the message. A change to the request filter could not be tested on a real deployment here, and a mistake in it locks the owner out. If wrong: the owner reads "This page couldn't load" again in that case; the guide now says what it means.
60. **The guide now quotes the Neon URL in the migration command, and says what the dashboard error page means right after a login.** Both came up while diagnosing the first deployment: a Neon URL can contain `&`, where the shell cuts an unquoted command, and a dashboard that cannot read the database shows the same error page. If wrong: nothing.

## Founder import and AI drafts (added after the first deployment, branch `feat/founder-import`)

The owner asked to upload the YC founder scraper's output and contact each founder with an invite note and a first message written by OpenAI. The design is `docs/superpowers/specs/2026-11-17-founder-import-ai-drafts-design.md`; spec §5, §9, §10 and §11 describe the result. These points were decided without asking:

61. **The pitch lives in the "About me" setting, not in code.** Nothing about the owner is committed. If wrong: nothing; the owner pastes it in Settings.
62. **`companies.json` wins over the CSVs for a company both hold; only coding jobs are sent to the AI, by the same rule for both files; each job description is cut to 3,000 characters.** If wrong: change the category list or the cut in the upload parser.
63. **Reasoning effort `high`, four drafts written at once, and a note of 280 characters asked for** (headroom under LinkedIn's 300). If wrong: change the effort in the OpenAI client or `DRAFT_WORKERS` in `src/components/draft-run.ts`.
64. **Follow-ups stay on the templates, and the invite-note and first-message templates stay required for Start**, because pasted leads still use them. If wrong: nothing; write templates that suit pasted leads.
65. **No AI call happens without the owner pressing Generate drafts** (or Regenerate, then Generate drafts). Not in the tick, not at send time. If wrong: nothing; a draft is only written when asked.
66. **An explicit approval before any AI draft is sent.** A written draft is `ready`, which the engine never sends; Approve, Approve all ready drafts, or saving an edit makes it `approved`. A founder whose drafts are not approved waits in the queue and never falls back to a template. If wrong: press Approve all ready drafts after reading a sample.
67. **The first message reads true for a founder who was already a connection**: it never thanks them for accepting, since such a founder gets it with no invite before it. If wrong: nothing.
68. **The dashboard's workers call a route, `POST /api/drafts/generate`, not the server action.** Next dispatches server actions one at a time per browser, so four workers on the action would write one draft at a time (about two hours for 260 founders) and hold every Save and Approve behind a generation. The route checks the session itself and refuses a request whose `Origin` is not this host. The action stays, with the same code behind it. If wrong: nothing; the action can be used again by changing one line in the panel.
69. **Approve applies only to the note on screen.** If the draft was rewritten since the row was opened, approving is refused with "This draft changed since you opened it. Review it again.", and Approve is hidden while the texts are edited (saving the edit approves it). If wrong: nothing; it costs one more click.
70. **The table refreshes once a generation run ends, not after each draft.** The counts update after each draft. If wrong: reload the page to see new drafts during a run.

## Left open, for the owner

The final reviewer approved the branch for merge and listed these Minor points. None was fixed; there was one fix wave by design.

- **Harden the invite expiry (ruling 32)** before raising the caps: require two missing polls an hour apart, and distrust a poll that matches none of several pending invites.
- **Check the attendee of a looked-up chat** before writing into it, so a group thread or a wrong chat can never receive a message.
- **A 403 about one lead pauses the whole app** and returns on every Start until that lead is paused or removed. The banner then names the account, not the lead.
- **The count of failed actions survives Start**, so after the 5-failures pause each further failed lead pauses again until one send succeeds.
- **Three narrow cases in the pre-send check**: a first message with the same text as the invite note is never sent; a single hand-written message can go unseen when the invite note is not in the chat read; a follow-up whose record was lost can go out twice if the owner also wrote by hand afterwards.
- **A draft that was edited but still contains "[Write your first message here.]"** does not block Start.
- **A LinkedIn limit that is about one person** would pause invites each time that lead is picked. Not seen; watch for it.
- **The poll reads the whole sent list.** Unipile advises reading the first page only.
- **No logout, and no session revocation** other than changing the password.
- **The dashboard error page explains nothing.** It shows "This page couldn't load" to a logged-in browser while a variable other than `APP_PASSWORD` is wrong (ruling 59), and after login when the app cannot read the database. A page of our own could point to the function log.
- **Cosmetic**: the Live banner looks like a pause banner; a finished lead that was paused still shows Resume; a retried lead shows `failed` as its last action until its next action.

## Not decided here, because only the owner can

- **Vercel plan.** Hobby is for personal, non-commercial use. Commercial outreach needs Pro.
- **Timezone.** The default active hours are Monday to Friday, 08:30 to 19:00, `Europe/Paris`. Set them in Settings to where the leads are.
- **First live run.** Nothing in this branch has met a real Unipile response or the real Neon database. The guide's rehearsal, done once on the deployed app in dry run, is the first real test. Start the first live week with small caps, for example 5 invites a day.
