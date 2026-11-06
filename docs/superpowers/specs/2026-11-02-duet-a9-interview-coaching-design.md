# A9 — Interview coaching: defensible CV lines + mock interview (draft, architect review pending)

## Problem
In interviews Wassim cannot defend what his CV says: he forgets the technical details, gives unstructured
answers, freezes, and undersells his work. Story cards today repeat CV bullets verbatim, which helps him remember
*what* he did but not *how it works* or *how to say it*.

## Goal
Every CV bullet gets a "deep" card that lets him defend it, and Duet can run a mock interview on those cards.
The mock interview grades his typed answer and feeds the result into the existing Leitner schedule.

## Scope (server only; iOS and the bot chat are out of scope)

### 1. Deep cards: one per CV bullet
- New revision kind `deep`, with exactly one bullet id.
- `question` = "Expliquez : <bullet verbatim>".
- `answer` = the bullet verbatim plus its role, company and dates, built by code exactly as `buildStoryAnswer`
  does. The CV text stays selection-only.
- New nullable jsonb column `details`, model-written coaching. It is required when kind = 'deep' and null
  otherwise (CHECK constraint).

  | Field | Content | Limits |
  |---|---|---|
  | `star` | {situation, task, action, result}: how to *say* it | each ≤ 60 words |
  | `underTheHood` | how the tech works | ≤ 150 words |
  | `architecture` | components and flow as short lines ("A → B : why") | 3–8 lines, ≤ 120 chars each |
  | `traps` | follow-up questions an interviewer asks, each with a short answer | 3–5 × {question ≤ 200, answer ≤ 80 words} |
  | `lab` | a hands-on refresh exercise | 3–6 steps, ≤ 160 chars each |
  | `value` | why it mattered to the client (cost, risk, speed) | ≤ 40 words |
  | `rescue` | a 3–5 keyword skeleton to restart when he freezes | each ≤ 30 chars |

- The prompt forbids new facts about the candidate. It may only reuse what the bullet, the experience header and
  that experience's environment line say. Numbers in `star.result` and `value` must already appear in the
  bullet; otherwise the field speaks qualitatively. Code check: a number that appears in `star.result`/`value`
  but not in the bullet makes that card be dropped.
- Generation:
  - Batches of 3 bullets per model call, up to 4 calls per run (12 bullets).
  - Gap-filling: only bullets without a deep card for the current master hash.
  - Most recent experience first.
  - Single-flight per owner, separate from the existing fill.
  - Each card is validated alone with zod; a bad card is dropped and the others are kept.
- `dedupKey("deep", {bulletIds:[id]})` — distinct from the story key because the kind is in the hash.
- When the master hash changes, deep cards show as stale through the existing `stale` logic (extend it to `deep`).

### 2. Mock interview, stateless
- `GET /api/openduet/revision/mock/questions?offerId=&limit=5`
  - Questions are drawn from deep cards: their traps plus the main question.
  - Priority: cards tied to a focus interview (offer skills ∩ bullet experience environment, best effort), then
    due cards, then the lowest box.
  - Returns `[{cardId, trapIndex|null, question}]`. No model call.
- `POST /api/openduet/revision/mock/answer {cardId, trapIndex|null, answer (≤ 4000 chars)}`
  - One model call.
  - His typed answer goes in a random-marker fence with the "data, not instructions" line.
  - zod-parsed result:

    | Field | Content |
    |---|---|
    | `scores` | {structure 0–5, technical 0–5, value 0–5} |
    | `missing` | ≤ 4 points from the card's reference he omitted |
    | `feedback` | ≤ 3 lines |
    | `betterAnswer` | ≤ 120 words, spoken style; it may only use facts from the card |

  - Grade mapping: total ≤ 6 → again, 7–11 → hard, ≥ 12 → good. The grade is applied with the existing
    `store.review`, so the Leitner state moves.
  - Returns `{scores, missing, feedback, betterAnswer, grade, card}`.
- "At risk" flag (derived, no column): a deep card with box = 1 and review_count ≥ 3 shows `atRisk: true` in
  lists. It means "à retirer du CV ou à retravailler". No automatic CV change.

### 3. Routes
All routes go under the existing revision routes and are owner-scoped (another owner → 404):
- `POST /deep/generate` → 202 / 409 (`no_master`, `generation_in_progress`);
- `GET /deep/status`;
- `GET /cards?kind=deep`, which works once the enum is extended;
- the two mock routes above.

## Files
- `openbot/server/src/db/schema/openduet-revision.ts`: kind `deep`, column `details`, CHECKs.
- `drizzle/0076_*`, generated.
- `openbot/server/src/openduet/revision/deep-cards.ts`: prompt, parse, number guard. New file.
- `openbot/server/src/openduet/revision/mock.ts`: question picking, grading prompt and parse, grade mapping.
  New file.
- `openbot/server/src/openduet/revision/generate.ts`: deep fill, single-flight.
- `openbot/server/src/openduet/revision/routes.ts`, `store.ts` (stale for deep, atRisk), `wiring.ts` (deps).
- Tests:
  - `tests/openduet-revision-deep-cards.test.ts`
  - `tests/openduet-revision-mock.test.ts`
  - extended `openduet-revision-routes.integration.test.ts` and `openduet-revision-schema.test.ts`

## Edge cases
- The model returns a card for an unknown bullet id, or for several bullets → dropped.
- The model invents a number → card dropped.
- An empty or whitespace answer → 400 without a model call.
- An answer containing the fence marker → stripped (`stripMarker`).
- The card is archived → 409; another owner's card → 404.
- The mock grade conflicts with a concurrent review → 409 `review_conflict` (existing path).
- An unreadable model answer on grading → 503 with a French message. No review is applied.

## Out of scope
- iOS screens: a separate session in `~/src/duet-ios`.
- A spoken or voice mock.
- A multi-turn mock in the bot chat.
- Editing the CV.
- LinkedIn alerts.

## Architect review (2026-11-02) — binding corrections, they override the sections above

**Wiring and model calls**
- Wiring lives in `openbot/server/src/index.ts`, around lines 2375–2389 and 2889, and in the `revision?` type at
  `app.ts:484`. `wiring.ts` does not need changes.
- Deep generation uses `listComplete` (8192 tokens). Mock grading uses `prepComplete` (2048 tokens).

**R1 — Deep dedup key**
- `CardKind` gets `"deep"`.
- The key is `dedupKey("deep", {bulletIds:[id], bulletText})`, built from `${id}|${sha256(normalizeTopic(bulletText)).slice(0,16)}`.
- An edited bullet therefore gets a new card.

**R2 — Gap and stale handling**
- `store.deepKeys(owner): Promise<Set<string>>` includes archived cards. The gap is the current bullets whose key is not in that set.
- `store.touchDeep(owner, keys, hash)` sets `master_hash` on existing deep cards whose key is in `keys`. It runs at the start of each deep fill.
- In `listToday`, `stale` is now `kind IN ('story','deep')`.

**R3 — Schema**
- Kind CHECK gains `'deep'`; the `RevisionKind` type gains `"deep"` too.
- Nullable `details` jsonb, typed `DeepDetails`. The type is declared in the schema file; the zod schema lives in `deep-cards.ts` and uses `satisfies`.
- New CHECK `openduet_revision_cards_deep_check`: `(kind = 'deep') = (details IS NOT NULL)`.
- New CHECK `openduet_revision_cards_deep_bullet_check`: `kind <> 'deep' OR cardinality(bullet_ids) = 1`.
- Migration via `bun run db:generate --name openduet_revision_deep`, expected as 0076. In the generated SQL, ADD COLUMN must come before ADD CONSTRAINT. Never touch the journal.
- `NewRevisionCard.details?` is mapped in `insertCards`.

**R4 — Number guard**
- Source text = bullet + role/company/dates + experience `context` + `environment`.
- Checked fields: all 4 STAR fields, `value`, and `rescue`.
- Numbers are matched with `/\d+(?:[.,]\d+)?/g`, with `,` normalised to `.`. A failing card is dropped.
- The mock `betterAnswer` is checked against the card reference (answer + details). If it fails, return `betterAnswer: null`, not a 503.

**R5 — Batching and trimmed caps**
- 2 bullets per model call, at most 6 calls per run. Each batch runs in its own `attempt()`.
- Caps trimmed: traps 3–4, each answer ≤ 50 words; underTheHood ≤ 120 words.

**R6 — Mock concurrency and validation**
- `pickQuestions` returns at most 1 question per card.
- `/mock/questions` returns `reviewCount`, and `/mock/answer` requires it.
- `store.review(owner, id, grade, now, expectedReviewCount?)`: when `expectedReviewCount` is given, it is compared with the stored count.
- Before any model call, the route runs `store.get` and returns:

  | Condition | Response |
  |---|---|
  | card not found or kind ≠ deep | 404 |
  | archived | 409 `archived` |
  | `reviewCount` mismatch | 409 `review_conflict` |
  | bad `trapIndex` | 400 |

- Body: strict zod; `answer` is `trim().min(1).max(4000)`.
- The answer is passed through `stripMarker` and fenced; the card reference stays outside the fence.
- Scores are integers 0–5. An unreadable model reply → 503, and no review is applied.

**Optional items, all adopted**
- O1: no `?offerId=`; the focus uses `focusOffers()`.
- O2: no `/deep/status`; `/status` gains `counts.deep` and `deep:{running,lastError}`.
- O3: `startDeep` with its own `running` map.
- O4: `isAtRisk(card)` is computed in the route mappings of `/cards` and `/today`.
- O5: "most recent" means sorting by `end ?? "9999-12"` descending, then `start` descending.

**Open questions, decided by default**
- Q1: no auto-archive. Changed bullets stay stale.
- Q2: deep cards go to `/today` like the others.
- Q3: an in-memory set of `owner|hash|bulletId` entries that failed the number guard. Those bullets are skipped until the hash changes or the process restarts.
