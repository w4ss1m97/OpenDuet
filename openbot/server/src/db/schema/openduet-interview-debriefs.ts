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
import { users } from "./core";
import { jsonb } from "./json";
import { openduetItems } from "./openduet-items";
import { openduetMissions } from "./openduet-missions";

/**
 * The debrief of one interview item, written from an Anarlog transcript (Duet never stores the
 * transcript). One debrief per item, and one per Anarlog meeting for a given owner. A row exists only
 * once a meeting matched and its transcript is ready.
 *
 * `claimed_at` is the lock a generation holds while the model works; a claim older than ten minutes is
 * taken as dead. `last_error` is the error's name only, never any transcript text.
 */
export const openduetInterviewDebriefs = pgTable(
  "openduet_interview_debriefs",
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
    anarlogMeetingId: text("anarlog_meeting_id").notNull(),
    status: text("status").$type<DebriefStatus>().notNull(),
    content: jsonb("content").$type<DebriefContent>(),
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
    uniqueIndex("openduet_interview_debriefs_item_idx").on(table.itemId),
    uniqueIndex("openduet_interview_debriefs_owner_meeting_idx").on(
      table.ownerUserId,
      table.anarlogMeetingId,
    ),
    index("openduet_interview_debriefs_owner_status_idx").on(table.ownerUserId, table.status),
    check(
      "openduet_interview_debriefs_status_check",
      sql`${table.status} IN ('pending', 'ready', 'failed')`,
    ),
    check(
      "openduet_interview_debriefs_ready_check",
      sql`${table.status} <> 'ready' OR ${table.content} IS NOT NULL`,
    ),
    check("openduet_interview_debriefs_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export type DebriefStatus = "pending" | "ready" | "failed";

export type DebriefContent = {
  summary: string;
  positives: string[];
  concerns: string[];
  nextSteps: string[];
  followUpBody: string;
};

export type OpenduetInterviewDebrief = typeof openduetInterviewDebriefs.$inferSelect;
