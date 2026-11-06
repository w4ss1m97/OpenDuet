# Duet Single Source of Truth (sub-project D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Duet gathers interviews, follow-ups, bills, fines, deadlines, Apple Notes ideas and project status into one `openduet_items` store and reminds Wassim on his iPhone, even while the Mac is off.

**Architecture:** A deterministic intake runner (server) calls existing Gmail/Calendar tools and the Mac bridge, turns what it reads into item candidates through pure parsers, classifies them (active vs. proposed), and upserts them by `sourceHash`. It runs at server start and every 30 min. The Duet iOS app syncs active items and schedules local notifications; proposed items are sorted in an "À trier" screen. Nothing in OpenBot's own tables is changed.

**Tech Stack:** Bun, TypeScript, Hono, drizzle-orm (Postgres), zod, Expo (expo-router, expo-notifications).

**Spec:** `docs/superpowers/specs/2026-10-30-duet-single-source-of-truth-design.md`

**Deviations from the spec (to confirm in review):**
- Scanners are a deterministic server runner (pure parsers + direct tool calls), not LLM skills run by the proactive engine: cheaper, testable, and the 30-min run costs no model tokens. Fuzzy items still land as cards.
- GitHub open issues, Notion and Todoist are left out of this plan; the project scanner reads local `session-notes.md` and the last commit only. They fit sub-project B.

## Global Constraints

- All paths below are relative to `openbot/` unless they start with `docs/`.
- Do not modify existing OpenBot tables; new tables only, in a new schema file.
- Item `kind`: `interview`, `followup`, `bill`, `fine`, `deadline`, `idea`, `todo`, `project_status`.
- Item `status`: `proposed`, `active`, `done`, `dismissed`.
- Active (auto) only when kind ∈ {`interview`, `bill`, `fine`} AND date explicitly read (AND amount for `bill`/`fine`); everything else → `proposed`.
- An existing `sourceHash` (per owner) is never inserted again, whatever its status.
- Default reminders: interview → D-1 18:00 and 1 h before; bill/fine → D-3 09:00 and D-day 09:00; deadline → D-1 09:00; other kinds → none. Times are Europe/Paris.
- Intake runs at server start, then every 30 min while running.
- iOS: sync window 14 days, soonest first, max 64 scheduled notifications; actions **Done** and **Snooze 1 h**.
- Apple Notes are read-only. Duet never pays anything. No LinkedIn scraping.
- A scanner failure never moves its cursor and never blocks other scanners; the failed source is named in the brief.
- User-facing copy is French.
- Test: `cd openbot && bun test <path>`; typecheck: `cd openbot/server && bunx tsc --noEmit`, `cd openbot/mobile && bun run typecheck`.

## Review Focus

1. **Mac bridge prompts on every run**: `host_run_command` always asks on the Mac; a 30-min notes scan must use an "always allow" grant for the one fixed `osascript` command, and when no grant exists the scanner must fail as "source unreadable", not hang. → Task 6 test `notes scanner reports unreadable when host call is refused or times out`.
2. **Timezones and all-day events**: an all-day interview or a due date with no time must still produce reminders at Paris local times, including across DST. → Task 3 test `defaultRemindAt uses Europe/Paris across DST`.
3. **Reminders in the past**: an item found late (Mac was off) must not schedule notifications in the past, and an overdue bill still shows in the brief. → Task 3 test `drops reminders already in the past`; Task 10 test `never schedules a past date`.
4. **Same email seen twice / edited note**: re-reading the same message or an unchanged note creates nothing; an edited note yields a new card only for new lines. → Task 2 test `upsert is a no-op for a dismissed sourceHash`; Task 6 test `hash is per line, so unchanged lines are ignored`.
5. **Amounts in French format** (`1 234,56 €`, `45€`): parsed exactly; unreadable amount → proposed, never active. → Task 4 test `parses French amounts`.

---

### Task 1: Tables and migration

**Files:**
- Create: `server/src/db/schema/openduet-items.ts`
- Modify: `server/src/db/schema/index.ts` (add `export * from "./openduet-items";`)
- Modify: `server/drizzle.config.ts` (add `"./src/db/schema/openduet-items.ts"` to `schema`, beside line 44)
- Create: `server/drizzle/00NN_openduet_items.sql` (generated)

**Interfaces:**
- Produces: `openduetItems`, `openduetIntakeCursors` tables; types `ItemKind`, `ItemStatus` (string unions from Global Constraints), `Scanner = "mail" | "calendar" | "notes" | "projects"`, `OpenduetItem = typeof openduetItems.$inferSelect`.

- [ ] **Step 1: Define `openduetItems`** following `openduetTasks` in `server/src/db/schema/openduet.ts:90-132`: columns from spec §5 (`remindAt` as `timestamp(...).array()`, `amount` as `numeric(12,2)`, `currency` text default `'EUR'`), FK `ownerUserId`→users (cascade), `channelId`→channels (set null), `taskId`→openduetTasks (set null); `uniqueIndex("openduet_items_owner_source_hash_idx")` on (ownerUserId, sourceHash); `index` on (ownerUserId, status, dueAt); `check` constraints on kind and status.
- [ ] **Step 2: Define `openduetIntakeCursors`**: PK (ownerUserId, scanner); `scanner` text check in (`mail`,`calendar`,`notes`,`projects`); `lastSuccessAt` timestamptz null; `lastError` text null; `cursor` jsonb default `{}`.
- [ ] **Step 3: Generate migration** — Run: `cd openbot/server && bun run db:generate`. Expected: one new SQL file creating both tables, nothing else touched.
- [ ] **Step 4: Apply** — Run: `bun run db:migrate`. Expected: exit 0.
- [ ] **Step 5: Typecheck** — `bunx tsc --noEmit`, expected clean.
- [ ] **Step 6: Commit** `feat(duet): add openduet_items and intake cursor tables`

### Task 2: Item store

**Files:**
- Create: `server/src/openduet/items/store.ts`
- Test: `server/tests/openduet-items-store.integration.test.ts` (DB via `createDatabase(testDatabaseUrl(), TEST_POOL)` as in `server/tests/openduet-offers.integration.test.ts:20`)

**Interfaces:**
- Consumes: Task 1 tables.
- Produces:
  - `type ItemCandidate = { kind: ItemKind; title: string; why?: string; dueAt?: Date; allDay?: boolean; amount?: number; currency?: string; channelId?: string; sourceApp: string; sourceLink?: string; sourceHash: string; dateExplicit: boolean }`
  - `createItemStore(db: Database)` returning:
    - `insertIfNew(ownerUserId: string, c: ItemCandidate, status: ItemStatus, remindAt: Date[]): Promise<OpenduetItem | null>` (null when hash exists)
    - `list(ownerUserId: string, q: { status?: ItemStatus[]; remindFrom?: Date; remindTo?: Date }): Promise<OpenduetItem[]>`
    - `setStatus(ownerUserId: string, id: string, status: ItemStatus): Promise<OpenduetItem>`
    - `snooze(ownerUserId: string, id: string, until: Date): Promise<OpenduetItem>` (adds `until` to `remindAt`)
    - `getCursor(ownerUserId: string, scanner: Scanner): Promise<{ lastSuccessAt: Date | null; cursor: unknown }>`
    - `advanceCursor(ownerUserId: string, scanner: Scanner, cursor: unknown, at: Date): Promise<void>`
    - `recordFailure(ownerUserId: string, scanner: Scanner, error: string): Promise<void>` (does not touch `lastSuccessAt`/`cursor`)
    - `countSince(ownerUserId: string, since: Date): Promise<{ added: number; proposed: number }>`

- [ ] **Step 1: Write failing tests**: `insertIfNew returns the item, then null for the same hash`; `upsert is a no-op for a dismissed sourceHash` (insert, setStatus dismissed, insertIfNew again → null, status still `dismissed`); `list filters by status and remind window`; `snooze appends to remindAt`; `recordFailure keeps the previous cursor`; `setStatus on another owner's item throws`.
- [ ] **Step 2: Run** `bun test server/tests/openduet-items-store.integration.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** with `onConflictDoNothing` on the unique index and `returning()`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(duet): item store with dedup and intake cursors`

### Task 3: Classifier and default reminders (pure)

**Files:**
- Create: `server/src/openduet/items/classify.ts`
- Test: `server/tests/openduet-items-classify.test.ts`

**Interfaces:**
- Produces: `classify(c: ItemCandidate): ItemStatus` (`active` | `proposed`); `defaultRemindAt(c: ItemCandidate, now: Date): Date[]` (Europe/Paris rules from Global Constraints, past dates dropped, sorted).

- [ ] **Step 1: Write failing tests**: `interview with explicit date is active`; `bill without amount is proposed`; `idea is always proposed`; `interview 2026-11-12T14:00 Paris → reminders 2026-11-11T18:00 and 2026-11-12T13:00 Paris`; `bill due 2026-11-20 (all-day) → 2026-11-17T09:00 and 2026-11-20T09:00 Paris`; `defaultRemindAt uses Europe/Paris across DST` (deadline 2027-03-29 → 2027-03-28T09:00+02:00); `drops reminders already in the past`; `idea has no reminders`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** using `Intl.DateTimeFormat` with `timeZone: "Europe/Paris"` to compute local wall-clock times (no new dependency).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(duet): classify items and compute default reminders`

### Task 4: Mail parsers (pure)

**Files:**
- Create: `server/src/openduet/items/mail-parsers.ts`
- Create fixtures: `server/tests/fixtures/duet-mail/{malt,free-work,collective,linkedin,bill,antai,unrelated}.json` (shape = one message as returned by `google-workspace/gmail_search_messages`; anonymised, invented names)
- Test: `server/tests/openduet-mail-parsers.test.ts`

**Interfaces:**
- Produces: `type MailMessage = { id: string; threadId?: string; from: string; subject: string; date: string; snippet: string; body?: string }`; `parseMail(m: MailMessage): ItemCandidate | null`; `MAIL_QUERY: string` (Gmail search string covering the senders below, `newer_than` added by the caller).
- Rules: sender domain → parser. `malt.fr`/`malt.com`, `free-work.com`, `collective.work` → `followup` (or `interview` when subject/body mentions entretien/interview with a date), channel `missions`; `linkedin.com` → `followup` only for messages/InMail notifications, channel `missions`; `antai.gouv.fr` → `fine`; invoice keywords (facture, échéance, prélèvement, à payer) → `bill`, channel `maison` unless sender is a known pro service. `sourceHash = "gmail:" + id`. `sourceLink = "https://mail.google.com/mail/u/0/#all/" + id`. `dateExplicit` true only when a date was parsed from text.

- [ ] **Step 1: Write failing tests**: one per fixture asserting `kind`, `channelId`, `dueAt`, `amount`, `dateExplicit`; `unrelated returns null`; `parses French amounts` (`"1 234,56 €"` → 1234.56, `"45€"` → 45, `"45,00 EUR"` → 45); `bill with unreadable amount has no amount` (→ classify gives proposed).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** parsers as a table `{ match(from, subject): boolean; parse(m): ItemCandidate | null }[]`; French date parsing for `12/11/2026`, `12 novembre 2026`, `avant le 20/11`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(duet): parse freelance platform, bill and fine emails`

### Task 5: Calendar parser (pure)

**Files:**
- Create: `server/src/openduet/items/calendar-parser.ts`
- Test: `server/tests/openduet-calendar-parser.test.ts`

**Interfaces:**
- Produces: `type CalendarEvent = { id: string; summary: string; description?: string; start: { dateTime?: string; date?: string }; htmlLink?: string }` (shape returned by `google-workspace/calendar_list_events`); `parseEvent(e: CalendarEvent): ItemCandidate | null`.
- Rule: summary/description matches `/entretien|interview|call client|qualif|échange avec|rdv client/i` → `interview`, channel `missions`, `dateExplicit: true`, `allDay` when only `date`. `sourceHash = "gcal:" + id + ":" + start`. Other events → null.

- [ ] **Step 1: Failing tests**: `"Entretien Société X" → interview`; `all-day event sets allDay`; `"Dentiste" → null`; `moved event (new start) gets a new hash`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(duet): turn interview calendar events into items`

### Task 6: Apple Notes scanner

**Files:**
- Create: `server/src/openduet/items/notes-scanner.ts`
- Create fixture: `server/tests/fixtures/duet-notes/osascript-output.txt`
- Test: `server/tests/openduet-notes-scanner.test.ts`

**Interfaces:**
- Produces:
  - `NOTES_OSASCRIPT: string` — fixed JXA command printing JSON `[{id,name,modified,body}]` for notes modified after an ISO date passed as argv; body converted to plain text.
  - `type HostRunner = (command: string) => Promise<{ ok: boolean; output?: string; error?: string }>` (wraps `broker.callHost({ kind: "run_command", ... })`, `server/src/host-access/broker.ts:264`; result shape `HostAccessDesktopResult` in `host-access/schema.ts:37`)
  - `parseNotes(json: string): ItemCandidate[]`
  - `scanNotes(run: HostRunner, since: Date | null, timeoutMs = 60000): Promise<{ ok: true; candidates: ItemCandidate[]; cursor: { since: string } } | { ok: false; error: string }>`
- Rules: one candidate per line that is a checklist item (`- [ ]`, `☐`), or starts with `TODO`, `À faire`, `Idée`, `Penser à`, `Relancer`. `- [ ]`/`TODO`/`À faire`/`Penser à`/`Relancer` → `todo`; `Idée` → `idea`. All `dateExplicit: false` (→ proposed). `sourceHash = "notes:" + noteId + ":" + sha1(normalisedLine)`. `sourceLink` = note title.

- [ ] **Step 1: Failing tests**: `parses checklist and keyword lines from fixture`; `hash is per line, so unchanged lines are ignored` (same note, one added line → only the new hash differs); `notes scanner reports unreadable when host call is refused or times out` (runner rejecting, returning `ok:false`, and never resolving → `{ok:false}` within timeout).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Manual check on the Mac**: start the desktop app, run the scanner once from a test script, choose **Always allow** for this exact command in the native prompt; second run must not prompt. Record the result in `.claude/session-notes.md`.
- [ ] **Step 6: Commit** `feat(duet): read-only Apple Notes scanner via the Mac bridge`

### Task 7: Project scanner

**Files:**
- Create: `examples/wassim/projects.yaml` (`projects: [{ id, name, path?, github? }]`, starting with OpenDuet: `path: ~/src/OpenDuet`, `github: <owner/repo from git remote>`)
- Create: `server/src/openduet/items/project-scanner.ts`
- Test: `server/tests/openduet-project-scanner.test.ts`

**Interfaces:**
- Produces: `loadProjects(dir: string): Project[]` (reads `projects.yaml` from `TENANT_PACKAGE_DIR`, zod-validated, empty list if file absent); `scanProject(p: Project, read: { file(path: string): Promise<string | null>; lastCommit(path: string): Promise<string | null> }): Promise<ItemCandidate>`.
- Rule: one `project_status` candidate per project per day: `title = name + " — " + first line of "Exact next step" in session-notes.md` (or `"pas de notes"`), `why` = last commit subject, channel `projets`, `sourceHash = "project:" + id + ":" + YYYY-MM-DD`. Reads go through the host runner (`cat`, `git -C <path> log -1 --format=%s`) — both covered by an always-allow grant like Task 6.

- [ ] **Step 1: Failing tests**: `uses the Exact next step line`; `missing notes gives "pas de notes"`; `one hash per project per day`; `loadProjects returns [] without file`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(duet): daily project status items from session notes`

### Task 8: Intake runner and schedule

**Files:**
- Create: `server/src/openduet/items/intake.ts`
- Modify: `server/src/index.ts` (start next to `proactiveSweep` ~line 2272 with `repeatAfterEach`, every 30 min, first run immediately; stop beside line 2831)
- Test: `server/tests/openduet-intake.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7; `CallTool` type from `server/src/openduet/brief.ts:61` with `GMAIL_SEARCH`/`CALENDAR_LIST` constants (brief.ts:27-28); a `HostRunner` built from the host-access broker.
- Produces: `type IntakeReport = { at: Date; added: number; proposed: number; failed: { scanner: Scanner; error: string }[] }`; `runIntake(deps: { store; callTool: CallTool; host: HostRunner | null; projects: Project[]; now: () => Date }, ownerUserId: string): Promise<IntakeReport>`; `lastIntakeReport(ownerUserId): IntakeReport | null` (in memory).
- Rules: scanners run independently (`Promise.allSettled`); for each candidate `classify` + `defaultRemindAt` + `insertIfNew`; cursor advances only for a scanner that fully succeeded; `host === null` → notes and projects fail with `"Mac bridge non connecté"`. Owner = the user owning the `duet` bot.

- [ ] **Step 1: Failing tests** (fake callTool + fake host, real DB): `adds active interview and proposed idea`; `gmail failure leaves its cursor and still runs calendar`; `host null marks notes and projects as failed`; `second run with same inputs adds nothing`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** and wire in `index.ts`. **Step 4: Run** → PASS; typecheck clean.
- [ ] **Step 5: Commit** `feat(duet): run intake at start and every 30 minutes`

### Task 9: Brief tool and item routes

**Files:**
- Create: `server/src/openduet/items/routes.ts` and `server/src/openduet/items/tool.ts`
- Modify: `server/src/app.ts` (mount `/api/openduet/items` next to the other openduet routes at 1702-1724, same `coworker?.openduet` gate and `requireUser`)
- Modify: `server/src/openduet/wiring.ts` (add the tool to `createOpenDuetTools`, line 137)
- Modify: `examples/wassim/skills.yaml` (`brief-du-matin`: add tool `openduet/intake_report` and instruction: say in one sentence what was added since last time, how many cards wait, what is due within 48 h, and name any failed source and that it reconnects from Connexions)
- Test: `server/tests/openduet-items-routes.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 store, Task 8 `lastIntakeReport`.
- Produces:
  - `GET /api/openduet/items?status=active,proposed&remindFrom=ISO&remindTo=ISO` → `{ items: OpenduetItem[] }`
  - `POST /api/openduet/items/:id/status` body `{ status: "active" | "done" | "dismissed" }` → `{ item }`
  - `POST /api/openduet/items/:id/snooze` body `{ minutes: number }` (1–1440) → `{ item }`
  - Tool `intake_report` (ref `openduet/intake_report`, `GrantedTool` shape as `openduetTools` in brief.ts:315) → `{ since, added, proposed, dueWithin48h: {title, dueAt}[], failedSources: string[] }`

- [ ] **Step 1: Failing tests**: `GET returns only the caller's items`; `status change to done`; `snooze 60 adds a reminder 60 min from now`; `401 without user`; `400 on unknown status`; `intake_report lists failed sources`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (zod validation like `pages.ts`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(duet): item routes and intake report for the brief`

### Task 10: iOS reminders

**Files:**
- Create: `mobile/src/reminders-plan.ts` (pure), `mobile/src/reminders.ts` (expo side), `mobile/src/reminders-plan.test.ts`
- Modify: `mobile/app/_layout.tsx` (call `syncReminders()` on launch and on `AppState` → `active`; register notification response listener)

**Interfaces:**
- Consumes: Task 9 routes via `api<T>()` from `mobile/src/api.ts:2`.
- Produces: `type Item` = JSON of `OpenduetItem` (dates as ISO strings), declared in `reminders-plan.ts`; tapping a notification opens `/items` (Task 11); `planReminders(items: Item[], now: Date): { id: string; itemId: string; at: Date; title: string; body: string }[]` (window 14 days, future only, sorted, max 64; id = `itemId + ":" + at.toISOString()`); `syncReminders(): Promise<void>` (fetch, `cancelAllScheduledNotificationsAsync`, schedule each with category `duet-item`); category `duet-item` with actions `done` ("Fait") and `snooze` ("Plus tard (1 h)"); pending offline actions stored in SecureStore key `duet.pendingActions` and replayed at the start of `syncReminders`.

- [ ] **Step 1: Failing tests** (`cd openbot && bun test mobile/src/reminders-plan.test.ts`): `keeps only the next 14 days`; `never schedules a past date`; `caps at 64, soonest first`; `body says the amount for bills` (e.g. `"45,00 € — échéance 20/11"`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** both files and the layout hook. **Step 4: Run** → PASS; `bun run typecheck` clean.
- [ ] **Step 5: Manual check in the iOS Simulator**: create an item due in 3 min with a reminder in 2 min, sync, stop the server, confirm the notification fires and **Fait** is queued then sent after the server restarts.
- [ ] **Step 6: Commit** `feat(duet-mobile): schedule local reminders from items`

### Task 11: "À trier" screen

**Files:**
- Create: `mobile/app/items.tsx`
- Modify: the app's navigation entry that lists screens (side panel in `mobile/app/_layout.tsx`) to add "À trier (N)"

**Interfaces:**
- Consumes: `GET /api/openduet/items?status=proposed`, `POST .../status`.
- Produces: screen listing proposed items (title, why, source); swipe right → `active`, swipe left → `dismissed`; reuse the existing swipe-card component if the app has one, else two buttons "Garder" / "Ignorer".

- [ ] **Step 1: Implement** the screen. **Step 2:** `bun run typecheck` clean.
- [ ] **Step 3: Manual check** in the Simulator: a proposed note idea appears, swipe right moves it to active, it disappears from the list and never comes back after the next intake.
- [ ] **Step 4: Commit** `feat(duet-mobile): sort proposed items`

### Task 12: End-to-end with the fake Google server

**Files:**
- Create: `server/tests/openduet-intake-fake-google.test.ts`

- [ ] **Step 1: Write the test**: start the fake server as `server/tests/google-workspace-fake.test.ts` does; deliver the Task 4 Malt and bill fixtures with `POST /__fake/deliver`; run `runIntake` with `host: null`; assert one active bill with 2 reminders, one followup, report lists notes and projects as failed; run again → `added: 0`.
- [ ] **Step 2: Run** `bun test server/tests/openduet-intake-fake-google.test.ts` → PASS.
- [ ] **Step 3: Full suite** `cd openbot && bun test` and both typechecks → all green.
- [ ] **Step 4: Commit** `test(duet): end-to-end intake against the fake Google server`; update `.claude/session-notes.md`.
