import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type CvMatch,
  type OpenduetCvMaster,
  type OpenduetCvVersion,
  openduetCvMasters,
  openduetCvVersions,
} from "../../db/schema/openduet-cv";
import type { CvMaster } from "./cv-schema";

/** A claim held this long is taken as dead and may be claimed again. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/**
 * The master CV and the CVs tailored to offers. Every query is owner-filtered. A version is claimed
 * (UPDATE ... WHERE claimable RETURNING) and only the holder of a claim (the exact `claimed_at` it was
 * given) may complete or fail it. No attempts cap: generation is on demand only.
 */
export function createCvStore(db: Database) {
  const m = openduetCvMasters;
  const v = openduetCvVersions;
  const mine = (owner: string, offerId: string) => and(eq(v.ownerUserId, owner), eq(v.offerId, offerId));

  async function getVersion(owner: string, offerId: string): Promise<OpenduetCvVersion | null> {
    const [row] = await db.select().from(v).where(mine(owner, offerId));
    return row ?? null;
  }

  return {
    getVersion,

    async getMaster(owner: string): Promise<OpenduetCvMaster | null> {
      const [row] = await db.select().from(m).where(eq(m.ownerUserId, owner));
      return row ?? null;
    },

    /** Stores the (already validated) master, replacing any earlier one. */
    async putMaster(owner: string, content: CvMaster): Promise<OpenduetCvMaster> {
      const contentHash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
      const now = new Date();
      const [row] = await db
        .insert(m)
        .values({ ownerUserId: owner, content, contentHash, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: m.ownerUserId, set: { content, contentHash, updatedAt: now } })
        .returning();
      return row;
    },

    /** The version row of an offer, created `pending` once. Null when the offer is not this owner's. */
    async ensureVersion(owner: string, offerId: string): Promise<OpenduetCvVersion | null> {
      // Insert only when the offer belongs to the owner, so another owner's offer id leaks nothing.
      await db.execute(sql`
        INSERT INTO openduet_cv_versions (id, owner_user_id, offer_id)
        SELECT ${randomUUID()}, o.owner_user_id, o.id FROM openduet_offers o
        WHERE o.id = ${offerId} AND o.owner_user_id = ${owner}
        ON CONFLICT (owner_user_id, offer_id) DO NOTHING`);
      return getVersion(owner, offerId);
    },

    /**
     * Takes the version to generate: pending or failed (ready too with `regenerate`), unclaimed or with a
     * stale claim. Null when there is nothing to take.
     */
    async claimVersion(
      owner: string,
      offerId: string,
      opts: { regenerate: boolean },
      now = new Date(),
    ): Promise<OpenduetCvVersion | null> {
      const statuses = opts.regenerate ? (["pending", "failed", "ready"] as const) : (["pending", "failed"] as const);
      const [row] = await db
        .update(v)
        .set({ claimedAt: now, updatedAt: now })
        .where(
          and(
            mine(owner, offerId),
            inArray(v.status, [...statuses]),
            or(sql`${v.claimedAt} IS NULL`, lt(v.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS))),
          ),
        )
        .returning();
      return row ?? null;
    },

    /** False when the claim is no longer this holder's. */
    async completeVersion(
      owner: string,
      offerId: string,
      claimedAt: Date,
      content: CvMaster,
      match: CvMatch,
      masterHash: string,
    ): Promise<boolean> {
      const now = new Date();
      const rows = await db
        .update(v)
        .set({ status: "ready", content, match, masterHash, generatedAt: now, claimedAt: null, lastError: null, updatedAt: now })
        .where(and(mine(owner, offerId), eq(v.claimedAt, claimedAt)))
        .returning({ id: v.id });
      return rows.length > 0;
    },

    /** `errorName` is the error's name, never its message. A ready version keeps its content. */
    async failVersion(owner: string, offerId: string, claimedAt: Date, errorName: string): Promise<boolean> {
      const rows = await db
        .update(v)
        .set({
          status: sql`CASE WHEN ${v.status} = 'ready' THEN 'ready' ELSE 'failed' END`,
          claimedAt: null,
          lastError: errorName,
          updatedAt: new Date(),
        })
        .where(and(mine(owner, offerId), eq(v.claimedAt, claimedAt)))
        .returning({ id: v.id });
      return rows.length > 0;
    },
  };
}

export type CvStore = ReturnType<typeof createCvStore>;
