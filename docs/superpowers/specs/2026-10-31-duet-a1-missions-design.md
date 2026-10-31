# Duet A1 — Missions pipeline (design)

Reviewed by the architect agent on 2026-10-31. Wassim decided: own table, 5 **business** days (Paris).

## Decisions
1. Stage ids are ASCII in DB/code: `piste|applied|talking|interview|offer|signed|refused`; French labels in UI only.
2. History = append-only table `openduet_mission_events`, UNIQUE (mission_id, source_hash) → re-reading a mail is a no-op.
3. Forward may skip stages (invite while `applied` → `interview`). A signal at or below the current stage only refreshes `last_inbound_at`.
4. Mail matching by thread, then contact, never company alone (platform senders hide the company).
5. Relance text = French template, no LLM, stored in app only (Gmail draft is A4).
6. Defaults (not asked): jours fériés ignored for now; at most 2 relances per stage.

## Batch 1 — schema
- `src/db/schema/openduet-missions.ts` (export from schema index):
  - `openduet_missions`: id, owner_user_id→users cascade, company, role?, company_key, role_key (normalized, default ''),
    stage, review ('proposed'|'active'|'dismissed'), title, thread_ids text[], contact_emails text[], stage_entered_at,
    last_inbound_at, last_outbound_at, closed_at, created_at, updated_at.
    CHECKs: stage list; review list; `(stage IN ('signed','refused')) = (closed_at IS NOT NULL)`.
    Indexes: (owner, review, stage); GIN thread_ids; partial UNIQUE (owner, company_key, role_key)
    WHERE company_key<>'' AND stage NOT IN ('signed','refused') AND review<>'dismissed'.
  - `openduet_mission_events`: id, mission_id cascade, owner, type ('stage'|'inbound'|'relance_sent'), from_stage,
    to_stage, source ('mail'|'chat'|'app'), source_hash?, at. UNIQUE (mission_id, source_hash).
  - `openduet_mission_relances`: id, mission_id cascade, owner, window_start, body, status ('draft'|'sent'|'dismissed'),
    created_at. UNIQUE (mission_id, window_start) = dedup.
- `openduet_items.mission_id` → missions set null, indexed, CHECK `mission_id IS NULL OR kind IN ('interview','followup')`.
- Migration 0069 via `bun run db:generate --name openduet_missions`; never hand-edit the journal; migrate dev + test DB.

## Batch 2 — pure modules
- `missions/stages.ts`: STAGES, rank, isTerminal, canTransition, nextStage(current, signal).
- `missions/mail-signal.ts`: missionSignal (rejection > offer > invite > reply), companyKey, contactOf (null for platforms).
- `items/paris-time.ts`: parisBusinessDaysSince(anchor, now).
- `missions/relance.ts`: silenceAnchor, relanceDue (active, applied|talking, ≥5 business days, <2 per stage), relanceBody.

## Batch 3 — store (`missions/store.ts`)
advance() in a transaction: insert event on-conflict-nothing, then compare-and-set on stage; re-read + canTransition once.
Also matchMail, createPiste, upsertFromChat, recordInbound, list, get, patch (incl. mergeInto), ensureRelance, setRelanceStatus.

## Batch 4 — intake hook (D unchanged)
Optional `missions` dep; after candidates, before advanceCursor: thread → contact → single company match → else proposed piste.
Failure fails the mail scanner (cursor stays). Relance sweep only when the mail scanner succeeded. Wire in src/index.ts.

## Batch 5 — tool, routes, brief
`mission_update` tool (0 match → create active; 1 → advance; >1 → ambiguous). Routes at /api/openduet/missions
(GET, GET :id, PATCH :id, PATCH :id/relances/:rid). Brief `missions` section; loader failure → couldNotCheck "Missions".
Mobile: render the section on the brief card + Missions screen.

## Tests
stages matrix · mail-signal fixtures (job alert ≠ offer) · paris business days (weekend, DST) · store integration
(parallel advance, dedup, illegal move, two roles one company, relance windows, owner isolation, set null) ·
intake fake-google (thread reply → talking, unmatched Malt → one piste, items unchanged, failed scanner → no relance) ·
routes (409, 404, mergeInto) · brief section.

## Answered by Wassim (2026-10-31)
- Contacts: YES — intake adds one Gmail query `from:(a OR b …)` for active missions' contact_emails, capped at 20.
- Rejections: mail may move a mission to `refused` or `offer` only on a thread or contact match (no undo button).
