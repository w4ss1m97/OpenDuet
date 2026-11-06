import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import { type OpenduetInterviewPrep, openduetInterviewPreps } from "../../db/schema/openduet-interview-preps";
import { openduetItems } from "../../db/schema/openduet-items";
import { MAX_PREP_ATTEMPTS, type PrepContent } from "./prep";

/** A generation that has held its claim this long is taken as dead and may be claimed again. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * The preparation sheets, one per interview item. Every query is owner-filtered. A generation claims
 * the sheet, and only the holder of that claim (the `claimed_at` it was given) may complete or fail it.
 */
export function createPrepStore(db: Database) {
  const mine = (ownerUserId: string, itemId: string) =>
    and(eq(openduetInterviewPreps.ownerUserId, ownerUserId), eq(openduetInterviewPreps.itemId, itemId));

  async function getByItem(ownerUserId: string, itemId: string): Promise<OpenduetInterviewPrep | null> {
    const [row] = await db.select().from(openduetInterviewPreps).where(mine(ownerUserId, itemId));
    return row ?? null;
  }

  return {
    getByItem,

    /** Queues the sheet. One already there for this mission is left as it is; one for another mission starts over. */
    async ensurePending(ownerUserId: string, itemId: string, missionId: string): Promise<OpenduetInterviewPrep> {
      await db
        .insert(openduetInterviewPreps)
        .values({ id: randomUUID(), itemId, ownerUserId, missionId, status: "pending" })
        .onConflictDoUpdate({
          target: openduetInterviewPreps.itemId,
          set: {
            missionId,
            status: "pending",
            content: null,
            attempts: 0,
            claimedAt: null,
            lastError: null,
            generatedAt: null,
            updatedAt: new Date(),
          },
          setWhere: and(
            eq(openduetInterviewPreps.ownerUserId, ownerUserId),
            sql`${openduetInterviewPreps.missionId} <> ${missionId}`,
          ),
        });
      return (await getByItem(ownerUserId, itemId)) as OpenduetInterviewPrep;
    },

    /** Takes the sheet to generate, counting the attempt in the same statement. Null when it is not there to take. */
    async claim(ownerUserId: string, itemId: string, now = new Date()): Promise<OpenduetInterviewPrep | null> {
      const [row] = await db
        .update(openduetInterviewPreps)
        .set({ attempts: sql`${openduetInterviewPreps.attempts} + 1`, claimedAt: now, updatedAt: now })
        .where(
          and(
            mine(ownerUserId, itemId),
            inArray(openduetInterviewPreps.status, ["pending", "failed"]),
            lt(openduetInterviewPreps.attempts, MAX_PREP_ATTEMPTS),
            or(
              sql`${openduetInterviewPreps.claimedAt} IS NULL`,
              lt(openduetInterviewPreps.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS)),
            ),
          ),
        )
        .returning();
      return row ?? null;
    },

    /** False when the claim is no longer this holder's (taken over, or the sheet was restarted). */
    async complete(ownerUserId: string, itemId: string, claimedAt: Date, content: PrepContent): Promise<boolean> {
      const now = new Date();
      const rows = await db
        .update(openduetInterviewPreps)
        .set({ status: "ready", content, claimedAt: null, lastError: null, generatedAt: now, updatedAt: now })
        .where(and(mine(ownerUserId, itemId), eq(openduetInterviewPreps.claimedAt, claimedAt)))
        .returning({ id: openduetInterviewPreps.id });
      return rows.length > 0;
    },

    /** `errorName` is the error's name, never its message: that could carry mail text. */
    async fail(ownerUserId: string, itemId: string, claimedAt: Date, errorName: string): Promise<boolean> {
      const rows = await db
        .update(openduetInterviewPreps)
        .set({ status: "failed", claimedAt: null, lastError: errorName, updatedAt: new Date() })
        .where(and(mine(ownerUserId, itemId), eq(openduetInterviewPreps.claimedAt, claimedAt)))
        .returning({ id: openduetInterviewPreps.id });
      return rows.length > 0;
    },

    async listByMission(ownerUserId: string, missionId: string): Promise<OpenduetInterviewPrep[]> {
      const rows = await db
        .select({ prep: openduetInterviewPreps })
        .from(openduetInterviewPreps)
        .innerJoin(openduetItems, eq(openduetItems.id, openduetInterviewPreps.itemId))
        .where(
          and(
            eq(openduetInterviewPreps.ownerUserId, ownerUserId),
            eq(openduetInterviewPreps.missionId, missionId),
          ),
        )
        .orderBy(sql`${openduetItems.dueAt} ASC NULLS LAST`, asc(openduetInterviewPreps.createdAt));
      return rows.map((r) => r.prep);
    },

    /** Asks for a new sheet from the same mission. The old content stays readable until the new one lands. */
    async regenerate(ownerUserId: string, itemId: string): Promise<OpenduetInterviewPrep | null> {
      const [row] = await db
        .update(openduetInterviewPreps)
        .set({ status: "pending", attempts: 0, claimedAt: null, lastError: null, updatedAt: new Date() })
        .where(mine(ownerUserId, itemId))
        .returning();
      return row ?? null;
    },
  };
}

export type PrepStore = ReturnType<typeof createPrepStore>;
