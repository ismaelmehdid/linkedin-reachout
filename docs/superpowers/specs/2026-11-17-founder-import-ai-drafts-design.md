# Founder import and AI-written drafts — design

Date: 2026-11-17. Status: approved by the owner ("build it right away").

## Intent

The owner just moved from Paris to San Francisco and is looking for a role scaling an early-stage startup. A separate scraper (`~/Desktop/scrapper`) collects YC startups from Work at a Startup: the companies, their founders (with LinkedIn URLs) and their open engineering jobs. The owner wants to upload that output into LinkedIn Reachout and contact every founder with a connection request whose note is written for that founder by OpenAI, from the company and its jobs. After the founder accepts, the first message is also written by the AI and carries the full pitch. The goal of every conversation is a coffee at the founder's office.

The owner's pitch, in the owner's words:

- made the bold move of moving from Paris to San Francisco a few days after finishing school;
- looking to scale an early-stage startup;
- recently won an Anthropic hackathon and a YC hackathon;
- lives on Folsom St, so would love to grab a coffee at their office.

The owner's LinkedIn account sends unlimited invites with notes of up to 300 characters. It has no unlimited InMail, so nothing is sent to a founder before they accept; the first message goes out only once they are a connection, which the engine already guarantees.

## Goals

- Upload the scraper's files from the dashboard: `companies.json` alone, or `founders.csv` together with `jobs.csv` (they hold the same data; any combination of the three is accepted).
- Every founder with a LinkedIn profile URL becomes a lead, with the founder's name, bio, company and matching jobs kept on the lead as context.
- For each such lead, the AI writes two drafts: the invite note (≤ 300 characters) and the first message.
- The owner can read, edit and regenerate both drafts in the dashboard before pressing Start.
- The engine sends the lead's drafts instead of the invite-note and first-message templates. Follow-ups 1 and 2 stay on the owner's templates.

## Non-goals

- AI-written follow-ups.
- Running generation in the background (cron tick) or at send time.
- Scraping, enriching or refreshing data from the web. The upload is the only source.
- Any change to pacing, caps, detection or the sequence itself.

## Anti-goals (a failure even if it works)

- A note or message that states something untrue about the owner or the founder. The AI uses only the pitch and the uploaded context; it invents no shared history, no mutual friends, no compliments on things it was not told.
- A draft that reads like a mass template or a sales pitch: generic praise, buzzwords, emoji, hashtags.
- A lead sent with an empty, cut-off, over-length or failed draft. A lead whose draft is not ready is never invited.
- An invite or message going out because generation failed silently and the engine fell back to the template for a lead that was meant to get an AI draft.
- Breaking the app when `OPENAI_API_KEY` is absent: login, dashboard, tick and webhooks must keep working; only generation reports the missing key.

## Constraints

- Next.js 16 (read `node_modules/next/dist/docs/` before writing code), Drizzle, Neon in production and PGlite locally, Vercel. Code, comments, identifiers, commits and docs in English.
- A server action body is limited to 1 MB by default (`serverActions.bodySizeLimit`) and a Vercel request body to 4.5 MB. `companies.json` is about 4 MB, mostly job descriptions.
- One generation takes roughly 20 to 60 seconds with a reasoning model. A server action runs under the page's `maxDuration`.
- OpenAI model: `gpt-6.2-astra`, OpenAI's flagship since 2026-11-17 ($8 / $40 per 1M input / output tokens). It supports the Responses API, structured outputs and `reasoning.effort` (`low`, `medium`, `high`, `xhigh`, `max`). Its predecessor did not accept a custom `temperature`, so none is sent. Expected total for 264 founders: roughly $30 to $60.
- The key lives in `OPENAI_API_KEY` (in `.env.local` locally, in the Vercel project settings in production). It is optional for the app as a whole.

## Approaches

Which messages the AI writes:

- A. Invite note only, with all four pitch points squeezed into 300 characters. Rejected: cramped, and the note reads like a pitch to a stranger.
- **B. Invite note and first message (chosen by the owner).** The note is a short hook; the first message carries the full pitch and names a specific job.
- C. All four messages. Rejected: more cost, and generic follow-up bumps work fine.

When the drafts are written:

- **1. From the dashboard (chosen by the owner).** A "Generate drafts" button works through the pending leads and shows progress. Each lead is one server request, so no request comes near a time limit. The tab must stay open; pressing the button again continues where it stopped.
- 2. In the cron tick. Rejected: the tick's 110 s budget is already spent on sends, ticks run only in active hours, and money is spent while nobody watches.
- 3. At send time. Rejected: the owner never sees a draft before it goes out.

## Design

### Upload

- The dashboard gets a second form, "Upload founders", next to the URL textarea, with one file input that accepts several files (`.json`, `.csv`).
- The files are parsed in the browser by a pure module (no Node imports), shared with the tests:
  - `companies.json`: `{ companies: { [slug]: { name, batch, website, url, one_liner, description, hiring_description, team_size, founders: [{ name, linkedin, bio, past_companies }], jobs: [{ id, title, description, url, locations, remote, min_experience, salary, equity, category, matches_filters }] } } }`.
  - `founders.csv`: `company, batch, website, one_liner, description, hiring_description, company_url, founder_name, linkedin, founder_bio, past_companies, matching_jobs`.
  - `jobs.csv`: `company, website, job_title, category, location, remote, min_experience, salary, equity, job_url, description`. Jobs join founders on the company name.
  - CSV fields can hold quoted commas, quotes and line breaks (RFC 4180); the parser handles them.
  - Files are recognised by content (a JSON object with `companies`, or a CSV whose header has `founder_name` / `job_title`), not by file name.
- The result is a list of founder records: founder (name, LinkedIn URL, bio, past companies) and company (name, batch, website, one-liner, description, hiring description, team size, jobs). Only coding jobs are kept: a job whose `category` is one of `founding_engineer`, `fullstack`, `forward_deployed`, `product_engineer`, `ai_engineer`, `member_of_technical_staff`, `infra_devops`, `data_engineering`, `backend` (the categories the scraper writes to `jobs.csv`), and, from `companies.json`, whose `matches_filters` is true. The same rule applies to both files, so the same founder gets the same context whichever file is uploaded. A company with no such job keeps none: the AI writes about the company and names no job. Each job description is cut to its first 3,000 characters.
- When `companies.json` and the CSVs are both given, `companies.json` wins for any company it holds.
- The browser sends the records to a server action in batches small enough to stay well under the 1 MB body limit. The server checks every record with zod, then imports it.
- Import uses the existing rules (spec §5): the URL is parsed with `parseLinkedInProfileUrl`, a founder whose slug is already a lead is skipped and reported as a duplicate, an invalid URL is reported with the founder's name. A founder without a LinkedIn URL is reported as skipped.
- The founder's name is split into `first_name` (first word) and `last_name` (the rest) so the table shows names before the profile fetch; the profile fetch overwrites them as today.
- The summary after upload says how many leads were added, how many were duplicates, and how many were skipped (no or invalid URL).

### Storage

New columns on `leads` (one migration, `drizzle/0002_*`):

- `context` (jsonb, nullable): the founder and company record above. Null for a lead pasted as a URL.
- `draft_status` (text, not null, default `none`): `none` (a pasted lead, uses the templates), `pending`, `generating`, `ready` (written by the AI, not yet read by the owner), `approved` (the owner approved or edited it: the only state the engine sends), `failed`.
- `invite_note_draft`, `first_message_draft` (text, nullable).
- `draft_error` (text, nullable): why the last generation failed.
- `draft_claimed_at` (timestamptz, nullable): when a generation took the lead, so a run that died can be taken again.

An uploaded lead starts with `draft_status = pending`.

### Settings

- Settings gets an "About me" textarea (`settings.aboutMe`, default empty), where the owner writes the pitch the AI uses. Generation refuses to start while it is empty.
- Nothing about the owner is committed to the repository; the owner pastes the pitch in Settings.

### Generation

- The dashboard shows "Drafts: N ready, N pending, N failed" and a **Generate drafts** button. The button runs a small pool of workers in the browser (4 at a time); each worker calls a server action that takes one lead, generates its drafts, saves them and returns the new counts, until no lead is left to take. A **Stop** button stops taking new leads. Progress updates after each lead.
- The server action takes a lead atomically: one `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` that moves a `pending` lead, or a `generating` lead claimed more than 5 minutes ago, to `generating`. Failed leads are not taken by the button; each has a **Regenerate** button, and a **Retry failed** button moves every failed lead back to `pending`.
- Only `queued` leads are taken. A lead past the invite keeps its drafts.
- The dashboard page sets `maxDuration` high enough for one generation (120 s); the OpenAI request has its own timeout below that (100 s).
- The OpenAI call uses the Responses API with `model: gpt-6.2-astra`, `reasoning: { effort: 'high' }` and a JSON-schema output `{ inviteNote: string, firstMessage: string }`. The model id can be overridden with `OPENAI_MODEL`.
- The prompt holds: the owner's "About me"; the founder (name, bio, past companies); the company (name, YC batch, one-liner, description, team size, website, hiring pitch); the matching jobs (title, category, location, salary, equity, description). It asks for:
  - **Invite note**: at most 280 characters (headroom under LinkedIn's 300), addressed to the founder by first name, one concrete hook tied to this company or one of its jobs, who the owner is in a few words, and the coffee ask. Plain, warm, direct; no emoji, hashtags, links or em dashes.
  - **First message**: sent after the founder accepts; about 500 to 900 characters; thanks them for connecting, gives the full pitch (Paris to San Francisco right after school, wants to scale an early-stage startup, the Anthropic and YC hackathon wins), ties it to the most relevant job by its title when the company has one, and asks for a coffee at their office, mentioning the owner lives on Folsom St.
  - The first message never thanks them for connecting or refers to the invite: a founder who was already a connection gets it with no invite before it, so it must read true either way.
  - Both: written in English, use only facts from the pitch and the context, no `{{` and no placeholders.
- The result is checked in code: both texts non-empty after trimming, the note at most 300 characters, no `{{`. A note over the limit gets one retry with the length in the request; a second failure sets `failed` with `draft_error = note_too_long: N/300`. Any OpenAI error sets `failed` with a short reason (`missing_api_key`, `rate_limited`, `timeout`, `refused`, `invalid_output`, `openai_error: <status>`), never the key or the full response.
- The OpenAI client is a small `fetch` wrapper in `src/lib/openai/`, in the same style as the Unipile client, injected so tests use a fake. No SDK dependency.
- Generation does not depend on `DRY_RUN`: it never touches LinkedIn.

### Review and edit

- The lead table gets a "Draft" column: the draft status, and for a ready lead the first words of the note. Clicking a row opens both drafts in place, with a character counter on the note (limit 300), **Save** and **Regenerate**.
- The note can be edited and regenerated while the lead is `queued`. The first message can be edited while it has not been sent (statuses `queued`, `invite_sent`, `accepted`, `already_connected`). Saving an empty text, a note over 300 characters or a text with `{{` is refused.
- A generated draft is `ready`, which the engine does not send. Each row has **Approve**, and the dashboard has **Approve all ready drafts**; both move `ready` to `approved`. Saving an edit sets `approved`. Regenerating sets the lead back to `pending`, so a new draft always needs a new approval.

### Engine

- A `queued` lead is picked for an invite only when its `draft_status` is `none` or `approved` (in `pickDueLead` and in the planned-sends count). A pending, generating or failed lead waits in the queue without failing.
- For a lead with `draft_status = approved`:
  - the invite note sent is `invite_note_draft`, as written, with no template rendering; it is checked again against the 300-character limit right before the send;
  - the first message sent is `first_message_draft`, and the "already sent" check of §6 compares the chat against that text;
  - the pre-invite template check (spec §9) covers only follow-ups 1 and 2.
- A lead with `draft_status = none` behaves exactly as today.
- An approved lead whose draft is somehow empty at send time fails with `missing_draft`; it never falls back to a template.
- Start blockers: unchanged. The invite-note and first-message templates are still required, because pasted leads use them.

### Configuration and docs

- `OPENAI_API_KEY` (optional) and `OPENAI_MODEL` (optional, default `gpt-6.2-astra`) are read outside `parseEnv`, so their absence never fails the app. Both go in `.env.example`.
- `docs/spec.md` §5, §6, §9 and §11 and the README describe the upload, the drafts and the new variables.

## Left to the builder

- Component structure, file names, and where the CSV parser lives (it must stay a pure module).
- The exact prompt wording, within the rules above.
- The batch size of the upload action and the worker count, within the limits above.
- How the draft editor looks, as long as it fits the existing dashboard style.

## Calls made without the owner (check these)

- The pitch lives in a Settings field, not in code.
- `companies.json` wins over the CSVs; only matching jobs are sent to the AI; job descriptions are cut to 3,000 characters.
- Reasoning effort `high`, 4 parallel workers, a 280-character target for the note.
- Follow-ups stay on templates; the invite-note and first-message templates stay required for pasted leads.
- No AI call happens without the owner pressing a button.
- Builder-check rulings (2026-11-17): coding jobs only, the same rule for both files; an explicit approval before any AI draft is sent; a first message that reads true for an already-connected founder.
