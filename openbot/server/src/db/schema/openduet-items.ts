import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ItemKind, ItemStatus, Scanner } from "../../openduet/items/types";
import { users } from "./core";
import { jsonb } from "./json";
import { openduetTasks } from "./openduet";

/**
 * Something Duet keeps for its person, not work it does itself: an interview, a bill, a fine, an idea
 * found in their notes, where a project stands. The intake (openduet/items/intake.ts) writes them from
 * mail, calendar, Apple Notes and project folders; the iOS app turns their `remind_at` into local
 * notifications, so a reminder still fires while the Mac that runs Duet is off.
 *
 * `source_hash` is the dedup key: an item is never written twice for the same source, whatever its
 * status, so a card the person dismissed does not come back on the next intake.
 *
 * `channel_id` is the tenant channel slug (missions, projets, maison, duet), kept as text rather than
 * a foreign key so an item survives a channel being renamed or removed.
 */
export const openduetItems = pgTable(
  "openduet_items",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ItemKind>().notNull(),
    title: text("title").notNull(),
    why: text("why"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    remindAt: timestamp("remind_at", { withTimezone: true })
      .array()
      .notNull()
      .default(sql`'{}'::timestamptz[]`),
    amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }),
    currency: text("currency").notNull().default("EUR"),
    channelId: text("channel_id"),
    sourceApp: text("source_app").notNull(),
    sourceLink: text("source_link"),
    sourceHash: text("source_hash").notNull(),
    status: text("status").$type<ItemStatus>().notNull(),
    taskId: text("task_id").references(() => openduetTasks.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("openduet_items_owner_source_hash_idx").on(
      table.ownerUserId,
      table.sourceHash,
    ),
    index("openduet_items_owner_status_due_idx").on(
      table.ownerUserId,
      table.status,
      table.dueAt,
    ),
    check(
      "openduet_items_kind_check",
      sql`${table.kind} IN ('interview', 'followup', 'bill', 'fine', 'deadline', 'idea', 'todo', 'project_status')`,
    ),
    check(
      "openduet_items_status_check",
      sql`${table.status} IN ('proposed', 'active', 'done', 'dismissed')`,
    ),
  ],
);

/** Where each intake scanner stopped. Moves only when the scanner fully succeeded. */
export const openduetIntakeCursors = pgTable(
  "openduet_intake_cursors",
  {
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scanner: text("scanner").$type<Scanner>().notNull(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    cursor: jsonb("cursor").$type<unknown>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerUserId, table.scanner] }),
    check(
      "openduet_intake_cursors_scanner_check",
      sql`${table.scanner} IN ('mail', 'calendar', 'notes', 'projects')`,
    ),
  ],
);

export type OpenduetItem = typeof openduetItems.$inferSelect;
