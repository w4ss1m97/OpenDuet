import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type DebriefContent,
  type OpenduetInterviewDebrief,
  openduetInterviewDebriefs,
} from "../../db/schema/openduet-interview-debriefs";
import { openduetMissionEvents } from "../../db/schema/openduet-missions";
import { MAX_DEBRIEF_ATTEMPTS } from "./debrief";

/** A generation that has held its claim this long is taken as dead and may be claimed again. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; errno?: string; cause?: { code?: string; errno?: string } };
  return [e?.code, e?.errno, e?.cause?.code, e?.cause?.errno].includes("23505");
}

/**
 * The debriefs, one per interview item and one per Anarlog meeting. Every query is owner-filtered. Only
 * the holder of a claim (the `claimed_at` it was given) may complete or fail the debrief.
 */
export function createDebriefStore(db: Database) {
  const t = openduetInterviewDebriefs;
  const mine = (ownerUserId: string, itemId: string) => and(eq(t.ownerUserId, ownerUserId), eq(t.itemId, itemId));

  async function getByItem(ownerUserId: string, itemId: string): Promise<OpenduetInterviewDebrief | null> {
    const [row] = await db.select().from(t).where(mine(ownerUserId, itemId));
    return row ?? null;
  }

  return {
    getByItem,

    /**
     * Queues the debrief. One already there for this meeting and mission is left as it is; one for another
     * meeting or mission starts over. Null when the meeting already belongs to another item of this person.
     */
    async ensurePending(
      ownerUserId: string,
      itemId: string,
      missionId: string,
      anarlogMeetingId: string,
    ): Promise<OpenduetInterviewDebrief | null> {
      try {
        await db
          .insert(t)
          .values({ id: randomUUID(), itemId, ownerUserId, missionId, anarlogMeetingId, status: "pending" })
          .onConflictDoUpdate({
            target: t.itemId,
            set: {
              missionId,
              anarlogMeetingId,
              status: "pending",
              content: null,
              attempts: 0,
              claimedAt: null,
              lastError: null,
              generatedAt: null,
              updatedAt: new Date(),
            },
            setWhere: and(
              eq(t.ownerUserId, ownerUserId),
              or(sql`${t.missionId} <> ${missionId}`, sql`${t.anarlogMeetingId} <> ${anarlogMeetingId}`),
            ),
          });
      } catch (error) {
        if (uniqueViolation(error)) return null;
        throw error;
      }
      return getByItem(ownerUserId, itemId);
    },

    /** Takes the debrief to generate, counting the attempt in the same statement. Null when it is not there to take. */
    async claim(ownerUserId: string, itemId: string, now = new Date()): Promise<OpenduetInterviewDebrief | null> {
      const [row] = await db
        .update(t)
        .set({ attempts: sql`${t.attempts} + 1`, claimedAt: now, updatedAt: now })
        .where(
          and(
            mine(ownerUserId, itemId),
            inArray(t.status, ["pending", "failed"]),
            lt(t.attempts, MAX_DEBRIEF_ATTEMPTS),
            or(sql`${t.claimedAt} IS NULL`, lt(t.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS))),
          ),
        )
        .returning();
      return row ?? null;
    },

    /**
     * Stores the debrief and, in the same transaction, the mission's `debrief` event (once per meeting,
     * dated at the meeting's end). False when the claim is no longer this holder's.
     */
    async complete(
      ownerUserId: string,
      itemId: string,
      claimedAt: Date,
      content: DebriefContent,
      endedAt: Date,
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        const now = new Date();
        const [row] = await tx
          .update(t)
          .set({ status: "ready", content, claimedAt: null, lastError: null, generatedAt: now, updatedAt: now })
          .where(and(mine(ownerUserId, itemId), eq(t.claimedAt, claimedAt)))
          .returning();
        if (!row) return false;
        await tx
          .insert(openduetMissionEvents)
          .values({
            id: randomUUID(),
            missionId: row.missionId,
            ownerUserId,
            type: "debrief",
            source: "app",
            sourceHash: `anarlog:${row.anarlogMeetingId}`,
            at: endedAt,
          })
          .onConflictDoNothing({ target: [openduetMissionEvents.missionId, openduetMissionEvents.sourceHash] });
        return true;
      });
    },

    /** `errorName` is the error's name, never its message: that could carry transcript text. */
    async fail(ownerUserId: string, itemId: string, claimedAt: Date, errorName: string): Promise<boolean> {
      const rows = await db
        .update(t)
        .set({ status: "failed", claimedAt: null, lastError: errorName, updatedAt: new Date() })
        .where(and(mine(ownerUserId, itemId), eq(t.claimedAt, claimedAt)))
        .returning({ id: t.id });
      return rows.length > 0;
    },

    /** The Anarlog meetings this person's debriefs already use. */
    async listUsedMeetingIds(ownerUserId: string): Promise<Set<string>> {
      const rows = await db.select({ id: t.anarlogMeetingId }).from(t).where(eq(t.ownerUserId, ownerUserId));
      return new Set(rows.map((r) => r.id));
    },

    /** Asks for a new debrief from the same meeting. The old content stays readable until the new one lands. */
    async regenerate(ownerUserId: string, itemId: string): Promise<OpenduetInterviewDebrief | null> {
      const [row] = await db
        .update(t)
        .set({ status: "pending", attempts: 0, claimedAt: null, lastError: null, updatedAt: new Date() })
        .where(mine(ownerUserId, itemId))
        .returning();
      return row ?? null;
    },
  };
}

export type DebriefStore = ReturnType<typeof createDebriefStore>;
