import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type OpenduetItem,
  openduetIntakeCursors,
  openduetItems,
} from "../../db/schema/openduet-items";
import { defaultRemindAt } from "./classify";
import { parisParts } from "./paris-time";
import type { ItemCandidate, ItemStatus, Scanner } from "./types";

export class ItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Item ${id} not found`);
    this.name = "ItemNotFoundError";
  }
}

/** Only an interview or a follow-up can be tied to a mission. */
export class ItemKindError extends Error {
  constructor(id: string) {
    super(`Item ${id} cannot be tied to a mission`);
    this.name = "ItemKindError";
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

    /** Ties the item read from this source to its mission, once: an item already tied keeps its mission. */
    /** Ties an unlinked item to a mission; returns the mission the item is tied to now (an earlier link wins). */
    async linkMission(ownerUserId: string, sourceHash: string, missionId: string): Promise<string | null> {
      const bySource = and(eq(openduetItems.ownerUserId, ownerUserId), eq(openduetItems.sourceHash, sourceHash));
      await db
        .update(openduetItems)
        .set({ missionId, updatedAt: new Date() })
        .where(and(bySource, sql`${openduetItems.missionId} IS NULL`));
      const [row] = await db.select({ missionId: openduetItems.missionId }).from(openduetItems).where(bySource);
      return row?.missionId ?? null;
    },

    async get(ownerUserId: string, id: string): Promise<OpenduetItem> {
      const [row] = await db
        .select()
        .from(openduetItems)
        .where(and(eq(openduetItems.id, id), eq(openduetItems.ownerUserId, ownerUserId)));
      if (!row) throw new ItemNotFoundError(id);
      return row;
    },

    /** Ties the item to a mission, or unties it with null, whatever it was tied to before. */
    async setMission(ownerUserId: string, id: string, missionId: string | null): Promise<OpenduetItem> {
      if (missionId !== null) {
        const item = await this.get(ownerUserId, id);
        if (item.kind !== "interview" && item.kind !== "followup") throw new ItemKindError(id);
      }
      return updateOwned(ownerUserId, id, { missionId });
    },

    /** Active interviews due from `from` (included) to `to` (excluded), soonest first. */
    async listUpcomingInterviews(ownerUserId: string, from: Date, to: Date): Promise<OpenduetItem[]> {
      return db
        .select()
        .from(openduetItems)
        .where(
          and(
            eq(openduetItems.ownerUserId, ownerUserId),
            eq(openduetItems.kind, "interview"),
            eq(openduetItems.status, "active"),
            gte(openduetItems.dueAt, from),
            lt(openduetItems.dueAt, to),
          ),
        )
        .orderBy(openduetItems.dueAt);
    },

    /** Active interview items linked to a mission and due in [from, to), oldest first: the candidates for a debrief. */
    async listEndedInterviews(ownerUserId: string, from: Date, to: Date): Promise<OpenduetItem[]> {
      return db
        .select()
        .from(openduetItems)
        .where(
          and(
            eq(openduetItems.ownerUserId, ownerUserId),
            eq(openduetItems.kind, "interview"),
            // An interview that happened is often marked done: it still gets its debrief.
            inArray(openduetItems.status, ["active", "done"]),
            sql`${openduetItems.missionId} IS NOT NULL`,
            gte(openduetItems.dueAt, from),
            lt(openduetItems.dueAt, to),
          ),
        )
        .orderBy(openduetItems.dueAt);
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

    /** Keeping a card (proposed → active) gives it the reminders its kind and date call for. */
    async setStatus(ownerUserId: string, id: string, status: ItemStatus, now = new Date()) {
      const resolved = status === "done" || status === "dismissed";
      const values: Partial<typeof openduetItems.$inferInsert> = {
        status,
        resolvedAt: resolved ? new Date() : null,
      };
      if (status === "active") {
        const [row] = await db
          .select()
          .from(openduetItems)
          .where(and(eq(openduetItems.id, id), eq(openduetItems.ownerUserId, ownerUserId)));
        if (!row) throw new ItemNotFoundError(id);
        if (row.remindAt.length === 0 && row.dueAt) {
          const local = parisParts(row.dueAt);
          values.remindAt = defaultRemindAt(
            {
              kind: row.kind,
              title: row.title,
              dueAt: row.dueAt,
              allDay: local.hour === 0 && local.minute === 0,
              sourceApp: row.sourceApp,
              sourceHash: row.sourceHash,
              dateExplicit: true,
            },
            now,
          );
        }
      }
      return updateOwned(ownerUserId, id, values);
    },

    /**
     * For sources that change in place (a calendar event that moves, a project's status): inserts
     * the item, or updates its title, date and reminders while it is still proposed or active. A
     * dismissed or done item is left alone. `inserted` says which happened.
     */
    async upsertTracked(
      ownerUserId: string,
      c: ItemCandidate,
      status: ItemStatus,
      remindAt: Date[],
    ): Promise<{ item: OpenduetItem | null; inserted: boolean }> {
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
        .onConflictDoUpdate({
          target: [openduetItems.ownerUserId, openduetItems.sourceHash],
          set: {
            title: sql`excluded.title`,
            why: sql`excluded.why`,
            dueAt: sql`excluded.due_at`,
            remindAt: sql`CASE WHEN ${openduetItems.status} = 'active' THEN excluded.remind_at ELSE '{}'::timestamptz[] END`,
            updatedAt: new Date(),
          },
          setWhere: inArray(openduetItems.status, ["proposed", "active"]),
        })
        .returning({ ...getTableColumns(openduetItems), inserted: sql<boolean>`(xmax = 0)` });
      if (!row) return { item: null, inserted: false };
      const { inserted, ...item } = row;
      return { item, inserted };
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
