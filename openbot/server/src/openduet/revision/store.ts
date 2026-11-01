import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type OpenduetRevisionCard,
  type RevisionGrade,
  type RevisionKind,
  openduetRevisionCards,
} from "../../db/schema/openduet-revision";
import { dueTodayBefore, nextReview } from "./leitner";

/** What the generation batch produces for one card. `dedupKey` is computed by the caller. */
export type NewRevisionCard = {
  kind: RevisionKind;
  topic: string;
  skillGroupId?: string | null;
  offerId?: string | null;
  question: string;
  answer: string;
  keyPoints: string[];
  bulletIds: string[];
  masterHash: string;
  dedupKey: string;
};

export type TodayCard = OpenduetRevisionCard & { stale: boolean };

export type ReviewResult =
  | { result: "ok"; card: OpenduetRevisionCard }
  | { result: "conflict" | "archived" | "not_found" };

/**
 * Revision cards and their Leitner state. Every query is owner-filtered. Deduplication is the caller's job
 * (it computes `dedupKey`); the store only enforces UNIQUE (owner, dedup_key) with ON CONFLICT DO NOTHING.
 */
export function createRevisionStore(db: Database) {
  const c = openduetRevisionCards;
  const mine = (owner: string, id: string) => and(eq(c.ownerUserId, owner), eq(c.id, id));

  async function get(owner: string, id: string): Promise<OpenduetRevisionCard | null> {
    const [row] = await db.select().from(c).where(mine(owner, id));
    return row ?? null;
  }

  return {
    get,

    /** Inserts the cards whose dedup key is new for this owner and returns only those rows. */
    async insertCards(owner: string, cards: NewRevisionCard[]): Promise<OpenduetRevisionCard[]> {
      if (cards.length === 0) return [];
      return db
        .insert(c)
        .values(
          cards.map((card) => ({
            id: randomUUID(),
            ownerUserId: owner,
            kind: card.kind,
            topic: card.topic,
            skillGroupId: card.skillGroupId ?? null,
            offerId: card.offerId ?? null,
            question: card.question,
            answer: card.answer,
            keyPoints: card.keyPoints,
            bulletIds: card.bulletIds,
            masterHash: card.masterHash,
            dedupKey: card.dedupKey,
          })),
        )
        .onConflictDoNothing({ target: [c.ownerUserId, c.dedupKey] })
        .returning();
    },

    /**
     * Cards to revise now, in order: focus cards (offer in `focusOfferIds`) due or new, then due cards by
     * due date, then new cards by creation. Archived and not-yet-due cards are left out. A story card is
     * `stale` when its master hash differs from `masterHash` (the current master's).
     */
    async listToday(
      owner: string,
      now: Date,
      opts: { limit: number; focusOfferIds?: string[]; masterHash?: string | null },
    ): Promise<TodayCard[]> {
      const tomorrow = dueTodayBefore(now);
      const focusIds = opts.focusOfferIds ?? [];
      const isFocus = focusIds.length > 0 ? inArray(c.offerId, focusIds) : sql`false`;
      const rows = await db
        .select()
        .from(c)
        .where(
          and(
            eq(c.ownerUserId, owner),
            isNull(c.archivedAt),
            sql`(${c.dueAt} IS NULL OR ${c.dueAt} < ${tomorrow})`,
          ),
        )
        .orderBy(
          sql`CASE WHEN ${isFocus} THEN 0 WHEN ${c.dueAt} IS NOT NULL THEN 1 ELSE 2 END`,
          sql`${c.dueAt} ASC NULLS LAST`,
          asc(c.createdAt),
          asc(c.id),
        )
        .limit(opts.limit);
      return rows.map((row) => ({
        ...row,
        stale: row.kind === "story" && opts.masterHash != null && row.masterHash !== opts.masterHash,
      }));
    },

    /** Non-archived cards, newest first. `topic` matches case-insensitively. */
    async list(
      owner: string,
      opts: { kind?: RevisionKind; topic?: string; limit?: number } = {},
    ): Promise<OpenduetRevisionCard[]> {
      return db
        .select()
        .from(c)
        .where(
          and(
            eq(c.ownerUserId, owner),
            isNull(c.archivedAt),
            opts.kind ? eq(c.kind, opts.kind) : undefined,
            opts.topic ? sql`lower(${c.topic}) = lower(${opts.topic})` : undefined,
          ),
        )
        .orderBy(desc(c.createdAt), asc(c.id))
        .limit(opts.limit ?? 100);
    },

    async listByOffer(owner: string, offerId: string): Promise<OpenduetRevisionCard[]> {
      return db
        .select()
        .from(c)
        .where(and(eq(c.ownerUserId, owner), eq(c.offerId, offerId), isNull(c.archivedAt)))
        .orderBy(asc(c.createdAt), asc(c.id));
    },

    /**
     * Optimistic: the update only applies if the review count is the one just read and the card is not
     * archived, so of two parallel reviews one wins and the other gets `conflict`.
     */
    async review(owner: string, id: string, grade: RevisionGrade, now: Date): Promise<ReviewResult> {
      const card = await get(owner, id);
      if (!card) return { result: "not_found" };
      if (card.archivedAt) return { result: "archived" };
      const { box, dueAt } = nextReview(card.box, grade, now);
      const [row] = await db
        .update(c)
        .set({
          box,
          dueAt,
          reviewCount: card.reviewCount + 1,
          lastGrade: grade,
          lastReviewedAt: now,
          updatedAt: now,
        })
        .where(and(mine(owner, id), eq(c.reviewCount, card.reviewCount), isNull(c.archivedAt)))
        .returning();
      if (row) return { result: "ok", card: row };
      const again = await get(owner, id);
      if (!again) return { result: "not_found" };
      return { result: again.archivedAt ? "archived" : "conflict" };
    },

    /** Idempotent: an already archived card keeps its first archive date. Null when not this owner's. */
    async archive(owner: string, id: string, now = new Date()): Promise<OpenduetRevisionCard | null> {
      const [row] = await db
        .update(c)
        .set({ archivedAt: sql`COALESCE(${c.archivedAt}, ${now})`, updatedAt: now })
        .where(mine(owner, id))
        .returning();
      return row ?? null;
    },

    async countDue(owner: string, now: Date): Promise<{ dueToday: number; newCount: number }> {
      const tomorrow = dueTodayBefore(now);
      const [row] = await db
        .select({
          dueToday: sql<number>`count(*) FILTER (WHERE ${isNotNull(c.dueAt)} AND ${lt(c.dueAt, tomorrow)})::int`,
          newCount: sql<number>`count(*) FILTER (WHERE ${isNull(c.dueAt)})::int`,
        })
        .from(c)
        .where(and(eq(c.ownerUserId, owner), isNull(c.archivedAt)));
      return { dueToday: row?.dueToday ?? 0, newCount: row?.newCount ?? 0 };
    },

    /** Topics of the owner's concept cards (archived ones too, so they are not regenerated). */
    async topicsFor(owner: string, scope: { skillGroupId?: string; offerId?: string } = {}): Promise<string[]> {
      const rows = await db
        .selectDistinct({ topic: c.topic })
        .from(c)
        .where(
          and(
            eq(c.ownerUserId, owner),
            eq(c.kind, "concept"),
            scope.skillGroupId ? eq(c.skillGroupId, scope.skillGroupId) : undefined,
            scope.offerId ? eq(c.offerId, scope.offerId) : undefined,
          ),
        )
        .orderBy(asc(c.topic));
      return rows.map((r) => r.topic);
    },
  };
}

export type RevisionStore = ReturnType<typeof createRevisionStore>;
