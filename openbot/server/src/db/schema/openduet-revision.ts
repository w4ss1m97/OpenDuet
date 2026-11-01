import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./core";
import { jsonb } from "./json";
import { openduetOffers } from "./openduet-job-offers";

/**
 * A revision card with its Leitner review state (one row each, no review log). `dedup_key` is computed by
 * the caller; the unique index only enforces it. `master_hash` is the master CV a story card was built from.
 */
export const openduetRevisionCards = pgTable(
  "openduet_revision_cards",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<RevisionKind>().notNull(),
    topic: text("topic").notNull(),
    skillGroupId: text("skill_group_id"),
    offerId: text("offer_id").references(() => openduetOffers.id, { onDelete: "set null" }),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    keyPoints: jsonb("key_points").$type<string[]>().notNull().default([]),
    bulletIds: text("bullet_ids").array().notNull().default(sql`'{}'::text[]`),
    masterHash: text("master_hash").notNull(),
    dedupKey: text("dedup_key").notNull(),
    box: integer("box").notNull().default(1),
    dueAt: timestamp("due_at", { withTimezone: true }),
    reviewCount: integer("review_count").notNull().default(0),
    lastGrade: text("last_grade").$type<RevisionGrade>(),
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("openduet_revision_cards_owner_dedup_idx").on(table.ownerUserId, table.dedupKey),
    index("openduet_revision_cards_owner_due_idx").on(table.ownerUserId, table.archivedAt, table.dueAt),
    check("openduet_revision_cards_kind_check", sql`${table.kind} IN ('concept', 'story', 'pitch')`),
    check("openduet_revision_cards_box_check", sql`${table.box} BETWEEN 1 AND 5`),
    check("openduet_revision_cards_review_count_check", sql`${table.reviewCount} >= 0`),
    check(
      "openduet_revision_cards_grade_check",
      sql`${table.lastGrade} IS NULL OR ${table.lastGrade} IN ('again', 'hard', 'good')`,
    ),
    check(
      "openduet_revision_cards_story_check",
      sql`${table.kind} <> 'story' OR cardinality(${table.bulletIds}) >= 1`,
    ),
  ],
);

export type RevisionKind = "concept" | "story" | "pitch";
export type RevisionGrade = "again" | "hard" | "good";
export type OpenduetRevisionCard = typeof openduetRevisionCards.$inferSelect;
