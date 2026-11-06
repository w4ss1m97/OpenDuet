# Duet A5 — Weekly career check (reviewed spec, architect, 2026-11-02)

Goal: one owner-scoped weekly check computed in code (no LLM, no new table, no migration). Branch
`feat/duet-a5-weekly` from main; no dependency on A4.

## Micro-spec (owner's 5 bullets)
1. A weekly check: pipeline by stage, stage moves and new missions this week, relances sent / waiting, offers shown,
   interviews held / upcoming, revision progress, TJM trend over 4 weeks. Numbers in code, French lines, no LLM.
2. Paris weeks, Monday 00:00 → next Monday. On Monday the check covers the last completed week, else week-to-date.
3. Delivered by `GET /api/openduet/career/weekly?week=YYYY-MM-DD` and a `weekly` field in the Monday morning brief.
4. Every query scoped to the owner; pure aggregation separated from DB reads; counts only, no company names.
5. Tests: week maths incl. DST, aggregator, store isolation, route, brief.

## Architect changes to the draft
- Offers "applied / dismissed this week" dropped: offers have no status-change timestamp and `updatedAt` moves on
  every re-sighting (job-offers/store.ts). "Shown this week" = `score >= SHOW_THRESHOLD AND scored_at` in the week,
  whatever the status is now. Applications are counted on the mission side (moves into `applied`, new missions).
  A `status_changed_at` column on offers is a later option.
- Mission creation writes no event: new missions come from `missions.created_at`; stage moves need `type='stage'`
  and `from_stage IS DISTINCT FROM to_stage`.
- Relances sent come from `relance_sent` events (`at`); "waiting" = relances with `status='draft'` (same rule as
  `loadBriefMissions`).
- No revision review log: "cards reviewed" = cards whose `last_reviewed_at` is in the week (a lower bound). Boxes
  and due counts are snapshots of today, also for a past `?week=`.
- TJM trend uses all offers first stored that week with `rate_unit='day'` and `contract <> 'salaried'` (shown offers
  already passed ≥ 500 €/j, so their median says nothing). Hourly/yearly rates excluded.
- Brief field rather than a weekly item (an item kind would need a migration on the items check constraint).
- Known gap outside A5: offer titles/companies and mission titles already reach the brief model unfenced. A5 adds
  no new text; the gap gets its own small fix.

## Week maths — `src/openduet/career/week.ts` (pure)
- `type ParisWeek = { start: Date; end: Date; label: string /* Monday YYYY-MM-DD */ }`
- `parisWeekday(d)` 1=Mon..7=Sun (parisParts + Date.UTC(...).getUTCDay())
- `parisWeekOf(d)`: start = parisDate(y, m, day-(wd-1)), end = parisDate(y, m, day-(wd-1)+7)
- `parseWeekParam(s)`: `/^\d{4}-\d{2}-\d{2}$/` + real calendar date (round-trip), normalised to its Monday, else null
- `defaultWeek(now)`: Paris Monday → parisWeekOf(now − 1 day), else parisWeekOf(now)
- `previousWeeks(w, n)`: n weeks ending with w, oldest first, built by calendar days (not ms)
Built on `items/paris-time.ts` helpers.

## Raw read — `src/openduet/career/store.ts`
`createCareerStore(db) → { readWeek(owner, week, now): Promise<WeeklyRaw> }`. Every query has `owner_user_id = owner`
(mission joins also check `missions.owner_user_id`). Run in parallel:
1. stageMoves: mission_events JOIN missions, type='stage', from IS DISTINCT FROM to, review <> 'dismissed', at in [start,end) → {toStage, at}
2. newMissions: missions, review <> 'dismissed', created_at in [start,end) → {createdAt}
3. relancesSent: mission_events type='relance_sent', at in [start,end) → {at}
4. openMissions: closed_at IS NULL AND review IN ('active','proposed') → {stage, review}
5. relanceDrafts: count relances status='draft'
6. offers: created_at in [previousWeeks(week,4)[0].start, end) OR scored_at in [start,end) → {createdAt, scoredAt, score, tjmMin, tjmMax, rateUnit, tjmUnknown, contract}
7. interviews: items kind='interview', status IN ('active','done'), due_at in [start, GREATEST(end, now+7d)) → {dueAt, status}
8. cards: revision cards, archived_at IS NULL → {box, dueAt, lastReviewedAt}
No new index (personal scale; say so in a comment).

## Aggregation — `src/openduet/career/weekly.ts` (pure, all the logic)
- `tjmValue(o)`: rateUnit !== 'day' || tjmUnknown || contract === 'salaried' → null; min & max → midpoint; one side → it; none → null
- `median(xs)`: sorted, even → mean of the middle two, Math.round; empty → null
- `summarizeWeek(raw, week, now): WeeklyCheck`; `weeklyBriefLines(check): string[]` (French, counts only, one line per non-empty section)
```
WeeklyCheck = {
  week: { label, start: ISO, end: ISO, complete: boolean /* now >= end */ },
  window: { newMissions, movesTo: Partial<Record<Stage, number>>, relancesSent, offersShown, interviewsHeld /* dueAt in [start, min(end, now)) */, cardsReviewed },
  now: { asOf, pipeline: Partial<Record<Stage, number>> /* review active */, proposedMissions, relanceDrafts,
         upcomingInterviews /* status active, dueAt in [now, now+7d) */, revision: { boxes: [n1..n5], dueNow /* dueTodayBefore */, newCount /* dueAt null */ } },
  tjm: { week: string; median: number | null; withRate: number; offers: number }[]  // 4 weeks by createdAt, oldest first
}
```
Line examples (wording free, tested by substring): "Semaine du 26/10 : 2 nouvelles missions, 1 passage en entretien,
3 relances envoyées." / "Offres : 4 retenues. TJM médian 620 €/j (12 offres chiffrées sur 15)." / "Révision : 18
cartes revues, 6 à revoir."

## Route — `src/openduet/career/routes.ts`
`createCareerRoutes({ store, now? }, requireUser)`: GET `/weekly?week=` → 200 WeeklyCheck; missing → defaultWeek(now);
unparseable / impossible date → 400; week starting after now → 400. Owner = signed-in user, so another owner gets
zeros. app.ts: optional `career?: CareerRouteDeps` in the openduet deps, mounted at `/api/openduet/career`; index.ts
builds `createCareerStore(database)` next to the revision store.

## Brief — `brief.ts` + `wiring.ts`
`BriefWeekly = { week: string; lines: string[] }`, `MorningBrief.weekly?`. `buildMorningBrief` dep `weekly?(owner)`
with the usual try/catch (error → couldNotCheck `{ source: "Bilan hebdo" }`). `wiring.ts loadBriefWeekly(store,
owner, now)`: null unless Paris Monday, else last completed week's lines. Tool description gains one sentence: on
Mondays, `weekly` holds last week's career check; mention its most telling line at most.

## Limits
- Skipping the Monday brief misses that week's check in the brief (the route still has it).
- Brief card / duet-ios do not render the field yet; only the model reads it.

## Ordered test list
1. `openduet-career-week.test.ts`: Wed 2026-10-28 → start 2026-10-25T23:00Z, end 2026-11-01T23:00Z; spring DST week
   (Mon 2026-03-23) 167 h; autumn DST week (Mon 2026-10-19) 169 h; Sunday 23:30 vs Monday 00:00; defaultWeek Mon
   2026-11-02 08:00 → "2026-10-26", Tue → "2026-11-02"; parseWeekParam rejects 2026-02-30, 2026-1-5, x and
   normalises 2026-10-29 → 2026-10-26; previousWeeks across October DST.
2. `openduet-career-weekly.test.ts`: empty data (zeros, 4 null tjm entries); tjmValue cases; median odd/even/empty;
   start in, end out; interviewsHeld stops at now and complete false; offersShown ignores status and needs ≥ 75;
   movesTo; boxes/dueNow; brief lines carry counts and never a seeded company name.
3. `openduet-career-store.integration.test.ts`: two owners, only A's rows; dismissed mission's events excluded;
   from = to events excluded; offers outside both windows excluded.
4. `openduet-career-routes.integration.test.ts`: 400 bad / impossible / future; ?week normalised; Monday default =
   previous week; owner B gets zeros while A has data.
5. `openduet-brief.test.ts` (extend): weekly present / absent / throwing dep → couldNotCheck; loadBriefWeekly
   Monday vs Tuesday/Sunday (store not called).
