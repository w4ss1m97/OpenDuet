import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type OfferFilterReason,
  type OfferPlatform,
  type OfferStatus,
  type OpenduetOffer,
  type OpenduetOfferSource,
  openduetOfferSources,
  openduetOffers,
} from "../../db/schema/openduet-job-offers";
import { MAX_SCORE_ATTEMPTS, MAX_SOURCE_ATTEMPTS, SHOW_THRESHOLD, canTransition } from "./status";

/** A claim held this long is taken as dead and may be claimed again. */
const STALE_CLAIM_MS = 10 * 60 * 1000;
/** A source received longer ago than this is no longer worth reading. */
const SOURCE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

/** An offer ready to store: extraction and the hard filter have already run. */
export type NewOffer = {
  dedupKey: string;
  platform: OfferPlatform;
  url?: string | null;
  title: string;
  company?: string | null;
  tjmMin?: number | null;
  tjmMax?: number | null;
  rateUnit?: OpenduetOffer["rateUnit"];
  contract?: OpenduetOffer["contract"];
  remote?: OpenduetOffer["remote"];
  location?: string | null;
  durationMonths?: number | null;
  startAsap?: boolean;
  skills?: string[];
  description?: string | null;
  /** `new` or `filtered` (the hard filter's verdict). */
  status: "new" | "filtered";
  filterReason?: OfferFilterReason | null;
  tjmUnknown?: boolean;
};

export type ScoreResult = { score: number; reasons: string[]; missingSkills: string[]; profileHash: string };

export type DismissResult =
  | { result: "ok"; offer: OpenduetOffer }
  | { result: "conflict" }
  | { result: "not_found" };

/**
 * The offer sources and the offers read from them. Every query is owner-filtered. Sources and scores are
 * claimed (attempt counted in the same statement) and only the holder of a claim (the `claimed_at` it was
 * given) may complete or fail it.
 */
export function createOfferStore(db: Database) {
  const s = openduetOfferSources;
  const o = openduetOffers;
  const mySource = (owner: string, id: string) => and(eq(s.ownerUserId, owner), eq(s.id, id));
  const myOffer = (owner: string, id: string) => and(eq(o.ownerUserId, owner), eq(o.id, id));
  const staleBefore = (now: Date) => new Date(now.getTime() - STALE_CLAIM_MS);

  async function get(owner: string, id: string): Promise<OpenduetOffer | null> {
    const [row] = await db.select().from(o).where(myOffer(owner, id));
    return row ?? null;
  }

  return {
    get,

    /** Records a source once per key: a mail seen again, or the same pasted text, is left as it is. */
    async ensureSource(
      owner: string,
      sourceKey: string,
      platform: OfferPlatform,
      receivedAt: Date,
      pasteText: string | null = null,
    ): Promise<OpenduetOfferSource> {
      await db
        .insert(s)
        .values({ id: randomUUID(), ownerUserId: owner, sourceKey, platform, receivedAt, pasteText })
        .onConflictDoNothing({ target: [s.ownerUserId, s.sourceKey] });
      const [row] = await db
        .select()
        .from(s)
        .where(and(eq(s.ownerUserId, owner), eq(s.sourceKey, sourceKey)));
      return row as OpenduetOfferSource;
    },

    /**
     * Sources to read: pending or failed, under the attempt cap, received within 14 days, newest first.
     * Pasted text is never due: its route reads it inline, so it must not take a slot of the sweep's limit.
     */
    async listDueSources(owner: string, now = new Date(), limit = 5): Promise<OpenduetOfferSource[]> {
      return db
        .select()
        .from(s)
        .where(
          and(
            eq(s.ownerUserId, owner),
            ne(s.platform, "paste"),
            inArray(s.status, ["pending", "failed"]),
            lt(s.attempts, MAX_SOURCE_ATTEMPTS),
            gte(s.receivedAt, new Date(now.getTime() - SOURCE_MAX_AGE_MS)),
            or(sql`${s.claimedAt} IS NULL`, lt(s.claimedAt, staleBefore(now))),
          ),
        )
        .orderBy(desc(s.receivedAt))
        .limit(limit);
    },

    /** Marks as skipped the unread sources too old to be worth reading. Returns how many. */
    async skipOldSources(owner: string, now = new Date()): Promise<number> {
      const rows = await db
        .update(s)
        .set({ status: "skipped", pasteText: null, claimedAt: null, updatedAt: now })
        .where(
          and(
            eq(s.ownerUserId, owner),
            inArray(s.status, ["pending", "failed"]),
            lt(s.receivedAt, new Date(now.getTime() - SOURCE_MAX_AGE_MS)),
            or(sql`${s.claimedAt} IS NULL`, lt(s.claimedAt, staleBefore(now))),
          ),
        )
        .returning({ id: s.id });
      return rows.length;
    },

    /** Takes the source to read, counting the attempt in the same statement. Null when it is not there to take. */
    async claimSource(owner: string, id: string, now = new Date()): Promise<OpenduetOfferSource | null> {
      const [row] = await db
        .update(s)
        .set({ attempts: sql`${s.attempts} + 1`, claimedAt: now, updatedAt: now })
        .where(
          and(
            mySource(owner, id),
            inArray(s.status, ["pending", "failed"]),
            lt(s.attempts, MAX_SOURCE_ATTEMPTS),
            or(sql`${s.claimedAt} IS NULL`, lt(s.claimedAt, staleBefore(now))),
          ),
        )
        .returning();
      return row ?? null;
    },

    /** False when the claim is no longer this holder's. */
    async completeSource(owner: string, id: string, claimedAt: Date, offersFound: number): Promise<boolean> {
      const rows = await db
        .update(s)
        .set({ status: "done", offersFound, pasteText: null, claimedAt: null, lastError: null, updatedAt: new Date() })
        .where(and(mySource(owner, id), eq(s.claimedAt, claimedAt)))
        .returning({ id: s.id });
      return rows.length > 0;
    },

    /** `errorName` is the error's name, never its message: that could carry mail text. */
    async failSource(owner: string, id: string, claimedAt: Date, errorName: string): Promise<boolean> {
      const rows = await db
        .update(s)
        .set({ status: "failed", claimedAt: null, lastError: errorName, updatedAt: new Date() })
        .where(and(mySource(owner, id), eq(s.claimedAt, claimedAt)))
        .returning({ id: s.id });
      return rows.length > 0;
    },

    /** The holder gives up on a source with nothing to read (empty body). */
    async skipSource(owner: string, id: string, claimedAt: Date): Promise<boolean> {
      const rows = await db
        .update(s)
        .set({ status: "skipped", pasteText: null, claimedAt: null, updatedAt: new Date() })
        .where(and(mySource(owner, id), eq(s.claimedAt, claimedAt)))
        .returning({ id: s.id });
      return rows.length > 0;
    },

    /**
     * Stores the offers one by one. An offer already there (same owner and dedup key) only has its
     * `seen_count` and `last_seen_at` bumped: its status, score and fields stay.
     */
    async insertOffers(
      owner: string,
      sourceId: string | null,
      offers: NewOffer[],
    ): Promise<{ id: string; dedupKey: string; created: boolean }[]> {
      const out: { id: string; dedupKey: string; created: boolean }[] = [];
      for (const n of offers) {
        const now = new Date();
        const [row] = await db
          .insert(o)
          .values({
            id: randomUUID(),
            ownerUserId: owner,
            sourceId,
            dedupKey: n.dedupKey,
            platform: n.platform,
            url: n.url ?? null,
            title: n.title,
            company: n.company ?? null,
            tjmMin: n.tjmMin ?? null,
            tjmMax: n.tjmMax ?? null,
            rateUnit: n.rateUnit ?? "unknown",
            contract: n.contract ?? "unknown",
            remote: n.remote ?? "unknown",
            location: n.location ?? null,
            durationMonths: n.durationMonths ?? null,
            startAsap: n.startAsap ?? false,
            skills: n.skills ?? [],
            description: n.description ?? null,
            status: n.status,
            filterReason: n.status === "filtered" ? (n.filterReason ?? null) : null,
            tjmUnknown: n.tjmUnknown ?? false,
            lastSeenAt: now,
          })
          .onConflictDoUpdate({
            target: [o.ownerUserId, o.dedupKey],
            set: { seenCount: sql`${o.seenCount} + 1`, lastSeenAt: now, updatedAt: now },
          })
          .returning({ id: o.id, created: sql<boolean>`(xmax = 0)` });
        out.push({ id: row.id, dedupKey: n.dedupKey, created: row.created });
      }
      return out;
    },

    /** Offers waiting for a score: `new`, under the attempt cap, not being scored, newest first. */
    async listDueScores(owner: string, limit = 10, now = new Date()): Promise<OpenduetOffer[]> {
      return db
        .select()
        .from(o)
        .where(
          and(
            eq(o.ownerUserId, owner),
            eq(o.status, "new"),
            lt(o.scoreAttempts, MAX_SCORE_ATTEMPTS),
            or(sql`${o.claimedAt} IS NULL`, lt(o.claimedAt, staleBefore(now))),
          ),
        )
        .orderBy(desc(o.createdAt))
        .limit(limit);
    },

    /** Takes the offer to score, counting the attempt in the same statement. */
    async claimScore(owner: string, id: string, now = new Date()): Promise<OpenduetOffer | null> {
      const [row] = await db
        .update(o)
        .set({ scoreAttempts: sql`${o.scoreAttempts} + 1`, claimedAt: now, updatedAt: now })
        .where(
          and(
            myOffer(owner, id),
            eq(o.status, "new"),
            lt(o.scoreAttempts, MAX_SCORE_ATTEMPTS),
            or(sql`${o.claimedAt} IS NULL`, lt(o.claimedAt, staleBefore(now))),
          ),
        )
        .returning();
      return row ?? null;
    },

    /** Stores the score; `shown` from 75, else `scored`. False when the claim is no longer this holder's or the offer left `new`. */
    async completeScore(owner: string, id: string, claimedAt: Date, result: ScoreResult): Promise<boolean> {
      const now = new Date();
      const rows = await db
        .update(o)
        .set({
          status: result.score >= SHOW_THRESHOLD ? "shown" : "scored",
          score: result.score,
          reasons: result.reasons,
          missingSkills: result.missingSkills,
          profileHash: result.profileHash,
          scoredAt: now,
          claimedAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(and(myOffer(owner, id), eq(o.status, "new"), eq(o.claimedAt, claimedAt)))
        .returning({ id: o.id });
      return rows.length > 0;
    },

    /** The offer stays `new` with no score. `errorName` is the error's name, never its message. */
    async failScore(owner: string, id: string, claimedAt: Date, errorName: string): Promise<boolean> {
      const rows = await db
        .update(o)
        .set({ claimedAt: null, lastError: errorName, updatedAt: new Date() })
        .where(and(myOffer(owner, id), eq(o.status, "new"), eq(o.claimedAt, claimedAt)))
        .returning({ id: o.id });
      return rows.length > 0;
    },

    /** Best score first (unscored last), then newest. */
    async list(owner: string, opts: { statuses: OfferStatus[]; limit: number }): Promise<OpenduetOffer[]> {
      if (opts.statuses.length === 0) return [];
      return db
        .select()
        .from(o)
        .where(and(eq(o.ownerUserId, owner), inArray(o.status, opts.statuses)))
        .orderBy(sql`${o.score} DESC NULLS LAST`, desc(o.createdAt))
        .limit(opts.limit);
    },

    /** The offers first stored from one source, best score first. */
    async listBySource(owner: string, sourceId: string): Promise<OpenduetOffer[]> {
      return db
        .select()
        .from(o)
        .where(and(eq(o.ownerUserId, owner), eq(o.sourceId, sourceId)))
        .orderBy(sql`${o.score} DESC NULLS LAST`, desc(o.createdAt));
    },

    /** Dismisses the offer. Already dismissed is fine; `applied` is a conflict. */
    async dismiss(owner: string, id: string): Promise<DismissResult> {
      const current = await get(owner, id);
      if (!current) return { result: "not_found" };
      if (current.status === "dismissed") return { result: "ok", offer: current };
      if (!canTransition(current.status, "dismissed")) return { result: "conflict" };
      const [row] = await db
        .update(o)
        .set({ status: "dismissed", updatedAt: new Date() })
        .where(and(myOffer(owner, id), eq(o.status, current.status)))
        .returning();
      if (row) return { result: "ok", offer: row };
      // The status moved under us: look again.
      const now = await get(owner, id);
      if (now?.status === "dismissed") return { result: "ok", offer: now };
      return now ? { result: "conflict" } : { result: "not_found" };
    },

    /** Marks the offer applied and links the mission. Idempotent: an applied offer is returned as it is. Null when absent. */
    async setApplied(owner: string, id: string, missionId: string | null): Promise<OpenduetOffer | null> {
      const [row] = await db
        .update(o)
        .set({ status: "applied", missionId, updatedAt: new Date() })
        .where(and(myOffer(owner, id), inArray(o.status, ["new", "scored", "shown", "filtered", "dismissed"])))
        .returning();
      return row ?? get(owner, id);
    },

    /** The best `shown` offers scored since `since`, for the brief. */
    async topShown(owner: string, since: Date, limit = 5): Promise<OpenduetOffer[]> {
      return db
        .select()
        .from(o)
        .where(and(eq(o.ownerUserId, owner), eq(o.status, "shown"), gte(o.scoredAt, since)))
        .orderBy(sql`${o.score} DESC NULLS LAST`, desc(o.scoredAt))
        .limit(limit);
    },
  };
}

export type OfferStore = ReturnType<typeof createOfferStore>;
