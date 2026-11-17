# LinkedIn Reachout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-user Next.js app on Vercel. It sends LinkedIn invites with personalized notes through Unipile, then a first message and two follow-ups, stops when the person replies, and tracks every lead on a dashboard.

**Architecture:** cron-job.org calls `/api/tick` every 5 minutes. Each call runs one engine tick: housekeeping first, then at most one outreach action (an invite or a message), inside the caps and the active window. `/api/webhooks/unipile` records replies and acceptances in the database and never calls Unipile. All state is in Postgres through Drizzle. The engine receives its clock, randomness, sleep and Unipile client as arguments, so tests run it against in-process PGlite with a fake Unipile client.

**Tech Stack:** Next.js (App Router, TypeScript, Tailwind), Drizzle ORM, `@neondatabase/serverless` (neon-http driver), `@electric-sql/pglite` (tests and local development), Zod, Luxon, Vitest.

**Spec:** `docs/spec.md`

## Global Constraints

- English only: code, comments, docs, commit messages, test names, UI copy.
- Node 22.12 or newer (Vitest 5 needs it). `package.json` records the floor in `engines`.
- Unipile API v1 only, always through `src/lib/unipile/client.ts`. Do not install `unipile-node-sdk`.
- No `db.transaction()`: the neon-http driver has no interactive transactions. Use single conditional statements.
- Code in `src/lib/engine/**` and `src/lib/webhooks/**` never calls `new Date()` without arguments, `Date.now()` or `Math.random()`. It uses `deps.now()`, `deps.random()`, `deps.sleep()`, or the `now`/`random` it receives.
- Insert every `events` row with an explicit `createdAt` equal to the injected now. Caps are counted from `events.createdAt`.
- Every engine update of a lead's status is compare-and-set: `WHERE id = <id> AND status = <status when read>`. If no row matches, a webhook changed the lead first. Accept that; do not retry.
- Never send text that still contains `{{`.
- Store timestamps as `timestamptz` (UTC). Do local-time math only through `src/lib/schedule/window.ts`.
- Defaults (spec §6, §8): 35 invites per day and 190 per rolling 7 days; 90 messages per day; 90 profile views per day; random wait 0–90 s; active window Mon–Fri 08:30–19:00 `Europe/Paris`; first message 60–180 min after acceptance; follow-up 1 after 2 days, follow-up 2 after 3 more, end after 3 more; invite expiry after 21 days; invite note at most 300 characters.
- Shared test values: `NOW = new Date('2026-11-17T09:00:00Z')` (a Tuesday, 10:00 in Paris). `random()` returns `0.5` unless a test says otherwise.
- Tests import `describe`, `it`, `expect`, `beforeEach` from `vitest`. Code blocks below omit imports.
- Work on branch `feat/v1`. Use Conventional Commit messages, each ending with the `Co-Authored-By` attribution line that your own session instructions give you.
- Before every commit, `npm test` and `npm run typecheck` pass.

## Review Focus

1. The same person pasted twice, under URLs that differ in letter case, or as a vanity slug and an `ACoA…` id: the person is contacted once. Tests: Task 3, Task 9.
2. A reply webhook lands while a tick is sending to the same lead: the lead ends `replied` and gets nothing more. Test: Task 10.
3. Unipile is down (5xx, timeouts) for an hour: no lead becomes `failed`, and sending auto-pauses after 3 errors in a row. Tests: Task 9, Task 12.
4. A lead's data breaks a later template (no `position` for a follow-up that needs it, or a long company name pushes the note past 300 characters): the lead fails before the invite goes out. Test: Task 9.
5. Unipile delivers the same webhook again (it retries up to 5 times): the final state is the same and nothing errors. Test: Task 13.

---

### Task 1: Project scaffold and environment parsing

**Files:**
- Create: Next.js scaffold at the repo root, `vitest.config.ts`, `src/lib/env.ts`, `src/lib/env.test.ts`, `.env.example`
- Modify: `package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces: `type Env = { unipileDsn: string; unipileApiKey: string; unipileAccountId: string; databaseUrl: string; appPassword: string; cronSecret: string; webhookSecret: string; dryRun: boolean }`, `parseEnv(source: Record<string, string | undefined>): Env`, `getEnv(): Env` (memoized `parseEnv(process.env)`). npm scripts `test`, `test:watch`, `typecheck`, `db:generate`, `db:migrate`.

- [ ] **Step 1: Branch and scaffold.** `create-next-app` refuses a folder that already has files (`docs/`), so scaffold in a temp folder and copy:

```bash
git checkout -b feat/v1
npx create-next-app@latest "$TMPDIR/reachout-scaffold" --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes
rsync -a --exclude .git --exclude node_modules "$TMPDIR/reachout-scaffold/" ./
npm install
npm install drizzle-orm @neondatabase/serverless @electric-sql/pglite zod luxon
npm install -D vitest drizzle-kit @types/luxon
```

- [ ] **Step 2: Tooling.** Scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"typecheck": "tsc --noEmit"`, `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"`. `vitest.config.ts`: environment `node`, include `src/**/*.test.ts`, alias `@` to `<root>/src`, `testTimeout: 20_000`. In `.gitignore`, add `.data/` and `!.env.example` (the scaffold's `.env*` rule would hide the example file).

- [ ] **Step 3: Write the failing test** `src/lib/env.test.ts`:

```ts
const full = {
  UNIPILE_DSN: 'api1.unipile.com:13111', UNIPILE_API_KEY: 'k', UNIPILE_ACCOUNT_ID: 'acc_1',
  DATABASE_URL: 'pglite:./.data/dev', APP_PASSWORD: 'pw', CRON_SECRET: 'cron', WEBHOOK_SECRET: 'hook',
};
it('parses every variable', () => {
  expect(parseEnv(full)).toEqual({
    unipileDsn: 'api1.unipile.com:13111', unipileApiKey: 'k', unipileAccountId: 'acc_1',
    databaseUrl: 'pglite:./.data/dev', appPassword: 'pw', cronSecret: 'cron', webhookSecret: 'hook', dryRun: false,
  });
});
it('reads DRY_RUN=true as true and any other value as false', () => {
  expect(parseEnv({ ...full, DRY_RUN: 'true' }).dryRun).toBe(true);
  expect(parseEnv({ ...full, DRY_RUN: '1' }).dryRun).toBe(false);
});
it('lists every missing variable in one error, empty strings included', () => {
  expect(() => parseEnv({ UNIPILE_DSN: 'x', UNIPILE_API_KEY: '' })).toThrow(
    'Missing environment variables: UNIPILE_API_KEY, UNIPILE_ACCOUNT_ID, DATABASE_URL, APP_PASSWORD, CRON_SECRET, WEBHOOK_SECRET',
  );
});
```

- [ ] **Step 4: Run** `npm test`. Expected: FAIL, cannot resolve `./env`.
- [ ] **Step 5: Implement** `parseEnv` and `getEnv` in `src/lib/env.ts`. Write `.env.example` with the 8 variables of spec §3, one comment line each; `DATABASE_URL=pglite:./.data/dev` as the local example.
- [ ] **Step 6: Run** `npm test && npm run typecheck && npm run build`. Expected: all pass.
- [ ] **Step 7: Commit** `chore: scaffold Next.js app with Vitest and env parsing`.

---

### Task 2: Database schema, migrations and clients

**Files:**
- Create: `drizzle.config.ts`, `src/db/schema.ts`, `src/db/types.ts`, `src/db/client.ts`, `src/test-utils/db.ts`, `src/db/schema.test.ts`, `drizzle/*` (generated)
- Modify: `next.config.ts` (`serverExternalPackages: ['@electric-sql/pglite']`)

**Interfaces:**
- Consumes: `getEnv()` (Task 1).
- Produces:
  - Enum `leadStatus` with the 11 statuses of spec §12. Types `LeadStatus`, `Lead = typeof leads.$inferSelect`, `NewLead = typeof leads.$inferInsert`, `EventRow = typeof events.$inferSelect`.
  - `type EventType = 'profile_view' | 'invite_sent' | 'message_sent' | 'invite_withdrawn' | 'webhook_received' | 'action_failed'`.
  - `type LastAction = 'invite_sent' | 'already_connected' | 'accepted' | 'first_message' | 'followup_1' | 'followup_2' | 'reply_received' | 'manual_message' | 'no_response' | 'invite_withdrawn' | 'failed'`.
  - Tables `leads`, `events`, `settingsTable`, `appStateTable`.
  - `type Db = PgDatabase<PgQueryResultHKT, typeof schema>` in `src/db/types.ts`.
  - `getDb(): Promise<Db>` in `src/db/client.ts`, memoized. If `DATABASE_URL` starts with `pglite:`, it opens PGlite in that folder and runs the migrations in `./drizzle` once. Otherwise it uses `drizzle-orm/neon-http`.
  - `createTestDb(): Promise<Db>`: in-memory PGlite with migrations applied. If TypeScript rejects the PGlite database as `Db`, cast inside this helper only.

Columns (every timestamp is `timestamp(..., { withTimezone: true })`):
- `leads`: `id` serial PK; `slug` text not null, with a unique index on `lower(slug)`; `linkedin_url` text not null; `provider_id` text unique; `public_identifier`, `first_name`, `last_name`, `headline`, `company`, `position`, `location` text; `status` not null, default `queued`; `failure_reason` text; `failed_from_status` (`leadStatus`); `retry_count` int not null, default 0; `paused` bool not null, default false; `invitation_id`, `chat_id` text; `acceptance_check_pending` bool not null, default false; `invite_sent_at`, `sequence_started_at`, `next_action_at`, `last_action_at` timestamps; `last_action` text typed `LastAction`; `created_at`, `updated_at` not null, default now. Index on `(status, next_action_at)`.
- `events`: `id` serial PK; `lead_id` int referencing `leads.id` with `on delete set null`; `type` text not null typed `EventType`; `payload` jsonb not null, default `{}`; `created_at` not null, default now. Index on `(type, created_at)`.
- `settings`: `id` int PK default 1; `value` jsonb not null; `updated_at`.
- `app_state`: `id` int PK default 1; `running` bool not null, default false; `pause_reason` text; `invites_paused_until`, `messages_paused_until`, `next_invite_poll_at`, `tick_lock_until` timestamps; `consecutive_errors` int not null, default 0.

- [ ] **Step 1: Write the failing tests** `src/db/schema.test.ts`:

```ts
const url = (slug: string) => `https://www.linkedin.com/in/${slug}`;
it('applies migrations and stores a lead with defaults', async () => {
  const db = await createTestDb();
  const [lead] = await db.insert(leads).values({ slug: 'jane-doe', linkedinUrl: url('jane-doe') }).returning();
  expect(lead).toMatchObject({ status: 'queued', retryCount: 0, paused: false, acceptanceCheckPending: false });
});
it('rejects a second lead whose slug differs only by case', async () => {
  const db = await createTestDb();
  await db.insert(leads).values({ slug: 'jane-doe', linkedinUrl: url('jane-doe') });
  await expect(db.insert(leads).values({ slug: 'Jane-Doe', linkedinUrl: url('Jane-Doe') })).rejects.toThrow();
});
it('rejects two leads with the same provider id', async () => {
  const db = await createTestDb();
  await db.insert(leads).values({ slug: 'a', linkedinUrl: url('a'), providerId: 'ACoJane' });
  await expect(db.insert(leads).values({ slug: 'b', linkedinUrl: url('b'), providerId: 'ACoJane' })).rejects.toThrow();
});
it('keeps events when their lead is deleted', async () => {
  const db = await createTestDb();
  const [lead] = await db.insert(leads).values({ slug: 'a', linkedinUrl: url('a') }).returning();
  await db.insert(events).values({ leadId: lead.id, type: 'invite_sent', createdAt: new Date('2026-11-17T09:00:00Z') });
  await db.delete(leads).where(eq(leads.id, lead.id));
  expect((await db.select().from(events))[0].leadId).toBeNull();
});
```

- [ ] **Step 2: Run** `npm test -- src/db`. Expected: FAIL, cannot resolve `@/db/schema`.
- [ ] **Step 3: Implement** the schema, `drizzle.config.ts` (`schema: './src/db/schema.ts'`, `out: './drizzle'`, `dialect: 'postgresql'`, url from `DATABASE_URL`), then run `npm run db:generate`. Implement `getDb` and `createTestDb`.
- [ ] **Step 4: Run** `npm test -- src/db`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add database schema, migrations and clients`.

---

### Task 3: LinkedIn URL parsing and lead import

**Files:**
- Create: `src/lib/leads/url.ts`, `src/lib/leads/url.test.ts`, `src/lib/leads/import.ts`, `src/lib/leads/import.test.ts`

**Interfaces:**
- Consumes: `Db`, `leads` (Task 2).
- Produces: `parseLinkedInProfileUrl(input: string): { ok: true; slug: string; url: string } | { ok: false; error: string }`; `importLeads(db: Db, text: string, now: Date): Promise<ImportResult>`; `type ImportResult = { added: number; duplicates: string[]; invalid: { line: string; error: string }[] }`.

URL rules (spec §5):
- Trim the input. Add `https://` when there is no scheme.
- The host is `linkedin.com`, `www.linkedin.com` or a two-letter subdomain such as `fr.linkedin.com`.
- The path is `/in/<slug>`, with an optional trailing `/`. Ignore the query and the hash.
- Percent-decode the slug and keep its case, because `ACoA…` ids are case-sensitive.
- `url` is `https://www.linkedin.com/in/<encodeURIComponent(slug)>`.
- Errors are exactly `not a LinkedIn URL` (wrong host) or `not a profile URL (expected linkedin.com/in/...)` (right host, wrong path).

Import: skip blank lines. Invalid lines go to `invalid`. Duplicates, compared on `lower(slug)` both inside the paste and against the database, go to `duplicates` as the pasted slug. Insert the rest with status `queued` and `nextActionAt = now`.

- [ ] **Step 1: Write the failing tests:**

```ts
// url.test.ts
it.each([
  ['https://www.linkedin.com/in/jane-doe', 'jane-doe'],
  ['linkedin.com/in/jane-doe/', 'jane-doe'],
  ['https://fr.linkedin.com/in/jane-doe?utm_source=x#top', 'jane-doe'],
  ['  www.linkedin.com/in/ACoAABcdEf  ', 'ACoAABcdEf'],
  ['https://www.linkedin.com/in/j%C3%A9r%C3%B4me', 'jérôme'],
])('accepts %s', (input, slug) => expect(parseLinkedInProfileUrl(input)).toMatchObject({ ok: true, slug }));
it('builds a canonical URL', () =>
  expect(parseLinkedInProfileUrl('linkedin.com/in/jane-doe/')).toEqual({ ok: true, slug: 'jane-doe', url: 'https://www.linkedin.com/in/jane-doe' }));
it.each([
  ['https://www.linkedin.com/company/acme', 'not a profile URL (expected linkedin.com/in/...)'],
  ['https://www.linkedin.com/sales/lead/ACwAA,NAME_SEARCH', 'not a profile URL (expected linkedin.com/in/...)'],
  ['https://www.linkedin.com/in/jane-doe/details/experience', 'not a profile URL (expected linkedin.com/in/...)'],
  ['https://evil-linkedin.com/in/jane', 'not a LinkedIn URL'],
  ['hello', 'not a LinkedIn URL'],
])('rejects %s', (input, error) => expect(parseLinkedInProfileUrl(input)).toEqual({ ok: false, error }));

// import.test.ts — db = await createTestDb() in beforeEach
it('adds new profiles as queued and due now', async () => {
  expect(await importLeads(db, 'linkedin.com/in/a\n\n linkedin.com/in/b ', NOW)).toEqual({ added: 2, duplicates: [], invalid: [] });
  const rows = await db.select().from(leads);
  expect(rows.map((r) => [r.slug, r.status, r.nextActionAt])).toEqual([['a', 'queued', NOW], ['b', 'queued', NOW]]);
});
it('skips people already in the database, whatever their status or letter case', async () => {
  await db.insert(leads).values({ slug: 'jane-doe', linkedinUrl: 'https://www.linkedin.com/in/jane-doe', status: 'failed' });
  expect(await importLeads(db, 'linkedin.com/in/Jane-Doe', NOW)).toEqual({ added: 0, duplicates: ['Jane-Doe'], invalid: [] });
});
it('skips duplicates inside the same paste', async () =>
  expect(await importLeads(db, 'linkedin.com/in/a\nhttps://www.linkedin.com/in/A/', NOW)).toEqual({ added: 1, duplicates: ['A'], invalid: [] }));
it('reports invalid lines and still adds the valid ones', async () =>
  expect(await importLeads(db, 'linkedin.com/company/acme\nlinkedin.com/in/a', NOW)).toEqual({
    added: 1, duplicates: [], invalid: [{ line: 'linkedin.com/company/acme', error: 'not a profile URL (expected linkedin.com/in/...)' }],
  }));
```

- [ ] **Step 2: Run** `npm test -- src/lib/leads`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** both modules. Use `new URL()` for parsing.
- [ ] **Step 4: Run** `npm test -- src/lib/leads`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: parse LinkedIn profile URLs and import leads`.

---

### Task 4: Template rendering

**Files:**
- Create: `src/lib/templates/render.ts`, `src/lib/templates/render.test.ts`

**Interfaces:**
- Produces:
  - `TEMPLATE_VARIABLES = ['first_name', 'last_name', 'headline', 'company', 'position', 'location'] as const` and `type TemplateVariable`.
  - `type TemplateValues = Partial<Record<TemplateVariable, string | null>>`.
  - `type RenderResult = { ok: true; text: string } | { ok: false; reason: 'missing_variable'; missing: string[] } | { ok: false; reason: 'invalid_syntax' }`.
  - `renderTemplate(template: string, values: TemplateValues): RenderResult`.
  - `type TemplateIssue = { kind: 'empty' } | { kind: 'unknown_variable'; name: string } | { kind: 'unclosed_tag' }` and `validateTemplate(template: string): TemplateIssue[]`.
  - `INVITE_NOTE_MAX_LENGTH = 300`.
- The module is pure, with no Node or DB imports: the settings page imports it in a client component (Task 16).

Grammar:
- A tag is `{{`, optional spaces, a name, optional spaces, an optional `|fallback`, then `}}`.
- A name is one or more characters other than whitespace, `|`, `{` and `}`. Names are case-sensitive, and only the six names above are known. A complete tag with any other name (for example `{{First_Name}}`) is an unknown variable: `unknown_variable` in `validateTemplate`, missing in `renderTemplate`. It is not an unclosed tag.
- The fallback is any characters except `{` and `}`, trimmed. A fallback that contains `{{` makes the template invalid: `unclosed_tag` in `validateTemplate`, `invalid_syntax` in `renderTemplate`.
- A value is missing when it is null, undefined or only whitespace; inserted values are trimmed.
- `missing` keeps the order of first appearance, without repeats.
- A `{{` without a matching tag gives `invalid_syntax`. So does a rendered text that still contains `{{`, for example because a lead's own value contains it: `renderTemplate` never returns `ok: true` with `{{` in the text.

- [ ] **Step 1: Write the failing tests:**

```ts
const values = { first_name: 'Jane', company: 'Acme', location: '  ' };
it('replaces variables, with or without spaces in the tag', () =>
  expect(renderTemplate('Hi {{first_name}} at {{ company }}', values)).toEqual({ ok: true, text: 'Hi Jane at Acme' }));
it('uses the fallback when the value is missing or blank', () =>
  expect(renderTemplate('{{location|your city}} / {{headline| there }}', values)).toEqual({ ok: true, text: 'your city / there' }));
it('allows an empty fallback', () => expect(renderTemplate('Hi{{last_name|}}!', values)).toEqual({ ok: true, text: 'Hi!' }));
it('reports every missing variable once, in order', () =>
  expect(renderTemplate('{{last_name}} {{position}} {{first_name}} {{last_name}}', values))
    .toEqual({ ok: false, reason: 'missing_variable', missing: ['last_name', 'position'] }));
it('treats an unknown variable as missing', () =>
  expect(renderTemplate('{{firstname}}', values)).toEqual({ ok: false, reason: 'missing_variable', missing: ['firstname'] }));
it('refuses a template with an unclosed tag', () =>
  expect(renderTemplate('Hi {{first_name', values)).toEqual({ ok: false, reason: 'invalid_syntax' }));
it('accepts a valid template', () => expect(validateTemplate('Hi {{first_name|there}}')).toEqual([]));
it('flags empty templates', () => expect(validateTemplate('  \n ')).toEqual([{ kind: 'empty' }]));
it('flags unknown variables', () =>
  expect(validateTemplate('{{firstname}} {{company}}')).toEqual([{ kind: 'unknown_variable', name: 'firstname' }]));
it('flags unclosed tags', () => expect(validateTemplate('Hi {{first_name')).toEqual([{ kind: 'unclosed_tag' }]));
```

- [ ] **Step 2: Run** `npm test -- src/lib/templates`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/lib/templates/render.ts`.
- [ ] **Step 4: Run** `npm test -- src/lib/templates`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: render message templates with variables and fallbacks`.

---

### Task 5: Active window and local time math

**Files:**
- Create: `src/lib/schedule/window.ts`, `src/lib/schedule/window.test.ts`

**Interfaces:**
- Produces:
  - `type ActiveWindow = { days: number[]; start: string; end: string; timezone: string }`. `days` are ISO weekdays (1 = Monday … 7 = Sunday). `start` and `end` are local `HH:MM`; start is inclusive, end exclusive.
  - `isInActiveWindow(now: Date, w: ActiveWindow): boolean`.
  - `nextWindowStart(now: Date, w: ActiveWindow): Date`: `now` itself when inside the window, otherwise the next window opening.
  - `nextActiveDayStart(now: Date, w: ActiveWindow): Date`: the window opening on the first active day after today's local date.
  - `startOfLocalDay(now: Date, timezone: string): Date`.
  - `addLocalDays(date: Date, days: number, timezone: string): Date`: same local time, `days` calendar days later.
- Implement with Luxon (`DateTime.fromJSDate(date, { zone })`).

- [ ] **Step 1: Write the failing tests:**

```ts
const W = { days: [1, 2, 3, 4, 5], start: '08:30', end: '19:00', timezone: 'Europe/Paris' };
const d = (iso: string) => new Date(iso);
it('opens at 08:30 and closes at 19:00 Paris time', () => {
  expect(isInActiveWindow(d('2026-11-17T07:30:00Z'), W)).toBe(true);
  expect(isInActiveWindow(d('2026-11-17T07:29:59Z'), W)).toBe(false);
  expect(isInActiveWindow(d('2026-11-17T18:00:00Z'), W)).toBe(false);
  expect(isInActiveWindow(d('2026-11-21T10:00:00Z'), W)).toBe(false); // Saturday
});
it('finds the next window opening', () => {
  expect(nextWindowStart(d('2026-11-17T10:00:00Z'), W)).toEqual(d('2026-11-17T10:00:00Z'));
  expect(nextWindowStart(d('2026-11-17T05:00:00Z'), W)).toEqual(d('2026-11-17T07:30:00Z'));
  expect(nextWindowStart(d('2026-11-17T19:00:00Z'), W)).toEqual(d('2026-11-18T07:30:00Z'));
  expect(nextWindowStart(d('2026-11-20T18:30:00Z'), W)).toEqual(d('2026-11-23T07:30:00Z')); // Friday evening to Monday
});
it('handles the March 2027 change to summer time', () =>
  expect(nextWindowStart(d('2027-03-26T18:00:00Z'), W)).toEqual(d('2027-03-29T06:30:00Z')));
it('finds the start of the next active day', () => {
  expect(nextActiveDayStart(d('2026-11-17T10:00:00Z'), W)).toEqual(d('2026-11-18T07:30:00Z'));
  expect(nextActiveDayStart(d('2026-11-20T10:00:00Z'), W)).toEqual(d('2026-11-23T07:30:00Z'));
});
it('computes the local start of day', () => {
  expect(startOfLocalDay(d('2026-11-17T22:30:00Z'), 'Europe/Paris')).toEqual(d('2026-11-16T23:00:00Z'));
  expect(startOfLocalDay(d('2026-11-17T23:30:00Z'), 'Europe/Paris')).toEqual(d('2026-11-17T23:00:00Z'));
});
it('adds calendar days at the same local time across a time change', () =>
  expect(addLocalDays(d('2027-03-27T09:00:00Z'), 2, 'Europe/Paris')).toEqual(d('2027-03-29T08:00:00Z')));
```

- [ ] **Step 2: Run** `npm test -- src/lib/schedule`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/lib/schedule/window.ts`.
- [ ] **Step 4: Run** `npm test -- src/lib/schedule`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add active window and local time helpers`.

---

### Task 6: Settings

**Files:**
- Create: `src/lib/settings/settings.ts`, `src/lib/settings/settings.test.ts`, `src/lib/settings/repo.ts`, `src/lib/settings/repo.test.ts`

**Interfaces:**
- Consumes: `ActiveWindow` (Task 5), `validateTemplate`, `INVITE_NOTE_MAX_LENGTH` (Task 4), `Db`, `settingsTable` (Task 2).
- Produces:
  - `type Settings = { templates: { inviteNote: string; firstMessage: string; followup1: string; followup2: string }; templatesSaved: boolean; delays: { firstMessageMinMinutes: number; firstMessageMaxMinutes: number; followup1Days: number; followup2Days: number; finishDays: number; inviteExpiryDays: number }; caps: { invitesPerDay: number; invitesPerWeek: number; messagesPerDay: number; profileViewsPerDay: number; jitterMaxSeconds: number }; window: ActiveWindow }`.
  - `DEFAULT_SETTINGS: Settings`, with the Global Constraints values and `templatesSaved: false`.
  - `parseSettings(raw: unknown): Settings`: deep-merges `raw` over `DEFAULT_SETTINGS`, then checks types with Zod (numbers are `.int().min(0)`). It throws `ZodError` on bad types. Do not rely on nested Zod `.default()`, whose behavior differs between Zod 3 and 4.
  - `validateSettings(s: Settings): string[]`.
  - `startBlockers(s: Settings): string[]`.
  - `getSettings(db: Db): Promise<Settings>`: returns `DEFAULT_SETTINGS` when no row exists.
  - `saveSettings(db: Db, input: unknown): Promise<{ ok: true; settings: Settings } | { ok: false; errors: string[] }>`. Zod issues become `<dotted.path>: <zod message>`. It stores the settings with `templatesSaved: true`.
- Placeholder templates (exact copy): invite note `Hi {{first_name}}, I came across your profile and would be glad to connect.`; first message `Thanks for connecting, {{first_name}}! [Write your first message here.]`; follow-up 1 `Hi {{first_name}}, just bumping my previous message.`; follow-up 2 `Hi {{first_name}}, last note from me. Happy to chat whenever it suits you.`
- `validateSettings` messages (exact):
  - Template issues are prefixed with the labels `Invite note`, `First message`, `Follow-up 1`, `Follow-up 2`: `<label>: is empty`, `<label>: unknown variable {{<name>}}`, `<label>: has an unclosed {{`.
  - `Invite note: longer than 300 characters`, checked on the raw template.
  - `First message delay: minimum must not exceed maximum`.
  - `Active window: start must be before end`.
  - `Active window: pick at least one day`.
  - `Active window: unknown timezone <tz>`, checked with `Intl.DateTimeFormat`.
- `startBlockers` returns `['Save your templates in Settings first']` while `templatesSaved` is false; otherwise it returns the template errors from `validateSettings`.

- [ ] **Step 1: Write the failing tests:**

```ts
const withTemplate = (key: keyof Settings['templates'], value: string) =>
  ({ ...DEFAULT_SETTINGS, templates: { ...DEFAULT_SETTINGS.templates, [key]: value } });
// settings.test.ts
it('fills fields missing from stored JSON with defaults', () =>
  expect(parseSettings({ caps: { invitesPerDay: 10 } }).caps).toEqual({ ...DEFAULT_SETTINGS.caps, invitesPerDay: 10 }));
it('rejects a minimum first-message delay above the maximum', () =>
  expect(validateSettings({ ...DEFAULT_SETTINGS, delays: { ...DEFAULT_SETTINGS.delays, firstMessageMinMinutes: 200 } }))
    .toEqual(['First message delay: minimum must not exceed maximum']));
it('blocks Start until templates are saved', () =>
  expect(startBlockers(DEFAULT_SETTINGS)).toEqual(['Save your templates in Settings first']));
it('allows Start once valid templates are saved', () =>
  expect(startBlockers({ ...DEFAULT_SETTINGS, templatesSaved: true })).toEqual([]));
// repo.test.ts — db = await createTestDb() in beforeEach
it('returns the defaults when nothing is saved', async () => expect(await getSettings(db)).toEqual(DEFAULT_SETTINGS));
it('saves, reloads and marks templates as saved', async () => {
  const result = await saveSettings(db, { ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, invitesPerDay: 20 } });
  expect(result.ok).toBe(true);
  expect(await getSettings(db)).toMatchObject({ templatesSaved: true, caps: { invitesPerDay: 20 } });
});
it('rejects unknown variables with a readable error', async () =>
  expect(await saveSettings(db, withTemplate('followup1', 'Hi {{firstname}}')))
    .toEqual({ ok: false, errors: ['Follow-up 1: unknown variable {{firstname}}'] }));
it('rejects a non-integer cap', async () => {
  const result = await saveSettings(db, { ...DEFAULT_SETTINGS, caps: { ...DEFAULT_SETTINGS.caps, invitesPerDay: Number.NaN } });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors[0]).toMatch(/^caps\.invitesPerDay: /);
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/settings`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** `npm test -- src/lib/settings`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add settings with defaults, validation and storage`.

---

### Task 7: Unipile client, error classes, dry run and fake

**Files:**
- Create: `src/lib/unipile/types.ts`, `src/lib/unipile/errors.ts`, `src/lib/unipile/errors.test.ts`, `src/lib/unipile/client.ts`, `src/lib/unipile/client.test.ts`, `src/lib/unipile/dry-run.ts`, `src/lib/unipile/dry-run.test.ts`, `src/test-utils/fake-unipile.ts`

**Interfaces:**
- Produces:
  - `type NetworkDistance = 'FIRST_DEGREE' | 'SECOND_DEGREE' | 'THIRD_DEGREE' | 'OUT_OF_NETWORK'`.
  - `type UnipileProfile = { providerId: string; publicIdentifier: string | null; firstName: string | null; lastName: string | null; headline: string | null; location: string | null; networkDistance: NetworkDistance | null; currentCompany: string | null; currentPosition: string | null }`.
  - `type SentInvitation = { id: string; invitedUserId: string | null; invitedUserPublicId: string | null }`.
  - `type ChatMessage = { id: string; isSender: boolean; timestamp: string; text: string | null }`.
  - The client interface:
    ```ts
    interface UnipileClient {
      getProfile(identifier: string): Promise<UnipileProfile>;
      sendInvitation(providerId: string, message: string): Promise<{ invitationId: string }>;
      listSentInvitations(): Promise<SentInvitation[]>;
      cancelInvitation(invitationId: string): Promise<void>;
      startChat(providerId: string, text: string): Promise<{ chatId: string; messageId: string }>;
      sendMessage(chatId: string, text: string): Promise<{ messageId: string }>;
      listChatMessages(chatId: string, limit: number): Promise<ChatMessage[]>;
    }
    ```
  - `class UnipileError extends Error { status: number; type: string | null; retryAfterSeconds: number | null }`, constructed as `new UnipileError(status, type, message, retryAfterSeconds = null)`.
  - `type ErrorClass = 'limit' | 'transient' | 'already_connected' | 'already_invited' | 'permanent' | 'unknown'` and `classifyUnipileError(err: unknown): ErrorClass`.
  - `createUnipileClient(opts: { dsn: string; apiKey: string; accountId: string; fetch?: typeof fetch; timeoutMs?: number }): UnipileClient`. `timeoutMs` defaults to `20_000`.
  - `createDryRunClient(real: UnipileClient): UnipileClient`. `DRY_RUN_ID_PREFIX = 'dry_'`.
  - In `src/test-utils/fake-unipile.ts`:
    - `createFakeUnipile(): FakeUnipile`, where `FakeUnipile = UnipileClient & { calls: { method: keyof UnipileClient; args: unknown[] }[]; profiles: Map<string, UnipileProfile>; sentInvitations: SentInvitation[]; chatMessages: Map<string, ChatMessage[]>; failNext(method: keyof UnipileClient, error: unknown): void; onCall(method: keyof UnipileClient, hook: () => Promise<void>): void }`.
    - `makeProfile(patch?: Partial<UnipileProfile>): UnipileProfile`. Defaults: `providerId 'ACoJane'`, `publicIdentifier 'jane-doe'`, `firstName 'Jane'`, `lastName 'Doe'`, `headline 'CTO at Acme'`, `location 'Paris'`, `networkDistance 'SECOND_DEGREE'`, `currentCompany 'Acme'`, `currentPosition 'CTO'`.

HTTP mapping. Base URL: the DSN, with `https://` added when it has no scheme and any trailing `/` removed. Every request sends the `X-API-KEY` and `accept: application/json` headers.

| Method | Request | Result |
|---|---|---|
| `getProfile(id)` | `GET /api/v1/users/{encodeURIComponent(id)}?account_id=…&linkedin_sections=experience_preview` | Mapped profile (rules below) |
| `sendInvitation` | `POST /api/v1/users/invite`, JSON body `{ provider_id, account_id, message }` | `invitation_id` |
| `listSentInvitations` | `GET /api/v1/users/invite/sent?account_id=…&limit=100`, then `&cursor=…`; stop when `cursor` is null or after 20 pages | `items` mapped from `id`, `invited_user_id`, `invited_user_public_id` |
| `cancelInvitation` | `DELETE /api/v1/users/invite/sent/{id}?account_id=…` | none |
| `startChat` | `POST /api/v1/chats`, multipart fields `account_id`, `attendees_ids`, `text` | `chat_id`, `message_id` |
| `sendMessage` | `POST /api/v1/chats/{chatId}/messages`, multipart field `text` | `message_id` |
| `listChatMessages` | `GET /api/v1/chats/{chatId}/messages?limit=…` | `items` mapped from `id`, `is_sender` (`1` or `true` gives `true`), `timestamp`, `text` |

Profile mapping:
- `networkDistance` comes from `network_distance`; an unknown value gives null.
- `currentCompany` and `currentPosition` come from the `work_experience` entry with `current === true`. If there is none, use the first entry without an `end`; if there is none either, use null.
- Parse leniently with Zod (optional fields, passthrough): a missing optional field becomes null.
- A missing `provider_id` throws `UnipileError(422, 'errors/invalid_response', …)`.

Errors:
- A non-2xx response throws `UnipileError(res.status, body.type ?? null, body.detail ?? body.title ?? res.statusText, retryAfter)`. `retryAfter` is `body.retry_after`, else the `Retry-After` header in seconds, else null. A body that is not JSON gives `type: null`.
- A `fetch` rejection or a timeout throws `UnipileError(0, 'network_error', message)`.

Classification:
- `limit`: status 429, or type `errors/cannot_resend_yet`, `errors/limit_exceeded`, `errors/too_many_requests` or `errors/connection_limit_reached`.
- `transient`: status 0 or ≥ 500.
- `already_connected`: type `errors/already_connected`.
- `already_invited`: type `errors/already_invited_recently`.
- `permanent`: status 404, or type `errors/cannot_invite_attendee`, `errors/invalid_recipient`, `errors/blocked_recipient`, `errors/user_unreachable`, `errors/invalid_resource_identifier`, `errors/no_connection_with_recipient` or `errors/too_many_characters`.
- `unknown`: anything else, including errors that are not `UnipileError`.

Dry-run client:
- Reads (`getProfile`, `listSentInvitations`, `listChatMessages`) go to the real client.
- Writes call nothing and return fake ids that start with `dry_`.
- `listChatMessages` on a `dry_` chat id returns `[]` without calling the real client.

Fake behavior:
- `getProfile` returns `profiles.get(identifier)`, or throws `UnipileError(404, 'errors/invalid_resource_identifier', 'User not found')`.
- `sendInvitation` returns `inv_<n>`, where `n` is the number of `sendInvitation` calls so far.
- `startChat` returns `{ chatId: 'chat_' + providerId, messageId: 'msg_<n>' }`, and `sendMessage` returns `msg_<n>`.
- `cancelInvitation` removes the entry from `sentInvitations`.
- `listChatMessages` returns `chatMessages.get(chatId) ?? []`.
- Every call is pushed to `calls` first. Errors queued with `failNext` throw in FIFO order per method. `onCall` hooks run before the method returns.

- [ ] **Step 1: Write the failing tests:**

```ts
// client.test.ts
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let captured: Request[]; let responses: Response[]; let client: UnipileClient;
beforeEach(() => {
  captured = []; responses = [];
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => { captured.push(new Request(input, init)); return responses.shift()!; };
  client = createUnipileClient({ dsn: 'api1.unipile.com:13111', apiKey: 'key_1', accountId: 'acc_1', fetch: fetchStub as typeof fetch });
});
it('fetches a profile with its experience and maps it', async () => {
  responses.push(json(200, { provider_id: 'ACoJane', public_identifier: 'jane-doe', first_name: 'Jane', last_name: 'Doe', headline: 'CTO',
    location: 'Paris', network_distance: 'SECOND_DEGREE',
    work_experience: [{ company: 'Old Co', position: 'Dev', end: '2020' }, { company: 'Acme', position: 'CTO', current: true }] }));
  expect(await client.getProfile('jane-doe')).toEqual({ providerId: 'ACoJane', publicIdentifier: 'jane-doe', firstName: 'Jane',
    lastName: 'Doe', headline: 'CTO', location: 'Paris', networkDistance: 'SECOND_DEGREE', currentCompany: 'Acme', currentPosition: 'CTO' });
  expect(captured[0].url).toBe('https://api1.unipile.com:13111/api/v1/users/jane-doe?account_id=acc_1&linkedin_sections=experience_preview');
  expect(captured[0].headers.get('x-api-key')).toBe('key_1');
});
it('sends an invitation as JSON', async () => {
  responses.push(json(201, { object: 'UserInvitationSent', invitation_id: 'inv_1' }));
  expect(await client.sendInvitation('ACoJane', 'Hi Jane')).toEqual({ invitationId: 'inv_1' });
  expect(captured[0].method).toBe('POST');
  expect(await captured[0].json()).toEqual({ provider_id: 'ACoJane', account_id: 'acc_1', message: 'Hi Jane' });
});
it('starts a chat with multipart form data', async () => {
  responses.push(json(201, { object: 'ChatStarted', chat_id: 'chat_1', message_id: 'msg_1' }));
  expect(await client.startChat('ACoJane', 'Hello')).toEqual({ chatId: 'chat_1', messageId: 'msg_1' });
  const form = await captured[0].formData();
  expect([form.get('account_id'), form.get('attendees_ids'), form.get('text')]).toEqual(['acc_1', 'ACoJane', 'Hello']);
});
it('follows cursors when listing sent invitations', async () => {
  responses.push(json(200, { items: [{ id: 'i1', invited_user_id: 'ACo1', invited_user_public_id: 'one' }], cursor: 'c2' }),
                 json(200, { items: [{ id: 'i2', invited_user_id: 'ACo2', invited_user_public_id: 'two' }], cursor: null }));
  expect((await client.listSentInvitations()).map((i) => i.id)).toEqual(['i1', 'i2']);
  expect(captured[1].url).toContain('cursor=c2');
});
it('raises UnipileError with type and retry_after', async () => {
  responses.push(json(429, { status: 429, type: 'errors/too_many_requests', retry_after: 120 }));
  await expect(client.getProfile('x')).rejects.toMatchObject({ status: 429, type: 'errors/too_many_requests', retryAfterSeconds: 120 });
});
it('turns network failures into status 0', async () => {
  client = createUnipileClient({ dsn: 'https://x', apiKey: 'k', accountId: 'a', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await expect(client.getProfile('x')).rejects.toMatchObject({ status: 0, type: 'network_error' });
});

// errors.test.ts
it.each([
  [new UnipileError(429, 'errors/too_many_requests', ''), 'limit'],
  [new UnipileError(422, 'errors/cannot_resend_yet', ''), 'limit'],
  [new UnipileError(422, 'errors/limit_exceeded', ''), 'limit'],
  [new UnipileError(503, null, ''), 'transient'],
  [new UnipileError(0, 'network_error', ''), 'transient'],
  [new UnipileError(422, 'errors/already_connected', ''), 'already_connected'],
  [new UnipileError(422, 'errors/already_invited_recently', ''), 'already_invited'],
  [new UnipileError(422, 'errors/cannot_invite_attendee', ''), 'permanent'],
  [new UnipileError(404, 'errors/invalid_resource_identifier', ''), 'permanent'],
  [new UnipileError(422, 'errors/no_connection_with_recipient', ''), 'permanent'],
  [new UnipileError(422, 'errors/brand_new_error', ''), 'unknown'],
  [new TypeError('bug'), 'unknown'],
])('classifies %o as %s', (err, expected) => expect(classifyUnipileError(err)).toBe(expected));

// dry-run.test.ts
it('never calls write endpoints and returns dry_ ids', async () => {
  const real = createFakeUnipile(); const dry = createDryRunClient(real);
  expect((await dry.sendInvitation('ACo1', 'x')).invitationId).toMatch(/^dry_/);
  expect((await dry.startChat('ACo1', 'x')).chatId).toMatch(/^dry_/);
  await dry.sendMessage('chat_1', 'x'); await dry.cancelInvitation('inv_1');
  expect(real.calls).toEqual([]);
});
it('passes reads through, except chats that only exist in the dry run', async () => {
  const real = createFakeUnipile(); real.profiles.set('jane', makeProfile()); const dry = createDryRunClient(real);
  expect(await dry.getProfile('jane')).toEqual(makeProfile());
  expect(await dry.listChatMessages('dry_chat_1', 20)).toEqual([]);
  expect(real.calls.map((c) => c.method)).toEqual(['getProfile']);
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/unipile`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** types, errors, client, dry-run client and fake.
- [ ] **Step 4: Run** `npm test -- src/lib/unipile`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add Unipile v1 client with error classes and dry-run mode`.

---

### Task 8: Engine foundations

**Files:**
- Create: `src/lib/engine/deps.ts`, `src/lib/engine/steps.ts`, `src/lib/engine/steps.test.ts`, `src/lib/engine/state.ts`, `src/lib/engine/state.test.ts`, `src/lib/engine/usage.ts`, `src/lib/engine/usage.test.ts`, `src/lib/engine/events.ts`, `src/lib/engine/lead-templates.ts`, `src/lib/engine/lead-templates.test.ts`, `src/test-utils/engine.ts`

**Interfaces:**
- Consumes: Tasks 2 and 4–7.
- Produces:
  - `type EngineDeps = { db: Db; unipile: UnipileClient; now: () => Date; random: () => number; sleep: (ms: number) => Promise<void>; dryRun: boolean }`.
  - Steps:
    - `type StepKind = 'invite' | 'expire_invite' | 'first_message' | 'followup_1' | 'followup_2' | 'finish'` and `type MessageStep = 'first_message' | 'followup_1' | 'followup_2'`.
    - `nextStep(status: LeadStatus): StepKind | null`.
    - `MESSAGE_STEP_BY_STATUS: { accepted: 'first_message'; already_connected: 'first_message'; messaged: 'followup_1'; followup_1: 'followup_2' }`.
    - `statusAfterMessage(step: MessageStep): 'messaged' | 'followup_1' | 'followup_2'`.
    - `nextDueAfterSend(status: 'messaged' | 'followup_1' | 'followup_2', sentAt: Date, settings: Settings): Date`. It adds `followup1Days`, `followup2Days` or `finishDays` with `addLocalDays` in `settings.window.timezone`.
    - `firstMessageDueAt(acceptedAt: Date, random: () => number, delays: Settings['delays']): Date`: `acceptedAt + min + random() × (max − min)` minutes.
  - State:
    - `type AppState = typeof appStateTable.$inferSelect`.
    - `getAppState(db): Promise<AppState>`: inserts row 1 when it is missing.
    - `updateAppState(db, patch: Partial<Omit<AppState, 'id'>>): Promise<void>`.
    - `acquireTickLock(db, now: Date, leaseMs: number): Promise<boolean>`: one conditional `UPDATE … WHERE tick_lock_until IS NULL OR tick_lock_until < now RETURNING id`.
    - `releaseTickLock(db): Promise<void>`.
    - `setRunning(db, running: boolean): Promise<void>`: `true` also clears `pauseReason` and `consecutiveErrors`.
    - `incrementErrorStreak(db, reason: string): Promise<{ autoPaused: boolean }>`. At `ERROR_STREAK_LIMIT = 3`, it sets `running = false` and `pauseReason = 'Auto-paused after 3 Unipile errors in a row (last: <reason>)'`.
    - `resetErrorStreak(db): Promise<void>`.
  - Usage:
    - `type Usage = { invitesToday: number; invitesLast7Days: number; messagesToday: number; profileViewsToday: number }`.
    - `getUsage(db, now: Date, timezone: string): Promise<Usage>`. "Today" starts at the local midnight; the week is `now − 7 × 24 h`.
    - `type Remaining = { invites: number; messages: number; profileViews: number }` and `remainingCapacity(u: Usage, caps: Settings['caps']): Remaining`. Each value is at least 0; `invites` is the smaller of the daily and weekly remainders.
  - `logEvent(db, e: { type: EventType; at: Date; leadId?: number | null; payload?: Record<string, unknown> }): Promise<void>`.
  - Lead templates:
    - `leadTemplateValues(lead: LeadVariableFields): TemplateValues`, with `LeadVariableFields = Pick<Lead, 'firstName' | 'lastName' | 'headline' | 'company' | 'position' | 'location'>`.
    - `renderForLead(template: string, lead: LeadVariableFields): RenderResult`.
    - `checkLeadTemplates(lead: LeadVariableFields, settings: Settings, opts: { includeInvite: boolean }): { ok: true } | { ok: false; reason: string }`. The reason is `missing_variable: <names joined by ", ">` (union over the checked templates, first-seen order), `invalid_template`, or `note_too_long: <length>/300`.
  - Test helpers in `src/test-utils/engine.ts`:
    - `NOW`.
    - `createTestEngine(opts?: { now?: Date; random?: number; dryRun?: boolean; templates?: Partial<Settings['templates']>; settings?: (s: Settings) => Settings }): Promise<TestEngine>`, with `TestEngine = { db: Db; fake: FakeUnipile; deps: EngineDeps; settings: Settings; setNow(d: Date): void; sleeps: number[] }`.
      - Saves the settings with `saveSettings`. The default test templates are: invite note `Hi {{first_name}} from {{company}}`, first message `Thanks {{first_name}}`, follow-up 1 `Bump {{first_name}}`, follow-up 2 `Last {{first_name}}`.
      - Calls `setRunning(db, true)`.
      - With `dryRun`, `deps.unipile` is `createDryRunClient(fake)`.
      - `sleep` records the ms in `sleeps` and resolves at once.
    - `seedLead(db, patch?: Partial<NewLead>): Promise<Lead>`. Defaults: slug `lead-<n>`, matching `linkedinUrl`, status `queued`, `nextActionAt = 2026-11-17T08:00:00Z`.
    - `seedEvents(db, type: EventType, count: number, at: Date): Promise<void>`.
    - `getLead(db, id): Promise<Lead>`.
    - `listEvents(db): Promise<EventRow[]>`, ordered by id.

- [ ] **Step 1: Write the failing tests:**

```ts
// steps.test.ts
it('maps each status to its next step', () => {
  expect(['queued', 'invite_sent', 'accepted', 'already_connected', 'messaged', 'followup_1', 'followup_2'].map((s) => nextStep(s as LeadStatus)))
    .toEqual(['invite', 'expire_invite', 'first_message', 'first_message', 'followup_1', 'followup_2', 'finish']);
  for (const s of ['replied', 'no_response', 'invite_expired', 'failed'] as const) expect(nextStep(s)).toBeNull();
});
it('schedules the next step 2, 3 and 3 calendar days after a send', () => {
  expect(nextDueAfterSend('messaged', NOW, DEFAULT_SETTINGS)).toEqual(new Date('2026-11-19T09:00:00Z'));
  expect(nextDueAfterSend('followup_1', NOW, DEFAULT_SETTINGS)).toEqual(new Date('2026-11-20T09:00:00Z'));
  expect(nextDueAfterSend('followup_2', NOW, DEFAULT_SETTINGS)).toEqual(new Date('2026-11-20T09:00:00Z'));
});
it('keeps the local time across a time change', () =>
  expect(nextDueAfterSend('messaged', new Date('2027-03-27T09:00:00Z'), DEFAULT_SETTINGS)).toEqual(new Date('2027-03-29T08:00:00Z')));
it('schedules the first message 60 to 180 minutes after acceptance', () => {
  expect(firstMessageDueAt(NOW, () => 0, DEFAULT_SETTINGS.delays)).toEqual(new Date('2026-11-17T10:00:00Z'));
  expect(firstMessageDueAt(NOW, () => 0.5, DEFAULT_SETTINGS.delays)).toEqual(new Date('2026-11-17T11:00:00Z'));
});
// state.test.ts — db = await createTestDb() in beforeEach
it('gives the lock to one tick at a time', async () => {
  expect(await acquireTickLock(db, NOW, 240_000)).toBe(true);
  expect(await acquireTickLock(db, NOW, 240_000)).toBe(false);
  await releaseTickLock(db);
  expect(await acquireTickLock(db, NOW, 240_000)).toBe(true);
});
it('takes over an expired lease', async () => {
  await acquireTickLock(db, NOW, 240_000);
  expect(await acquireTickLock(db, new Date(NOW.getTime() + 240_001), 240_000)).toBe(true);
});
it('auto-pauses on the third error in a row', async () => {
  await setRunning(db, true);
  expect(await incrementErrorStreak(db, 'a')).toEqual({ autoPaused: false });
  await incrementErrorStreak(db, 'b');
  expect(await incrementErrorStreak(db, 'errors/cannot_resend_yet')).toEqual({ autoPaused: true });
  expect(await getAppState(db)).toMatchObject({ running: false, pauseReason: 'Auto-paused after 3 Unipile errors in a row (last: errors/cannot_resend_yet)' });
});
it('starting again clears the pause reason and the streak', async () => {
  await updateAppState(db, { pauseReason: 'x', consecutiveErrors: 3 }); await setRunning(db, true);
  expect(await getAppState(db)).toMatchObject({ running: true, pauseReason: null, consecutiveErrors: 0 });
});
// usage.test.ts
it('counts today in Paris time and the last 7 days', async () => {
  await seedEvents(db, 'invite_sent', 2, new Date('2026-11-16T23:30:00Z')); // 00:30 in Paris, today
  await seedEvents(db, 'invite_sent', 3, new Date('2026-11-16T22:30:00Z')); // 23:30 in Paris, yesterday
  await seedEvents(db, 'invite_sent', 4, new Date('2026-11-10T08:00:00Z')); // 7 days and 1 hour ago
  await seedEvents(db, 'message_sent', 5, new Date('2026-11-17T08:00:00Z'));
  await seedEvents(db, 'profile_view', 6, new Date('2026-11-17T08:00:00Z'));
  expect(await getUsage(db, NOW, 'Europe/Paris')).toEqual({ invitesToday: 2, invitesLast7Days: 5, messagesToday: 5, profileViewsToday: 6 });
});
it('takes the tighter of the daily and weekly invite caps and never goes below 0', () => {
  expect(remainingCapacity({ invitesToday: 10, invitesLast7Days: 180, messagesToday: 0, profileViewsToday: 0 }, DEFAULT_SETTINGS.caps))
    .toEqual({ invites: 10, messages: 90, profileViews: 90 });
  expect(remainingCapacity({ invitesToday: 36, invitesLast7Days: 36, messagesToday: 95, profileViewsToday: 0 }, DEFAULT_SETTINGS.caps))
    .toEqual({ invites: 0, messages: 0, profileViews: 90 });
});
// lead-templates.test.ts
const lead = { firstName: 'Jane', lastName: 'Doe', headline: null, company: 'Acme', position: null, location: null };
const withT = (t: Partial<Settings['templates']>) => ({ ...DEFAULT_SETTINGS, templates: { ...DEFAULT_SETTINGS.templates, ...t } });
it('passes when every template renders', () => expect(checkLeadTemplates(lead, DEFAULT_SETTINGS, { includeInvite: true })).toEqual({ ok: true }));
it('lists missing variables across all templates', () =>
  expect(checkLeadTemplates(lead, withT({ followup2: 'Re {{position}} / {{headline}}' }), { includeInvite: true }))
    .toEqual({ ok: false, reason: 'missing_variable: position, headline' }));
it('fails when the rendered invite note is over 300 characters', () =>
  expect(checkLeadTemplates({ ...lead, company: 'x'.repeat(300) }, withT({ inviteNote: 'Hi {{company}}' }), { includeInvite: true }))
    .toEqual({ ok: false, reason: 'note_too_long: 303/300' }));
it('skips the invite note for leads that are already connected', () =>
  expect(checkLeadTemplates(lead, withT({ inviteNote: '{{position}}' }), { includeInvite: false })).toEqual({ ok: true }));
```

- [ ] **Step 2: Run** `npm test -- src/lib/engine`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** the modules and the test helpers.
- [ ] **Step 4: Run** `npm test -- src/lib/engine`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add engine foundations (steps, state, usage, lead templates)`.

---

### Task 9: Invite action and failure policy

**Files:**
- Create: `src/lib/engine/failure.ts`, `src/lib/engine/invite.ts`, `src/lib/engine/invite.test.ts`

**Interfaces:**
- Consumes: Task 8 (all), `classifyUnipileError`, `UnipileError` (Task 7), `nextActiveDayStart`, `addLocalDays` (Task 5).
- Produces:
  - `type ActionOutcome = { leadId: number; result: 'invited' | 'already_connected' | 'already_invited' | 'messaged' | 'replied' | 'failed' | 'retry' | 'deferred' | 'superseded' }`. `deferred` means a limit or transient error. `superseded` means the compare-and-set update matched no row.
  - `failLead(db, lead: Lead, reason: string, at: Date): Promise<void>`. It is compare-and-set on `lead.status` and sets `status 'failed'`, `failureReason`, `failedFromStatus = lead.status`, `nextActionAt null`, `lastAction 'failed'`, `lastActionAt`.
  - `handleActionError(deps, ctx: { lead: Lead; kind: 'invite' | 'message'; settings: Settings }, err: unknown): Promise<ActionOutcome>`. It always logs `action_failed` with `{ kind, status, type, message }`, then by class:
    - `limit`: pauses `kind`. It sets `invitesPausedUntil` or `messagesPausedUntil` to `now + retryAfterSeconds` when that is present, otherwise to `nextActiveDayStart(now, settings.window)`. It calls `incrementErrorStreak(type ?? 'http_<status>')` and returns `deferred`. The lead is unchanged.
    - `transient`: calls `incrementErrorStreak` and returns `deferred`. The lead is unchanged.
    - `permanent`: calls `failLead` with reason `type ?? 'http_<status>'` and returns `failed`.
    - `unknown`: when `retryCount` is 0, sets it to 1 (the lead stays due) and returns `retry`. Otherwise it calls `failLead` with reason `type ?? message` and returns `failed`.
  - `runInviteAction(deps, lead: Lead, settings: Settings): Promise<ActionOutcome>`. In order:
    1. `getProfile(lead.slug)`, then log `profile_view`.
    2. If another lead already has this `providerId`, `failLead('duplicate_person')`.
    3. Store the profile fields on the lead: `providerId`, `publicIdentifier`, names, `headline`, `location`, `company ← currentCompany`, `position ← currentPosition`.
    4. If the profile is `FIRST_DEGREE`: run `checkLeadTemplates(includeInvite: false)`, which may fail the lead. Otherwise set status `already_connected`, `sequenceStartedAt = now`, `nextActionAt = now`, `lastAction 'already_connected'`, and reset the error streak.
    5. Otherwise run `checkLeadTemplates(includeInvite: true)`, which may fail the lead.
    6. `sendInvitation(providerId, renderedNote)`, then log `invite_sent` with `{ text, dryRun }`. Set status `invite_sent`, `invitationId`, `inviteSentAt = sequenceStartedAt = now`, `nextActionAt = addLocalDays(now, inviteExpiryDays, tz)`, `retryCount 0`, `lastAction 'invite_sent'`. Reset the error streak.
    7. On error:
       - `already_connected`: handle as step 4.
       - `already_invited`: set status `invite_sent` with a null `invitationId` and the timestamps of step 6, but log no `invite_sent` event.
       - Anything else: `handleActionError(kind: 'invite')`.

- [ ] **Step 1: Write the failing tests** (`e = await createTestEngine()`, `lead = await seedLead(e.db, { slug: 'jane-doe' })`, `e.fake.profiles.set('jane-doe', makeProfile())` in `beforeEach`):

```ts
const run = () => runInviteAction(e.deps, lead, e.settings);
const methods = () => e.fake.calls.map((c) => c.method);
it('sends the invite with the rendered note and schedules expiry in 21 days', async () => {
  expect(await run()).toEqual({ leadId: lead.id, result: 'invited' });
  expect(e.fake.calls).toEqual([{ method: 'getProfile', args: ['jane-doe'] }, { method: 'sendInvitation', args: ['ACoJane', 'Hi Jane from Acme'] }]);
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', providerId: 'ACoJane', firstName: 'Jane', company: 'Acme',
    position: 'CTO', invitationId: 'inv_1', inviteSentAt: NOW, sequenceStartedAt: NOW, nextActionAt: new Date('2026-12-08T09:00:00Z'), lastAction: 'invite_sent' });
  expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view', 'invite_sent']);
});
it('moves first-degree connections straight to the first message', async () => {
  e.fake.profiles.set('jane-doe', makeProfile({ networkDistance: 'FIRST_DEGREE' }));
  expect((await run()).result).toBe('already_connected');
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'already_connected', nextActionAt: NOW, sequenceStartedAt: NOW });
  expect(methods()).toEqual(['getProfile']);
});
it('fails before inviting when a later template misses a variable', async () => { // Review Focus 4
  e = await createTestEngine({ templates: { followup2: 'About {{position}}' } }); lead = await seedLead(e.db, { slug: 'jane-doe' });
  e.fake.profiles.set('jane-doe', makeProfile({ currentPosition: null }));
  expect((await run()).result).toBe('failed');
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'missing_variable: position', failedFromStatus: 'queued', firstName: 'Jane' });
  expect(methods()).toEqual(['getProfile']);
});
it('fails before inviting when the rendered note is over 300 characters', async () => { // Review Focus 4
  e.fake.profiles.set('jane-doe', makeProfile({ currentCompany: 'A'.repeat(290) }));
  await run();
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'note_too_long: 303/300' });
});
it('marks a second URL of the same person as duplicate_person', async () => { // Review Focus 1
  await seedLead(e.db, { slug: 'jane-old', providerId: 'ACoJane', status: 'invite_sent' });
  await run();
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'duplicate_person' });
  expect(methods()).toEqual(['getProfile']);
});
it('treats already_connected from Unipile as connected', async () => {
  e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/already_connected', ''));
  await run();
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'already_connected', nextActionAt: NOW });
});
it('treats already_invited_recently as invite_sent without a new invite event', async () => {
  e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/already_invited_recently', ''));
  expect((await run()).result).toBe('already_invited');
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', invitationId: null, nextActionAt: new Date('2026-12-08T09:00:00Z') });
  expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['profile_view']);
});
it('pauses invites until the next active day on a limit error and keeps the lead queued', async () => {
  e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/cannot_resend_yet', ''));
  expect((await run()).result).toBe('deferred');
  expect((await getLead(e.db, lead.id)).status).toBe('queued');
  expect(await getAppState(e.db)).toMatchObject({ invitesPausedUntil: new Date('2026-11-18T07:30:00Z'), consecutiveErrors: 1 });
});
it('pauses invites for retry_after seconds on HTTP 429', async () => {
  e.fake.failNext('getProfile', new UnipileError(429, 'errors/too_many_requests', '', 600));
  await run();
  expect((await getAppState(e.db)).invitesPausedUntil).toEqual(new Date('2026-11-17T09:10:00Z'));
});
it('leaves the lead untouched on a 5xx error', async () => { // Review Focus 3
  e.fake.failNext('sendInvitation', new UnipileError(503, null, 'down'));
  expect((await run()).result).toBe('deferred');
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'queued', retryCount: 0 });
  expect((await getAppState(e.db)).consecutiveErrors).toBe(1);
});
it('retries an unknown error once, then fails the lead', async () => {
  e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/brand_new_error', ''));
  e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/brand_new_error', ''));
  expect((await run()).result).toBe('retry');
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'queued', retryCount: 1 });
  expect((await runInviteAction(e.deps, await getLead(e.db, lead.id), e.settings)).result).toBe('failed');
  expect((await getLead(e.db, lead.id)).failureReason).toBe('errors/brand_new_error');
});
it('fails the lead on a permanent error or a missing profile', async () => {
  e.fake.failNext('sendInvitation', new UnipileError(422, 'errors/cannot_invite_attendee', ''));
  await run();
  expect((await getLead(e.db, lead.id)).failureReason).toBe('errors/cannot_invite_attendee');
  const ghost = await seedLead(e.db, { slug: 'ghost' });
  await runInviteAction(e.deps, ghost, e.settings);
  expect((await getLead(e.db, ghost.id)).failureReason).toBe('errors/invalid_resource_identifier');
});
it('records the dry-run flag and the text on the invite event', async () => {
  e = await createTestEngine({ dryRun: true }); lead = await seedLead(e.db, { slug: 'jane-doe' }); e.fake.profiles.set('jane-doe', makeProfile());
  await run();
  expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'invite_sent', payload: { text: 'Hi Jane from Acme', dryRun: true } });
  expect((await getLead(e.db, lead.id)).invitationId).toMatch(/^dry_/);
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/engine/invite`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `failure.ts` and `invite.ts`.
- [ ] **Step 4: Run** `npm test -- src/lib/engine`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: send invites with notes and apply the error policy`.

---

### Task 10: Message action

**Files:**
- Create: `src/lib/engine/message.ts`, `src/lib/engine/message.test.ts`

**Interfaces:**
- Consumes: `failLead`, `handleActionError`, `ActionOutcome` (Task 9); `statusAfterMessage`, `nextDueAfterSend`, `renderForLead`, `logEvent`, `resetErrorStreak` (Task 8).
- Produces: `runMessageAction(deps, lead: Lead, step: MessageStep, settings: Settings): Promise<ActionOutcome>`. In order:
  1. For `followup_1` and `followup_2` with a `chatId`, call `listChatMessages(chatId, 50)`. If any message has `!isSender` and a timestamp after `lead.sequenceStartedAt`, set status `replied`, `nextActionAt null`, `lastAction 'reply_received'`, `lastActionAt = that timestamp`, and return `replied`. Errors here go to `handleActionError(kind: 'message')`.
  2. Render the step's template: `firstMessage`, `followup1` or `followup2`. If rendering fails, `failLead` with `missing_variable: …` or `invalid_template`.
  3. Send with `sendMessage(chatId, text)` when there is a `chatId`, otherwise `startChat(providerId, text)`. Log `message_sent` with `{ step, text, dryRun }`. Then update compare-and-set: `status = statusAfterMessage(step)`, `chatId`, `nextActionAt = nextDueAfterSend(...)`, `retryCount 0`, `lastAction = step`, `lastActionAt = now`, and reset the error streak. Return `messaged`; if the update matched no row, return `superseded`.
  4. Other errors go to `handleActionError(kind: 'message')`.

- [ ] **Step 1: Write the failing tests** (`e = await createTestEngine()` in `beforeEach`; `SEQ = new Date('2026-11-10T09:00:00Z')`):

```ts
const replyAt = (iso: string) => [{ id: 'm1', isSender: false, timestamp: iso, text: 'Hey' }];
it('starts a chat for the first message and schedules follow-up 1 two days later', async () => {
  const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
  expect(await runMessageAction(e.deps, lead, 'first_message', e.settings)).toEqual({ leadId: lead.id, result: 'messaged' });
  expect(e.fake.calls).toEqual([{ method: 'startChat', args: ['ACoJane', 'Thanks Jane'] }]);
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'messaged', chatId: 'chat_ACoJane', nextActionAt: new Date('2026-11-19T09:00:00Z'), lastAction: 'first_message' });
  expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'message_sent', payload: { step: 'first_message', text: 'Thanks Jane', dryRun: false } });
});
it('sends follow-up 1 in the existing chat and schedules follow-up 2 three days later', async () => {
  const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
  await runMessageAction(e.deps, lead, 'followup_1', e.settings);
  expect(e.fake.calls.map((c) => c.method)).toEqual(['listChatMessages', 'sendMessage']);
  expect(e.fake.calls[1].args).toEqual(['chat_1', 'Bump Jane']);
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_1', nextActionAt: new Date('2026-11-20T09:00:00Z') });
});
it('schedules the end three days after follow-up 2', async () => {
  const lead = await seedLead(e.db, { status: 'followup_1', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
  await runMessageAction(e.deps, lead, 'followup_2', e.settings);
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'followup_2', nextActionAt: new Date('2026-11-20T09:00:00Z') });
});
it('stops instead of sending when the lead already replied', async () => {
  const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
  e.fake.chatMessages.set('chat_1', replyAt('2026-11-17T08:00:00Z'));
  expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('replied');
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'replied', nextActionAt: null, lastAction: 'reply_received' });
  expect(e.fake.calls.map((c) => c.method)).toEqual(['listChatMessages']);
});
it('ignores messages from before the sequence started', async () => {
  const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
  e.fake.chatMessages.set('chat_1', replyAt('2026-11-01T08:00:00Z'));
  expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('messaged');
});
it('lets a reply that lands during the send win', async () => { // Review Focus 2
  const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
  e.fake.onCall('sendMessage', async () => { await e.db.update(leads).set({ status: 'replied' }).where(eq(leads.id, lead.id)); });
  expect((await runMessageAction(e.deps, lead, 'followup_1', e.settings)).result).toBe('superseded');
  expect((await getLead(e.db, lead.id)).status).toBe('replied');
});
it('fails the lead when an edited template now needs a missing variable', async () => {
  e = await createTestEngine({ templates: { followup1: 'About {{position}}' } });
  const lead = await seedLead(e.db, { status: 'messaged', providerId: 'ACoJane', firstName: 'Jane', chatId: 'chat_1', sequenceStartedAt: SEQ });
  await runMessageAction(e.deps, lead, 'followup_1', e.settings);
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'failed', failureReason: 'missing_variable: position', failedFromStatus: 'messaged' });
});
it('fails the lead when Unipile says there is no connection', async () => {
  const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
  e.fake.failNext('startChat', new UnipileError(422, 'errors/no_connection_with_recipient', ''));
  await runMessageAction(e.deps, lead, 'first_message', e.settings);
  expect((await getLead(e.db, lead.id)).failureReason).toBe('errors/no_connection_with_recipient');
});
it('pauses messages until the next active day on a limit error', async () => {
  const lead = await seedLead(e.db, { status: 'accepted', providerId: 'ACoJane', firstName: 'Jane', sequenceStartedAt: SEQ });
  e.fake.failNext('startChat', new UnipileError(429, null, ''));
  await runMessageAction(e.deps, lead, 'first_message', e.settings);
  expect((await getAppState(e.db)).messagesPausedUntil).toEqual(new Date('2026-11-18T07:30:00Z'));
  expect((await getLead(e.db, lead.id)).status).toBe('accepted');
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/engine/message`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/lib/engine/message.ts`.
- [ ] **Step 4: Run** `npm test -- src/lib/engine`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: send first messages and follow-ups with a reply check`.

---

### Task 11: Housekeeping

**Files:**
- Create: `src/lib/engine/housekeeping.ts`, `src/lib/engine/housekeeping.test.ts`

**Interfaces:**
- Consumes: Tasks 8 and 9 (`logEvent`, state functions, `firstMessageDueAt`, `classifyUnipileError`).
- Produces (all skip paused leads):
  - `finishDueLeads(db, now: Date): Promise<number>`: `followup_2` leads with `nextActionAt <= now` move to `no_response`, with `nextActionAt null` and `lastAction 'no_response'`. No Unipile call.
  - `runAcceptanceChecks(deps, settings, maxProfileViews: number): Promise<number>`. It checks at most `min(ACCEPTANCE_CHECKS_PER_TICK = 3, maxProfileViews)` leads in `invite_sent` with `acceptanceCheckPending`.
    - For each, call `getProfile(providerId)` and log `profile_view`.
    - `FIRST_DEGREE`: set status `accepted`, `nextActionAt = firstMessageDueAt(now, random, delays)`, `lastAction 'accepted'`, and clear the flag.
    - Otherwise: clear the flag only.
    - On a `limit` or `transient` error: increment the error streak and stop. On any other error: clear the flag and log `action_failed`.
    - Returns how many `getProfile` calls it made, failed ones included.
  - `expireOneInvite(deps, settings): Promise<boolean>`. It takes the oldest lead in `invite_sent` with `nextActionAt <= now`.
    - With an `invitationId`, call `cancelInvitation` and log `invite_withdrawn`.
    - On a `limit` or `transient` error: increment the error streak and return false; the lead stays.
    - On any other error: log `action_failed` and go on.
    - Then set status `invite_expired`, `nextActionAt null`, `lastAction 'invite_withdrawn'`.
  - `runInvitePollIfDue(deps): Promise<boolean>`. It runs when `nextInvitePollAt` is null or `<= now` and at least one lead is in `invite_sent`.
    - Call `listSentInvitations` once. A lead matches an invitation when `invitedUserId = providerId`, or `lower(invitedUserPublicId) = lower(publicIdentifier ?? slug)`.
    - For each `invite_sent` lead with `inviteSentAt <= now − INVITE_POLL_GRACE_MS` (600 000): if it matches and has no `invitationId`, store the id; if it does not match, set `acceptanceCheckPending`.
    - Then set `nextInvitePollAt = now + 3 h + random() × 2 h`.
    - On error: log `action_failed`, increment the error streak on `limit`/`transient`, and set `nextInvitePollAt = now + 1 h`.

- [ ] **Step 1: Write the failing tests** (`e = await createTestEngine()` in `beforeEach`):

```ts
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3_600_000;
it('marks follow-up 2 leads as no_response once due, skipping paused ones', async () => {
  const due = await seedLead(e.db, { status: 'followup_2', nextActionAt: ago(60_000) });
  const later = await seedLead(e.db, { status: 'followup_2', nextActionAt: new Date(NOW.getTime() + H) });
  const paused = await seedLead(e.db, { status: 'followup_2', nextActionAt: ago(60_000), paused: true });
  expect(await finishDueLeads(e.db, NOW)).toBe(1);
  expect(await Promise.all([due, later, paused].map(async (l) => (await getLead(e.db, l.id)).status))).toEqual(['no_response', 'followup_2', 'followup_2']);
});
it('accepts a flagged lead whose profile is now first degree', async () => {
  const lead = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoJane', acceptanceCheckPending: true });
  e.fake.profiles.set('ACoJane', makeProfile({ networkDistance: 'FIRST_DEGREE' }));
  expect(await runAcceptanceChecks(e.deps, e.settings, 90)).toBe(1);
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'accepted', acceptanceCheckPending: false, nextActionAt: new Date('2026-11-17T11:00:00Z'), lastAction: 'accepted' });
});
it('clears the flag when the profile is not first degree yet', async () => {
  const lead = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoJane', acceptanceCheckPending: true });
  e.fake.profiles.set('ACoJane', makeProfile());
  await runAcceptanceChecks(e.deps, e.settings, 90);
  expect(await getLead(e.db, lead.id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: false });
});
it('checks at most 3 leads, and none without profile views left', async () => {
  for (let i = 0; i < 5; i++) await seedLead(e.db, { status: 'invite_sent', providerId: `ACo${i}`, acceptanceCheckPending: true });
  expect(await runAcceptanceChecks(e.deps, e.settings, 0)).toBe(0);
  expect(await runAcceptanceChecks(e.deps, e.settings, 90)).toBe(3);
});
it('withdraws one expired invite per call', async () => {
  const a = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_a', nextActionAt: ago(2 * H) });
  const b = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_b', nextActionAt: ago(H) });
  expect(await expireOneInvite(e.deps, e.settings)).toBe(true);
  expect(e.fake.calls).toEqual([{ method: 'cancelInvitation', args: ['inv_a'] }]);
  expect((await getLead(e.db, a.id)).status).toBe('invite_expired');
  expect((await getLead(e.db, b.id)).status).toBe('invite_sent');
  expect((await listEvents(e.db)).map((x) => x.type)).toEqual(['invite_withdrawn']);
});
it('expires an invite without an id, or one Unipile no longer knows, without blocking', async () => {
  const noId = await seedLead(e.db, { status: 'invite_sent', invitationId: null, nextActionAt: ago(H) });
  await expireOneInvite(e.deps, e.settings);
  expect((await getLead(e.db, noId.id)).status).toBe('invite_expired');
  const gone = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_x', nextActionAt: ago(H) });
  e.fake.failNext('cancelInvitation', new UnipileError(404, null, 'not found'));
  await expireOneInvite(e.deps, e.settings);
  expect((await getLead(e.db, gone.id)).status).toBe('invite_expired');
});
it('keeps the invite when the withdraw call fails with a 5xx', async () => {
  const lead = await seedLead(e.db, { status: 'invite_sent', invitationId: 'inv_a', nextActionAt: ago(H) });
  e.fake.failNext('cancelInvitation', new UnipileError(502, null, ''));
  expect(await expireOneInvite(e.deps, e.settings)).toBe(false);
  expect((await getLead(e.db, lead.id)).status).toBe('invite_sent');
});
it('polls sent invites, flags the ones that disappeared and stores missing ids', async () => {
  const a = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', inviteSentAt: ago(48 * H) });
  const b = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoB', inviteSentAt: ago(48 * H), invitationId: null });
  const fresh = await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoC', inviteSentAt: ago(5 * 60_000) });
  e.fake.sentInvitations.push({ id: 'inv_b', invitedUserId: 'ACoB', invitedUserPublicId: 'bee' });
  expect(await runInvitePollIfDue(e.deps)).toBe(true);
  expect((await getLead(e.db, a.id)).acceptanceCheckPending).toBe(true);
  expect(await getLead(e.db, b.id)).toMatchObject({ acceptanceCheckPending: false, invitationId: 'inv_b' });
  expect((await getLead(e.db, fresh.id)).acceptanceCheckPending).toBe(false);
  expect((await getAppState(e.db)).nextInvitePollAt).toEqual(new Date('2026-11-17T13:00:00Z'));
});
it('does not poll before the next poll time or with no pending invite', async () => {
  expect(await runInvitePollIfDue(e.deps)).toBe(false);
  await seedLead(e.db, { status: 'invite_sent', providerId: 'ACoA', inviteSentAt: ago(48 * H) });
  await updateAppState(e.db, { nextInvitePollAt: new Date(NOW.getTime() + H) });
  expect(await runInvitePollIfDue(e.deps)).toBe(false);
  expect(e.fake.calls).toEqual([]);
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/engine/housekeeping`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/lib/engine/housekeeping.ts`.
- [ ] **Step 4: Run** `npm test -- src/lib/engine`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add housekeeping (no_response, acceptance checks, invite expiry, invite poll)`.

---

### Task 12: Tick orchestrator

**Files:**
- Create: `src/lib/engine/tick.ts`, `src/lib/engine/tick.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6 and 8–11.
- Produces: `TICK_LEASE_MS = 240_000`; `type TickResult = { status: 'locked' | 'paused' | 'outside_window' | 'done'; finished: number; action: ActionOutcome | null }`; `runTick(deps: EngineDeps): Promise<TickResult>`.

Order (spec §8, §13):
1. `acquireTickLock`, or return `locked`. Release the lock in `finally`, whatever happens.
2. Not `running`: return `paused`.
3. `getSettings`, then `finishDueLeads`.
4. Outside the active window: return `outside_window`.
5. `runAcceptanceChecks(remaining.profileViews)`, then `expireOneInvite`, then `runInvitePollIfDue`.
6. Re-read the app state. If housekeeping auto-paused it, return `paused`.
7. Recompute the remaining capacity.
8. Pick the action:
   - **Message**, when messages remain and `messagesPausedUntil` is not after now: a random due lead (`ORDER BY random()`, not paused, `nextActionAt <= now`) in a status of `MESSAGE_STEP_BY_STATUS`.
   - **Invite** otherwise, when invites and profile views remain and `invitesPausedUntil` is not after now: a random due `queued` lead.
9. With a lead picked: `await sleep(Math.floor(random() × jitterMaxSeconds × 1000))`, then run the action.

- [ ] **Step 1: Write the failing tests** (`e = await createTestEngine()` and `e.fake.profiles.set('jane-doe', makeProfile())` in `beforeEach`):

```ts
const queued = () => seedLead(e.db, { slug: 'jane-doe' });
const acceptedDue = () => seedLead(e.db, { status: 'accepted', providerId: 'ACoBob', firstName: 'Bob', sequenceStartedAt: NOW });
const methods = () => e.fake.calls.map((c) => c.method);
it('skips while another tick holds the lock', async () => {
  await acquireTickLock(e.db, NOW, TICK_LEASE_MS); await queued();
  expect(await runTick(e.deps)).toEqual({ status: 'locked', finished: 0, action: null });
  expect(methods()).toEqual([]);
});
it('does nothing while paused', async () => {
  await setRunning(e.db, false); const lead = await seedLead(e.db, { status: 'followup_2' });
  expect((await runTick(e.deps)).status).toBe('paused');
  expect((await getLead(e.db, lead.id)).status).toBe('followup_2');
});
it('outside the active window only finishes due leads', async () => {
  e.setNow(new Date('2026-11-21T10:00:00Z')); await queued(); await seedLead(e.db, { status: 'followup_2' });
  expect(await runTick(e.deps)).toEqual({ status: 'outside_window', finished: 1, action: null });
  expect(methods()).toEqual([]);
});
it('sends a due message before a queued invite, after a random wait', async () => {
  await acceptedDue(); await queued();
  expect((await runTick(e.deps)).action?.result).toBe('messaged');
  expect(methods()).toEqual(['startChat']);
  expect(e.sleeps).toEqual([45_000]);
});
it('falls back to an invite once 90 messages were sent today', async () => {
  await seedEvents(e.db, 'message_sent', 90, new Date('2026-11-17T08:00:00Z')); await acceptedDue(); await queued();
  expect((await runTick(e.deps)).action?.result).toBe('invited');
});
it.each([
  ['35 invites today', 'invite_sent', 35, '2026-11-17T08:00:00Z'],
  ['190 invites in the last 7 days', 'invite_sent', 190, '2026-11-13T09:00:00Z'],
  ['90 profile views today', 'profile_view', 90, '2026-11-17T08:00:00Z'],
] as const)('sends no invite after %s', async (_label, type, count, at) => {
  await seedEvents(e.db, type, count, new Date(at)); await queued();
  expect((await runTick(e.deps)).action).toBeNull();
  expect(methods()).toEqual([]);
});
it('sends no invite while invites are paused, and never picks a paused lead', async () => {
  await updateAppState(e.db, { invitesPausedUntil: new Date('2026-11-17T10:00:00Z') }); await queued();
  expect((await runTick(e.deps)).action).toBeNull();
  await updateAppState(e.db, { invitesPausedUntil: null }); await e.db.update(leads).set({ paused: true });
  expect((await runTick(e.deps)).action).toBeNull();
});
it('auto-pauses after three 5xx errors in a row and keeps the lead queued', async () => { // Review Focus 3
  const lead = await queued();
  for (let i = 0; i < 3; i++) e.fake.failNext('getProfile', new UnipileError(503, null, 'down'));
  for (let i = 0; i < 3; i++) await runTick(e.deps);
  expect(await getAppState(e.db)).toMatchObject({ running: false, consecutiveErrors: 3 });
  expect((await getLead(e.db, lead.id)).status).toBe('queued');
  expect((await runTick(e.deps)).status).toBe('paused');
});
it('resets the error streak after a successful send', async () => {
  await queued(); e.fake.failNext('getProfile', new UnipileError(503, null, '')); e.fake.failNext('getProfile', new UnipileError(503, null, ''));
  for (let i = 0; i < 3; i++) await runTick(e.deps);
  expect(await getAppState(e.db)).toMatchObject({ running: true, consecutiveErrors: 0 });
});
it('in dry run, calls no write endpoint and logs the text', async () => {
  e = await createTestEngine({ dryRun: true }); e.fake.profiles.set('jane-doe', makeProfile()); const lead = await queued();
  await runTick(e.deps);
  expect(methods()).toEqual(['getProfile']);
  expect((await getLead(e.db, lead.id)).status).toBe('invite_sent');
  expect((await listEvents(e.db)).at(-1)).toMatchObject({ type: 'invite_sent', payload: { dryRun: true, text: 'Hi Jane from Acme' } });
});
it('releases the lock when an action throws unexpectedly', async () => {
  const lead = await queued(); e.fake.failNext('getProfile', new TypeError('bug'));
  await runTick(e.deps);
  expect(await acquireTickLock(e.db, NOW, TICK_LEASE_MS)).toBe(true);
  expect((await getLead(e.db, lead.id)).retryCount).toBe(1);
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/engine/tick`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/lib/engine/tick.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: add tick orchestrator with caps, window, jitter and lock`.

---

### Task 13: Unipile webhooks

**Files:**
- Create: `src/lib/webhooks/parse.ts`, `src/lib/webhooks/parse.test.ts`, `src/lib/webhooks/handle.ts`, `src/lib/webhooks/handle.test.ts`

**Interfaces:**
- Consumes: `Db`, `leads`, `getSettings`, `nextDueAfterSend`, `firstMessageDueAt`, `logEvent`.
- Produces:
  - The event type:
    ```ts
    type WebhookEvent =
      | { kind: 'message'; accountId: string; chatId: string; messageId: string | null; timestamp: Date | null;
          senderProviderId: string; ownerProviderId: string; otherAttendeeProviderIds: string[] }
      | { kind: 'new_relation'; accountId: string; providerId: string | null; publicIdentifier: string | null };
    ```
  - `parseWebhookPayload(body: unknown): WebhookEvent | null`. `message_received` gives a message event: `ownerProviderId` comes from `account_info.user_id`, and `otherAttendeeProviderIds` lists the attendees' `attendee_provider_id` without the owner and without repeats. `new_relation` gives a relation event. Anything else gives null.
  - `type WebhookOutcome = 'ignored' | 'unknown_lead' | 'replied' | 'acceptance_check' | 'accepted' | 'manual_message'`.
  - `handleWebhookEvent(db, event, opts: { accountId: string; now: Date; random: () => number }): Promise<{ outcome: WebhookOutcome; leadId: number | null }>`.
  - `processWebhook(db, body: unknown, opts): Promise<{ outcome: WebhookOutcome; leadId: number | null }>`: parses, handles, and always logs `webhook_received` with `{ event: <body.event or null>, outcome }`.
  - `ECHO_WINDOW_MS = 120_000`.

Rules. `msgAt` is `event.timestamp ?? now`. An `accountId` that differs from `opts.accountId` gives `ignored`. Leads are looked up by `providerId`. Webhooks act on paused leads too.

**Message from someone other than the owner:**
- The lead is the sender. No lead: `unknown_lead`. Already `replied`: `ignored`.
- Otherwise set `replied` with no condition on status: `chatId` (if null), `nextActionAt null`, flag cleared, `lastAction 'reply_received'`, `lastActionAt = msgAt`.

**Message from the owner:**
- The chat must have exactly one other attendee, otherwise `ignored`. That attendee is the lead; no lead: `unknown_lead`.
- `invite_sent`: set the flag and `chatId`. Outcome `acceptance_check`.
- Lead's `lastAction` is a message step and `|msgAt − lastActionAt| <= ECHO_WINDOW_MS`: `ignored`. This is the echo of the app's own send.
- `accepted` / `already_connected`, compare-and-set: status `messaged`, `chatId`, `nextActionAt = nextDueAfterSend('messaged', msgAt)`, `lastAction 'manual_message'`. Outcome `manual_message`.
- `messaged` / `followup_1` / `followup_2`: `nextActionAt = nextDueAfterSend(status, msgAt)`, `chatId` if null, `lastAction 'manual_message'`. Outcome `manual_message`.
- Any other status: `ignored`.

**`new_relation`:**
- Find a lead with `providerId = event.providerId`, or `lower(slug)` / `lower(publicIdentifier)` equal to `lower(event.publicIdentifier)`. No lead: `unknown_lead`.
- Not in `invite_sent`: `ignored`.
- Otherwise, compare-and-set: `accepted`, `nextActionAt = firstMessageDueAt(now, random, delays)`, flag cleared, `lastAction 'accepted'`.

- [ ] **Step 1: Write the failing tests:**

```ts
const message = (over: Record<string, unknown> = {}) => ({
  account_id: 'acc_1', account_type: 'LINKEDIN', account_info: { type: 'LINKEDIN', feature: 'classic', user_id: 'ACoMe' },
  event: 'message_received', chat_id: 'chat_1', timestamp: '2026-11-17T08:00:00.000Z', webhook_name: 'reachout', message_id: 'm1', message: 'Hey',
  sender: { attendee_id: 'att_2', attendee_name: 'Jane Doe', attendee_provider_id: 'ACoJane', attendee_profile_url: 'https://www.linkedin.com/in/jane-doe' },
  attendees: [{ attendee_id: 'att_1', attendee_provider_id: 'ACoMe' }, { attendee_id: 'att_2', attendee_provider_id: 'ACoJane' }], attachments: [], ...over,
});
const fromMe = { sender: { attendee_id: 'att_1', attendee_provider_id: 'ACoMe' } };
const relation = { event: 'new_relation', account_id: 'acc_1', account_type: 'LINKEDIN', webhook_name: 'reachout', user_full_name: 'Jane Doe',
  user_provider_id: 'ACoJane', user_public_identifier: 'jane-doe', user_profile_url: 'https://www.linkedin.com/in/jane-doe', user_picture_url: null };
// parse.test.ts
it('parses a received message', () => expect(parseWebhookPayload(message())).toEqual({ kind: 'message', accountId: 'acc_1', chatId: 'chat_1',
  messageId: 'm1', timestamp: new Date('2026-11-17T08:00:00.000Z'), senderProviderId: 'ACoJane', ownerProviderId: 'ACoMe', otherAttendeeProviderIds: ['ACoJane'] }));
it('parses a new relation', () =>
  expect(parseWebhookPayload(relation)).toEqual({ kind: 'new_relation', accountId: 'acc_1', providerId: 'ACoJane', publicIdentifier: 'jane-doe' }));
it('ignores other events and malformed bodies', () => {
  expect(parseWebhookPayload(message({ event: 'message_read' }))).toBeNull();
  expect(parseWebhookPayload('nope')).toBeNull();
  expect(parseWebhookPayload({ event: 'message_received' })).toBeNull();
});
// handle.test.ts — db = await createTestDb(); await saveSettings(db, DEFAULT_SETTINGS) in beforeEach
const opts = { accountId: 'acc_1', now: NOW, random: () => 0.5 };
const handle = (body: unknown) => processWebhook(db, body, opts);
it('marks a lead as replied when they write, whatever their status', async () => {
  const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane' });
  expect(await handle(message())).toEqual({ outcome: 'replied', leadId: lead.id });
  expect(await getLead(db, lead.id)).toMatchObject({ status: 'replied', chatId: 'chat_1', nextActionAt: null, lastAction: 'reply_received' });
});
it('handles the same reply delivered twice', async () => { // Review Focus 5
  const lead = await seedLead(db, { status: 'queued', providerId: 'ACoJane' });
  await handle(message());
  expect(await handle(message())).toEqual({ outcome: 'ignored', leadId: lead.id });
  expect((await getLead(db, lead.id)).status).toBe('replied');
});
it('flags an acceptance check when our note shows up in a new chat', async () => {
  const lead = await seedLead(db, { status: 'invite_sent', providerId: 'ACoJane' });
  expect((await handle(message(fromMe))).outcome).toBe('acceptance_check');
  expect(await getLead(db, lead.id)).toMatchObject({ status: 'invite_sent', acceptanceCheckPending: true, chatId: 'chat_1' });
});
it('counts a manual message before the first message as the first message', async () => {
  const lead = await seedLead(db, { status: 'accepted', providerId: 'ACoJane', lastAction: 'accepted', lastActionAt: new Date('2026-11-17T06:00:00Z') });
  expect((await handle(message(fromMe))).outcome).toBe('manual_message');
  expect(await getLead(db, lead.id)).toMatchObject({ status: 'messaged', nextActionAt: new Date('2026-11-19T08:00:00Z') });
});
it('resets the timer on a manual message after follow-up 1', async () => {
  const lead = await seedLead(db, { status: 'followup_1', providerId: 'ACoJane', lastAction: 'followup_1', lastActionAt: new Date('2026-11-15T09:00:00Z') });
  await handle(message(fromMe));
  expect(await getLead(db, lead.id)).toMatchObject({ status: 'followup_1', nextActionAt: new Date('2026-11-20T08:00:00Z'), lastAction: 'manual_message' });
});
it('ignores the echo of a message the app just sent', async () => {
  const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane', lastAction: 'first_message',
    lastActionAt: new Date('2026-11-17T07:59:30Z'), nextActionAt: new Date('2026-11-19T07:59:30Z') });
  expect((await handle(message(fromMe))).outcome).toBe('ignored');
  expect((await getLead(db, lead.id)).nextActionAt).toEqual(new Date('2026-11-19T07:59:30Z'));
});
it('ignores group chats and other accounts', async () => {
  await seedLead(db, { status: 'invite_sent', providerId: 'ACoJane' });
  const group = message({ ...fromMe, attendees: [{ attendee_provider_id: 'ACoMe' }, { attendee_provider_id: 'ACoJane' }, { attendee_provider_id: 'ACoBob' }] });
  expect((await handle(group)).outcome).toBe('ignored');
  expect((await handle(message({ account_id: 'acc_other' }))).outcome).toBe('ignored');
});
it('accepts on new_relation, by provider id or by public identifier in any case', async () => {
  const a = await seedLead(db, { status: 'invite_sent', providerId: 'ACoJane' });
  expect(await handle(relation)).toEqual({ outcome: 'accepted', leadId: a.id });
  expect(await getLead(db, a.id)).toMatchObject({ status: 'accepted', nextActionAt: new Date('2026-11-17T11:00:00Z') });
  const b = await seedLead(db, { status: 'invite_sent', slug: 'Bob-Smith', providerId: 'ACoBobOld' });
  expect((await handle({ ...relation, user_provider_id: 'ACoBobNew', user_public_identifier: 'bob-smith' })).leadId).toBe(b.id);
});
it('ignores new_relation for a lead past the invite stage', async () => {
  const lead = await seedLead(db, { status: 'messaged', providerId: 'ACoJane' });
  expect((await handle(relation)).outcome).toBe('ignored');
  expect((await getLead(db, lead.id)).status).toBe('messaged');
});
it('logs every webhook, ignored ones included', async () => {
  await handle({ event: 'message_read' });
  expect((await listEvents(db)).map((x) => [x.type, x.payload])).toEqual([['webhook_received', { event: 'message_read', outcome: 'ignored' }]]);
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/webhooks`. Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** `parse.ts` and `handle.ts`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: handle Unipile message and relation webhooks`.

---

### Task 14: Access control and HTTP endpoints

**Files:**
- Create: `src/lib/auth/session.ts`, `src/lib/auth/session.test.ts`, `src/lib/auth/require-session.ts`, the request filter (see Step 3), `src/app/login/page.tsx`, `src/app/login/actions.ts`, `src/lib/deps.ts`, `src/app/api/tick/route.ts`, `src/app/api/webhooks/unipile/route.ts`

**Interfaces:**
- Consumes: `getEnv` (Task 1), `getDb` (Task 2), `createUnipileClient`, `createDryRunClient` (Task 7), `runTick` (Task 12), `processWebhook` (Task 13).
- Produces:
  - `SESSION_COOKIE = 'reachout_session'` and `SESSION_TTL_MS = 2_592_000_000` (30 days).
  - `createSessionToken(secret: string, now: Date): Promise<string>`. The token format is `<expiresAtMs>.<base64url HMAC-SHA256(secret, expiresAtMs)>`, built with Web Crypto only so the module also runs in the edge runtime.
  - `verifySessionToken(token: string | undefined, secret: string, now: Date): Promise<boolean>`.
  - `safeEqual(a: string, b: string): boolean`: constant time.
  - `isAuthorizedBearer(header: string | null, secret: string): boolean`.
  - `isPublicPath(pathname: string): boolean`: true for exactly `/login`, `/api/tick` and `/api/webhooks/unipile`.
  - `requireSession(): Promise<void>`: for server actions; redirects to `/login`.
  - `createEngineDeps(): Promise<EngineDeps>`: the real database, the Unipile client (wrapped with `createDryRunClient` when `env.dryRun`), `now: () => new Date()`, `random: Math.random`, and `sleep` based on `setTimeout`.
- Behavior:
  - **Request filter:** the matcher excludes `_next/static`, `_next/image` and `favicon.ico`. Public paths pass. Any other request needs a valid cookie; without one, `/api/*` gets `401 { "error": "unauthorized" }` and pages redirect to `/login`. The filter reads `process.env.APP_PASSWORD` as the HMAC secret, so changing the password logs every session out.
  - **Login action** `login(prev: { error?: string }, formData: FormData)`. A wrong password waits 1 s, then returns `{ error: 'Wrong password' }`. The right password sets the cookie (`httpOnly`, `secure` in production, `sameSite: 'lax'`, `path: '/'`, `maxAge` 30 days), then redirects to `/`.
  - **`GET /api/tick`** (`export const maxDuration = 180`; Vercel Hobby with Fluid compute allows up to 300). Without `Authorization: Bearer <CRON_SECRET>` it returns 401. Otherwise it schedules `after(async () => console.log('tick', JSON.stringify(await runTick(await createEngineDeps()))))` and returns `202 { "accepted": true }`. Errors raised inside `after` are logged with `console.error`.
  - **`POST /api/webhooks/unipile`**. Without the `Unipile-Auth: <WEBHOOK_SECRET>` header it returns 401. A body that is not JSON gets 400. Otherwise it calls `processWebhook(db, body, { accountId: env.unipileAccountId, now: new Date(), random: Math.random })` and returns `200 { outcome }`. A thrown error gives 500, so Unipile retries.

- [ ] **Step 1: Write the failing tests** `src/lib/auth/session.test.ts`:

```ts
it('accepts a fresh token and rejects it after 30 days', async () => {
  const token = await createSessionToken('s3cret', NOW);
  expect(await verifySessionToken(token, 's3cret', NOW)).toBe(true);
  expect(await verifySessionToken(token, 's3cret', new Date(NOW.getTime() + SESSION_TTL_MS + 1))).toBe(false);
});
it('rejects another secret, a tampered expiry and malformed tokens', async () => {
  const token = await createSessionToken('s3cret', NOW);
  expect(await verifySessionToken(token, 'other', NOW)).toBe(false);
  expect(await verifySessionToken(`${NOW.getTime() + 10 * SESSION_TTL_MS}.${token.split('.')[1]}`, 's3cret', NOW)).toBe(false);
  for (const bad of [undefined, '', 'abc', '1.2.3']) expect(await verifySessionToken(bad, 's3cret', NOW)).toBe(false);
});
it('checks bearer headers exactly', () => {
  expect(isAuthorizedBearer('Bearer cron', 'cron')).toBe(true);
  for (const header of ['Bearer cronx', 'cron', 'bearer  cron', null]) expect(isAuthorizedBearer(header, 'cron')).toBe(false);
});
it('lists only the three public paths', () => {
  expect(['/login', '/api/tick', '/api/webhooks/unipile'].every(isPublicPath)).toBe(true);
  expect(['/', '/settings', '/api/tick/extra', '/api/webhooks'].some(isPublicPath)).toBe(false);
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/auth`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the session module, `requireSession`, `createEngineDeps`, the login page and action, the two routes and the request filter. Check the installed Next.js major in `package.json`: on 16 or newer the filter is `src/proxy.ts` exporting `proxy`; on 15 it is `src/middleware.ts` exporting `middleware`.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Manual check.** Put `DATABASE_URL=pglite:./.data/dev`, dummy Unipile values, `CRON_SECRET=cron` and `WEBHOOK_SECRET=hook` in `.env.local`, then run `npm run dev`. Expected codes, in order: 401, 202, 401, `{"outcome":"ignored"}`, 307.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/tick
```
```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer cron' http://localhost:3000/api/tick
```
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' http://localhost:3000/api/webhooks/unipile
```
```bash
curl -s -X POST -H 'Unipile-Auth: hook' -H 'Content-Type: application/json' -d '{"event":"message_read"}' http://localhost:3000/api/webhooks/unipile
```
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/
```

- [ ] **Step 6: Commit** `feat: add password login, tick endpoint and webhook endpoint`.

---

### Task 15: Dashboard

**Files:**
- Create: `src/lib/leads/repo.ts`, `src/lib/leads/repo.test.ts`, `src/lib/leads/display.ts`, `src/lib/leads/display.test.ts`, `src/app/actions.ts`, `src/components/ImportForm.tsx`, `src/components/StatusBar.tsx`, `src/components/LeadTable.tsx`, `src/components/EventLog.tsx`
- Modify: `src/app/page.tsx`, `src/app/layout.tsx` (title "LinkedIn Reachout", links Dashboard / Settings)

**Interfaces:**
- Consumes: `importLeads` (Task 3), `getSettings`, `startBlockers` (Task 6), `getAppState`, `setRunning`, `getUsage` (Task 8), `requireSession`, `getDb`, `getEnv`.
- Produces:
  - Repository functions:
    - `listLeads(db, filter: { status?: LeadStatus }): Promise<Lead[]>`, newest `updatedAt` first, at most 1000.
    - `countLeadsByStatus(db): Promise<Record<LeadStatus, number>>`, with every status present.
    - `setLeadPaused(db, id: number, paused: boolean, now: Date): Promise<void>`.
    - `retryFailedLead(db, id: number, now: Date): Promise<boolean>`. Failed leads only: status becomes `failedFromStatus ?? 'queued'`, and `failureReason`, `failedFromStatus` and `retryCount` are cleared, with `nextActionAt = now`.
    - `removeLead(db, id: number): Promise<void>`.
    - `listRecentEvents(db, limit: number): Promise<Array<EventRow & { leadName: string | null }>>`, newest first.
  - Display helpers:
    - `describeNextAction(lead: Lead): { label: string; dueAt: Date | null } | null`. Labels by status: `queued` "Invite", `invite_sent` "Withdraw invite", `accepted`/`already_connected` "First message", `messaged` "Follow-up 1", `followup_1` "Follow-up 2", `followup_2` "Mark no response". Final statuses give null. A paused lead gets the prefix `Paused · `.
    - `leadDisplayName(lead): string`: first and last name, else the slug.
    - `formatLocal(date: Date, timezone: string): string`, in the format `yyyy-MM-dd HH:mm`.
  - Server actions in `src/app/actions.ts`: each calls `requireSession()` first and `revalidatePath('/')` last.
    - `importLeadsAction(prev, formData): Promise<ImportResult>`.
    - `toggleRunningAction(): Promise<{ blockers: string[] }>`. Starting returns the `startBlockers` without starting when there are any.
    - `pauseLeadAction(id)`, `resumeLeadAction(id)`, `retryLeadAction(id)`, `removeLeadAction(id)`.
- UI (spec §11):
  - **Status bar:**
    - Status counters for all 11 statuses.
    - Usage against the caps: `Invites today 12/35 · 7 days 80/190 · Messages today 30/90 · Profile views today 40/90`.
    - Banners: dry run ("Dry run: nothing is sent to LinkedIn"); auto-pause reason; "Invites paused until <local time>"; "Messages paused until <local time>".
    - A Start/Pause button that shows the blockers it returns.
  - **Import form:** a textarea and a summary, for example "2 added · 1 already contacted: jane-doe · 1 invalid: <line> (<error>)".
  - **Table:**
    - Status filter links (`/?status=replied`).
    - Columns: name with the headline under it; LinkedIn link; status with the failure reason; last action and its date; next action and its due date.
    - Row buttons: Pause or Resume; Retry for failed leads; Remove, behind `confirm('Remove this lead? Its history stays, and the person can be added again later.')`.
  - **Event log** of the last 50 events. `invite_sent` and `message_sent` events with `payload.dryRun` show `would send: <text>`.
  - All dates use `formatLocal` with `settings.window.timezone`.

- [ ] **Step 1: Write the failing tests:**

```ts
// repo.test.ts — db = await createTestDb() in beforeEach
it('counts leads for every status, zeros included', async () => {
  await seedLead(db); await seedLead(db); await seedLead(db, { status: 'replied' });
  const counts = await countLeadsByStatus(db);
  expect(Object.keys(counts)).toHaveLength(11);
  expect([counts.queued, counts.replied, counts.failed]).toEqual([2, 1, 0]);
});
it('retries a failed lead from the status it failed in, or from queued', async () => {
  const a = await seedLead(db, { status: 'failed', failedFromStatus: 'messaged', failureReason: 'x', retryCount: 1 });
  const b = await seedLead(db, { status: 'failed', failedFromStatus: null });
  expect(await retryFailedLead(db, a.id, NOW)).toBe(true);
  expect(await getLead(db, a.id)).toMatchObject({ status: 'messaged', failureReason: null, failedFromStatus: null, retryCount: 0, nextActionAt: NOW });
  await retryFailedLead(db, b.id, NOW);
  expect((await getLead(db, b.id)).status).toBe('queued');
});
it('refuses to retry a lead that is not failed', async () => {
  const lead = await seedLead(db, { status: 'messaged' });
  expect(await retryFailedLead(db, lead.id, NOW)).toBe(false);
  expect((await getLead(db, lead.id)).status).toBe('messaged');
});
it('removes a lead but keeps its events, so caps stay correct', async () => {
  const lead = await seedLead(db);
  await logEvent(db, { type: 'invite_sent', at: NOW, leadId: lead.id });
  await removeLead(db, lead.id);
  expect(await db.select().from(leads)).toEqual([]);
  expect((await getUsage(db, NOW, 'Europe/Paris')).invitesToday).toBe(1);
});
// display.test.ts
const D = new Date('2026-11-19T09:00:00Z');
const make = (patch: Partial<Lead>) => ({ status: 'queued', paused: false, nextActionAt: null, firstName: null, lastName: null, slug: 'jane-doe', ...patch }) as Lead;
it('describes the next action and its due time', () => {
  expect(describeNextAction(make({ status: 'messaged', nextActionAt: D }))).toEqual({ label: 'Follow-up 1', dueAt: D });
  expect(describeNextAction(make({ status: 'queued', paused: true, nextActionAt: D }))).toEqual({ label: 'Paused · Invite', dueAt: D });
  expect(describeNextAction(make({ status: 'replied' }))).toBeNull();
});
it('names a lead by name or slug and formats local dates', () => {
  expect(leadDisplayName(make({ firstName: 'Jane', lastName: 'Doe' }))).toBe('Jane Doe');
  expect(leadDisplayName(make({}))).toBe('jane-doe');
  expect(formatLocal(new Date('2026-11-17T07:30:00Z'), 'Europe/Paris')).toBe('2026-11-17 08:30');
});
```

- [ ] **Step 2: Run** `npm test -- src/lib/leads`. Expected: FAIL, functions not found.
- [ ] **Step 3: Implement** the repository and display helpers, then the page, components and actions.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Manual check** with `npm run dev` (PGlite database from Task 14):
  1. Log in.
  2. Paste `linkedin.com/in/a`, `linkedin.com/in/b` and `linkedin.com/company/acme`. The summary shows 2 added and 1 invalid line.
  3. Press Start. It shows "Save your templates in Settings first".
  4. Filter by `queued`. The table shows 2 leads.
  5. Remove one lead. The confirmation dialog appears before the lead goes.
- [ ] **Step 6: Commit** `feat: add dashboard with import, tracking table and controls`.

---

### Task 16: Settings page

**Files:**
- Create: `src/lib/settings/form.ts`, `src/lib/settings/form.test.ts`, `src/app/settings/page.tsx`, `src/app/settings/SettingsForm.tsx` (client component), `src/app/settings/actions.ts`

**Interfaces:**
- Consumes: `renderTemplate`, `TEMPLATE_VARIABLES`, `INVITE_NOTE_MAX_LENGTH` (Task 4), `saveSettings`, `getSettings`, `DEFAULT_SETTINGS` (Task 6), `leadTemplateValues` (Task 8), `requireSession`, `getDb`.
- Produces:
  - `formDataToSettings(form: FormData): unknown`.
    - Field names: `inviteNote`, `firstMessage`, `followup1`, `followup2`, `firstMessageMinMinutes`, `firstMessageMaxMinutes`, `followup1Days`, `followup2Days`, `finishDays`, `inviteExpiryDays`, `invitesPerDay`, `invitesPerWeek`, `messagesPerDay`, `profileViewsPerDay`, `jitterMaxSeconds`, `windowDays` (repeated, `'1'`…`'7'`), `windowStart`, `windowEnd`, `timezone`.
    - Numbers use `Number(value)`, except that an empty string becomes `NaN` so validation rejects it instead of silently using 0.
  - `saveSettingsAction(prev, formData): Promise<{ ok: boolean; errors: string[] }>`: `requireSession`, then `saveSettings`, then `revalidatePath('/settings')` and `revalidatePath('/')`.
- UI (spec §9):
  - The page loads the settings, plus up to 50 recent leads with a `firstName`, as `{ id, name, values }` for the preview.
  - **Template fields:** 4 textareas. Under each, a live preview rendered with `renderTemplate` for the lead picked in a "Preview with" select; missing variables show as "Missing: company". The invite note has a counter, `<rendered length>/300`, which turns red above 300; with no lead to preview, it counts the raw template.
  - **Other fields:** the variable names listed as help text; number inputs for delays and caps; Mon…Sun checkboxes; `time` inputs; a timezone text input.
  - **Saving:** a Save button, and the errors returned by the action listed above it.

- [ ] **Step 1: Write the failing tests:**

```ts
const fullForm = (over: Record<string, string> = {}) => {
  const fd = new FormData(); const s = DEFAULT_SETTINGS;
  const fields: Record<string, string> = { inviteNote: 'Hi {{first_name}}', firstMessage: s.templates.firstMessage, followup1: s.templates.followup1,
    followup2: s.templates.followup2, ...Object.fromEntries(Object.entries({ ...s.delays, ...s.caps }).map(([k, v]) => [k, String(v)])),
    windowStart: '08:30', windowEnd: '19:00', timezone: 'Europe/Paris', ...over };
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  fd.append('windowDays', '1'); fd.append('windowDays', '3');
  return fd;
};
it('maps the form fields to settings', () =>
  expect(formDataToSettings(fullForm({ invitesPerDay: '20' }))).toEqual({
    templates: { ...DEFAULT_SETTINGS.templates, inviteNote: 'Hi {{first_name}}' }, delays: DEFAULT_SETTINGS.delays,
    caps: { ...DEFAULT_SETTINGS.caps, invitesPerDay: 20 }, window: { days: [1, 3], start: '08:30', end: '19:00', timezone: 'Europe/Paris' },
  }));
it('turns an empty number field into NaN so validation rejects it', () =>
  expect((formDataToSettings(fullForm({ invitesPerDay: '' })) as Settings).caps.invitesPerDay).toBeNaN());
it('round-trips through saveSettings', async () =>
  expect((await saveSettings(await createTestDb(), formDataToSettings(fullForm()))).ok).toBe(true));
```

- [ ] **Step 2: Run** `npm test -- src/lib/settings/form`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `form.ts`, the action, the page and the client form.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 5: Manual check** with `npm run dev`:
  1. Type `{{company}}` in the invite note. The preview and the counter update as you type.
  2. Save with `{{firstname}}`. It shows `Invite note: unknown variable {{firstname}}`.
  3. Save valid templates. On the dashboard, Start now starts.
- [ ] **Step 6: Commit** `feat: add settings page with live template preview`.

---

### Task 17: Deployment guide and final check

**Files:**
- Modify: `README.md` (replace the scaffold README), `.env.example` (check it matches spec §3)

**Interfaces:**
- Consumes: everything above. Produces documentation only.

- [ ] **Step 1: Write `README.md`.**
  1. **What the app does:** one paragraph, with a link to `docs/spec.md`.
  2. **Local development:** `cp .env.example .env.local`, `DATABASE_URL=pglite:./.data/dev`, `DRY_RUN=true`, `npm run dev`, `npm test`.
  3. **Environment variables:** the table of spec §3. Generate secrets with:
     ```bash
     openssl rand -base64 32
     ```
  4. **Deployment, in order:**
     1. Unipile: start the 7-day trial, connect the LinkedIn account in the dashboard, then copy the DSN, an access token (`UNIPILE_API_KEY`) and the account id.
     2. Vercel: import the repo, add Neon from the Marketplace (it sets `DATABASE_URL`), and set the other variables with `DRY_RUN=true`.
     3. Migrations: run `DATABASE_URL=<neon url> npm run db:migrate`.
     4. Unipile webhooks, in Dashboard → Webhooks: one Messaging webhook (event `message_received`) and one Users webhook (event `new_relation`). Both use URL `https://<app>.vercel.app/api/webhooks/unipile` and the headers `Unipile-Auth: <WEBHOOK_SECRET>` and `Content-Type: application/json`.
     5. cron-job.org: a job every 5 minutes, `GET https://<app>.vercel.app/api/tick`, with the header `Authorization: Bearer <CRON_SECRET>`.
  5. **First run in dry run:**
     1. Save the templates.
     2. Paste 3 profiles, one of them an existing 1st-degree connection.
     3. Press Start.
     4. After a few ticks, check that the event log shows `would send: …` and that each lead's company and position look right. This also confirms the `work_experience` field mapping against a real Unipile response.
     5. Set `DRY_RUN=false` and redeploy.
  6. **Costs:** spec §14.
- [ ] **Step 2: Final check:**

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

  Expected: every command passes with no errors.
- [ ] **Step 3: Commit** `docs: add setup and deployment guide`.
