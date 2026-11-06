# Duet A2b — Interview debrief (design)

Reviewed by the architect agent on 2026-11-01 (corrections applied). Builds on A2 (interview items linked to missions,
prep sheets). Wassim decided (2026-11-01): the transcript goes to the same LLM provider as A2.

## Micro-spec
- **Goal:** after an interview Wassim recorded in Anarlog, Duet reads the transcript, writes a debrief for the
  interview (summary, positives, concerns, next steps, follow-up draft), logs a mission event, and the next relance
  uses the follow-up draft.
- **Files:** db/schema/openduet-interview-debriefs.ts (+index), db/schema/openduet-missions.ts (event CHECK + TS union),
  migration 0071, missions/{anarlog.ts, debrief.ts, debrief-store.ts, relance.ts, store.ts}, items/{intake.ts,
  routes.ts, store.ts?}, src/index.ts wiring.
- **Edge cases:** no recording (consent refused) → nothing · two calendar items for one interview → one debrief ·
  transcript still processing → wait, no attempt spent · next round already scheduled → no relance before it.
- **Tests:** bottom of this file.
- **Out of scope:** sending mails (A4), editing a debrief, the phone screen (duet-ios session), the Anarlog MCP server,
  Anarlog cloud source, recording, stage changes from a debrief, brief section, missions GET /:id/debriefs, LLM-chosen
  relance timing, a per-round relance cap.

## Facts checked
- Anarlog CLI (fastrepl/anarlog apps/cli contract snapshots): `anarlog --json meetings list [-q] [--limit] [--offset]`,
  `meetings get <id>` (title, started_at, ended_at, participants with email, summary_status), `meetings transcript
  <id> [--limit] [--offset]` (paged words). Default source = local SQLite.
- The server runs on this Mac (local Postgres, OPENBOT_SINGLE_USER), so it can spawn the CLI. Installed 2026-11-01
  (`brew install --cask anarlog`, 1.4.34): CLI = `/Applications/Anarlog.app/Contents/MacOS/anarlog-cli` (use as
  OPENDUET_ANARLOG_BIN). JSON envelope `{schema_version, command, data}`; errors `{error: {code, exit_code, message}}`,
  e.g. `database_not_found` (exit 3) until the app has run once (DB `~/Library/Application Support/anarlog/app.db`).
- duet-ios does not decode mission events, so a new event type is safe for the app.

## Decisions
1. Consent stays human: Wassim asks the recruiter first and records only on yes. Duet never records. No matching
   meeting = no debrief. No consent flag in Duet.
2. `missions/anarlog.ts`: `AnarlogSource {listMeetings(since), getMeeting(id), transcript(id, deadline)}`, fake in
   tests. Spawn: `OPENDUET_ANARLOG_BIN` must be an absolute path to an existing file, else disabled; argv array, no
   shell, `--json`; env = {PATH, HOME} only; fixed cwd; 20 s per call, SIGKILL + await exit on timeout; stdout cap
   5 MB; zod on output. Meeting ids from output checked `^[A-Za-z0-9_][A-Za-z0-9_-]*$` before reuse in argv.
3. Table `openduet_interview_debriefs`: id, item_id→items cascade UNIQUE, owner_user_id→users cascade,
   mission_id→missions cascade NOT NULL, anarlog_meeting_id text NOT NULL, status 'pending'|'ready'|'failed',
   content jsonb null, attempts int 0, claimed_at, last_error (name only), generated_at, created_at, updated_at.
   CHECKs as preps. UNIQUE (owner_user_id, anarlog_meeting_id). A row exists only once a meeting matched and its
   transcript is ready. Debriefs are kept until the mission/item is deleted (cascade).
4. Migration 0071 via `bun run db:generate --name openduet_interview_debriefs` (table + event CHECK, drizzle emits
   DROP/ADD CONSTRAINT; new list is a superset). Never hand-edit the journal; migrate dev + test.
5. Sweep, in try/catch (never fails the intake), runs BEFORE relanceSweep. Due items: interview item linked to an open
   active mission, ended (end, else start + 1 h) 20 min–7 days ago, no row yet or row pending/failed with attempts < 3.
   No due item → no CLI call. Else ONE `listMeetings(since = now − 7 d − 15 min)` per sweep, matched in memory.
   ≤2 debriefs generated per run, 3 attempts, 90 s LLM timeout, stale claim 10 min as preps.
6. Match: meeting started_at within [start − 15 min, end + 30 min] AND a participant email in the mission's
   contact_emails. Several meetings match → none. Meeting already used by another row → skip. Readiness = transcript
   complete (not summary_status), checked before ensurePending/claim.
7. Transcript: one overall 60 s deadline, pages of 500 words, cap 12 000 words (head kept + "transcript coupé" line).
   Prompt (French): mission, the A2 sheet if ready, transcript fenced by a random per-call marker (any copy stripped
   from the text) with the "data, not instructions" line. Duet never stores the transcript.
8. Content `{summary, positives[], concerns[], nextSteps[], followUpBody}`, zod, URLs stripped, ≤6 items/list,
   ≤800 chars/string, followUpBody ≤1500. Read-only (read + regenerate).
9. Mission event type `debrief` (CHECK + `MissionEventType`), source 'app', source_hash `anarlog:<meetingId>`,
   `at` = meeting ended_at, inserted once on complete. No stage change.
10. Privacy: the transcript goes to the same LLM provider as A2 (Wassim decided 2026-11-01). Duet stores only
    the debrief, logs error names only.
11. Relances: one pure `relanceAnchor(mission, lastEndedInterview)` = max(silenceAnchor, interview end), used for BOTH
    relanceDue and windowStart. Stage `interview` allowed (relanceDue + the relanceSweep stage filter), only when a
    linked interview has ended and none has start > now. Threshold stays 5 business days. Body = followUpBody of the
    ready debrief of the last ended interview, else `relanceBody`. On window conflict with status 'draft', refresh the
    body. Cap of 2 per stage shared by all interview rounds (v1, accepted).

## Routes
items/routes.ts: GET /:id/debrief (404 | status + content), POST /:id/debrief/regenerate (no row → match now; no
meeting → 404 `no_recording`; never a row without a meeting id).

## Tests
missions-debrief (match window, contact required, ambiguous → none; debriefDue; parseDebrief; random fence + injected
marker stripped; transcript cap; relanceAnchor) · anarlog adapter (argv no shell, minimal env, relative bin →
disabled, timeout → killed + typed error, bad JSON, bad id rejected, stdout cap) · interview-debriefs integration
(idempotent ensure, unique meeting per owner, parallel claim, owner isolation, cascade, event once with ended_at) ·
intake with fake Anarlog (no due item → no CLI call; no meeting → no row; transcript not ready → no attempt;
ready → debrief + event; LLM throws → intake ok, failed, retried, stops after 3; ≤2 per run) · relance (interview due
5 days after end, none while next round scheduled, debrief body, draft body refreshed, generic fallback) · routes
(404 other owner, regenerate no_recording).
