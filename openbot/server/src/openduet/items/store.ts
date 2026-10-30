import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type OpenduetItem,
  openduetIntakeCursors,
  openduetItems,
} from "../../db/schema/openduet-items";
import type { ItemCandidate, ItemStatus, Scanner } from "./types";

export class ItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Item ${id} not found`);
    this.name = "ItemNotFoundError";
  }
}

export type ItemQuery = {
  status?: ItemStatus[];
  remindFrom?: Date;
  remindTo?: Date;
};

export function createItemStore(db: Database) {
  async function updateOwned(
    ownerUserId: string,
    id: string,
    values: Partial<typeof openduetItems.$inferInsert>,
  ): Promise<OpenduetItem> {
    const [row] = await db
      .update(openduetItems)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(eq(openduetItems.id, id), eq(openduetItems.ownerUserId, ownerUserId)),
      )
      .returning();
    if (!row) throw new ItemNotFoundError(id);
    return row;
  }

  return {
    /** Writes the item unless this source was already seen, whatever its status. Null when seen. */
    async insertIfNew(
      ownerUserId: string,
      c: ItemCandidate,
      status: ItemStatus,
      remindAt: Date[],
    ): Promise<OpenduetItem | null> {
      const [row] = await db
        .insert(openduetItems)
        .values({
          id: randomUUID(),
          ownerUserId,
          kind: c.kind,
          title: c.title,
          why: c.why ?? null,
          dueAt: c.dueAt ?? null,
          remindAt,
          amount: c.amount ?? null,
          currency: c.currency ?? "EUR",
          channelId: c.channelId ?? null,
          sourceApp: c.sourceApp,
          sourceLink: c.sourceLink ?? null,
          sourceHash: c.sourceHash,
          status,
        })
        .onConflictDoNothing({
          target: [openduetItems.ownerUserId, openduetItems.sourceHash],
        })
        .returning();
      return row ?? null;
    },

    async list(ownerUserId: string, q: ItemQuery = {}): Promise<OpenduetItem[]> {
      const where: SQL[] = [eq(openduetItems.ownerUserId, ownerUserId)];
      if (q.status?.length) where.push(inArray(openduetItems.status, q.status));
      if (q.remindFrom || q.remindTo) {
        const from = q.remindFrom ?? new Date(0);
        const to = q.remindTo ?? new Date(8.64e15);
        where.push(
          sql`EXISTS (SELECT 1 FROM unnest(${openduetItems.remindAt}) AS r WHERE r >= ${from} AND r < ${to})`,
        );
      }
      return db
        .select()
        .from(openduetItems)
        .where(and(...where))
        .orderBy(sql`${openduetItems.dueAt} ASC NULLS LAST`, openduetItems.createdAt);
    },

    async setStatus(ownerUserId: string, id: string, status: ItemStatus) {
      const resolved = status === "done" || status === "dismissed";
      return updateOwned(ownerUserId, id, {
        status,
        resolvedAt: resolved ? new Date() : null,
      });
    },

    async snooze(ownerUserId: string, id: string, until: Date) {
      const [row] = await db
        .update(openduetItems)
        .set({
          remindAt: sql`array_append(${openduetItems.remindAt}, ${until}::timestamptz)`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(openduetItems.id, id), eq(openduetItems.ownerUserId, ownerUserId)),
        )
        .returning();
      if (!row) throw new ItemNotFoundError(id);
      return row;
    },

    async getCursor(
      ownerUserId: string,
      scanner: Scanner,
    ): Promise<{ lastSuccessAt: Date | null; cursor: unknown }> {
      const [row] = await db
        .select()
        .from(openduetIntakeCursors)
        .where(
          and(
            eq(openduetIntakeCursors.ownerUserId, ownerUserId),
            eq(openduetIntakeCursors.scanner, scanner),
          ),
        );
      return { lastSuccessAt: row?.lastSuccessAt ?? null, cursor: row?.cursor ?? {} };
    },

    async advanceCursor(
      ownerUserId: string,
      scanner: Scanner,
      cursor: unknown,
      at: Date,
    ): Promise<void> {
      await db
        .insert(openduetIntakeCursors)
        .values({ ownerUserId, scanner, cursor, lastSuccessAt: at, lastError: null })
        .onConflictDoUpdate({
          target: [openduetIntakeCursors.ownerUserId, openduetIntakeCursors.scanner],
          set: { cursor, lastSuccessAt: at, lastError: null, updatedAt: new Date() },
        });
    },

    /** Notes the error and leaves the cursor where the last success put it. */
    async recordFailure(ownerUserId: string, scanner: Scanner, error: string) {
      await db
        .insert(openduetIntakeCursors)
        .values({ ownerUserId, scanner, lastError: error })
        .onConflictDoUpdate({
          target: [openduetIntakeCursors.ownerUserId, openduetIntakeCursors.scanner],
          set: { lastError: error, updatedAt: new Date() },
        });
    },

    async countSince(
      ownerUserId: string,
      since: Date,
    ): Promise<{ added: number; proposed: number }> {
      const rows = await db
        .select({ status: openduetItems.status, n: sql<number>`count(*)::int` })
        .from(openduetItems)
        .where(
          and(
            eq(openduetItems.ownerUserId, ownerUserId),
            gte(openduetItems.createdAt, since),
          ),
        )
        .groupBy(openduetItems.status);
      const count = (status: ItemStatus) =>
        rows.find((row) => row.status === status)?.n ?? 0;
      return { added: count("active"), proposed: count("proposed") };
    },
  };
}

export type ItemStore = ReturnType<typeof createItemStore>;
