import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { openduetOffers } from "../../db/schema/openduet-job-offers";
import { openduetMissionEvents, openduetMissionRelances, openduetMissions } from "../../db/schema/openduet-missions";
import { openduetItems } from "../../db/schema/openduet-items";
import { openduetRevisionCards } from "../../db/schema/openduet-revision";
import { TJM_WEEKS, type WeeklyRaw } from "./weekly";
import { previousWeeks, type ParisWeek } from "./week";

/**
 * Raw reads for the weekly check. Every query carries the owner (mission joins check both sides).
 * No new index: a personal tenant holds hundreds of rows, not millions. All logic is in weekly.ts.
 */
export function createCareerStore(db: Database) {
  const m = openduetMissions;
  const e = openduetMissionEvents;
  const o = openduetOffers;
  const i = openduetItems;
  const c = openduetRevisionCards;

  return {
    async readWeek(owner: string, week: ParisWeek, now: Date): Promise<WeeklyRaw> {
      const { start, end } = week;
      const tjmStart = (previousWeeks(week, TJM_WEEKS)[0] as ParisWeek).start;
      const interviewEnd = new Date(Math.max(end.getTime(), now.getTime() + 7 * 86_400_000));
      const [stageMoves, newMissions, relancesSent, openMissions, drafts, offers, interviews, cards] = await Promise.all([
        db
          .select({ toStage: e.toStage, at: e.at })
          .from(e)
          .innerJoin(m, eq(m.id, e.missionId))
          .where(
            and(
              eq(e.ownerUserId, owner),
              eq(m.ownerUserId, owner),
              eq(e.type, "stage"),
              sql`${e.fromStage} IS DISTINCT FROM ${e.toStage}`,
              sql`${m.review} <> 'dismissed'`,
              gte(e.at, start),
              lt(e.at, end),
            ),
          ),
        db
          .select({ createdAt: m.createdAt })
          .from(m)
          .where(and(eq(m.ownerUserId, owner), sql`${m.review} <> 'dismissed'`, gte(m.createdAt, start), lt(m.createdAt, end))),
        db
          .select({ at: e.at })
          .from(e)
          .where(and(eq(e.ownerUserId, owner), eq(e.type, "relance_sent"), gte(e.at, start), lt(e.at, end))),
        db
          .select({ stage: m.stage, review: m.review })
          .from(m)
          .where(and(eq(m.ownerUserId, owner), isNull(m.closedAt), inArray(m.review, ["active", "proposed"]))),
        db
          .select({ n: sql<number>`count(*)::int` })
          .from(openduetMissionRelances)
          .where(and(eq(openduetMissionRelances.ownerUserId, owner), eq(openduetMissionRelances.status, "draft"))),
        db
          .select({
            createdAt: o.createdAt,
            scoredAt: o.scoredAt,
            score: o.score,
            tjmMin: o.tjmMin,
            tjmMax: o.tjmMax,
            rateUnit: o.rateUnit,
            tjmUnknown: o.tjmUnknown,
            contract: o.contract,
          })
          .from(o)
          .where(
            and(
              eq(o.ownerUserId, owner),
              or(and(gte(o.createdAt, tjmStart), lt(o.createdAt, end)), and(gte(o.scoredAt, start), lt(o.scoredAt, end))),
            ),
          ),
        db
          .select({ dueAt: i.dueAt, status: i.status })
          .from(i)
          .where(
            and(
              eq(i.ownerUserId, owner),
              eq(i.kind, "interview"),
              inArray(i.status, ["active", "done"]),
              gte(i.dueAt, start),
              lt(i.dueAt, interviewEnd),
            ),
          ),
        db
          .select({ box: c.box, dueAt: c.dueAt, lastReviewedAt: c.lastReviewedAt })
          .from(c)
          .where(and(eq(c.ownerUserId, owner), isNull(c.archivedAt))),
      ]);
      return {
        stageMoves: stageMoves.map((r) => ({ toStage: r.toStage as NonNullable<typeof r.toStage>, at: r.at })),
        newMissions,
        relancesSent,
        openMissions,
        relanceDrafts: drafts[0]?.n ?? 0,
        offers,
        interviews: interviews.map((r) => ({ dueAt: r.dueAt as Date, status: r.status })),
        cards,
      };
    },
  };
}

export type CareerStore = ReturnType<typeof createCareerStore>;
