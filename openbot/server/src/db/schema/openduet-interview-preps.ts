import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PrepContent } from "../../openduet/missions/prep";
import { users } from "./core";
import { jsonb } from "./json";
import { openduetItems } from "./openduet-items";
import { openduetMissions } from "./openduet-missions";

/**
 * The preparation sheet for one interview item (openduet/missions/prep.ts writes it, prep-store.ts keeps
 * it). One sheet per item: `item_id` is unique, and a sheet for another mission starts over rather than
 * adding a second row.
 *
 * `claimed_at` is the lock a generation holds while the model works; a claim older than ten minutes is
 * taken as dead. `last_error` is the error's name only, never any mail text.
 */
export const openduetInterviewPreps = pgTable(
  "openduet_interview_preps",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => openduetItems.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    missionId: text("mission_id")
      .notNull()
      .references(() => openduetMissions.id, { onDelete: "cascade" }),
    status: text("status").$type<PrepStatus>().notNull(),
    content: jsonb("content").$type<PrepContent>(),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("openduet_interview_preps_item_idx").on(table.itemId),
    index("openduet_interview_preps_owner_status_idx").on(table.ownerUserId, table.status),
    check(
      "openduet_interview_preps_status_check",
      sql`${table.status} IN ('pending', 'ready', 'failed')`,
    ),
    check(
      "openduet_interview_preps_ready_check",
      sql`${table.status} <> 'ready' OR ${table.content} IS NOT NULL`,
    ),
    check("openduet_interview_preps_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export type PrepStatus = "pending" | "ready" | "failed";

export type OpenduetInterviewPrep = typeof openduetInterviewPreps.$inferSelect;
