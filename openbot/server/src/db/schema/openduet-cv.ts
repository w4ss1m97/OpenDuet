import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { CvMaster } from "../../openduet/job-offers/cv-schema";
import { users } from "./core";
import { jsonb } from "./json";
import { openduetOffers } from "./openduet-job-offers";

/** The owner's master CV (one per owner): the only source of text for tailored CVs. */
export const openduetCvMasters = pgTable("openduet_cv_masters", {
  ownerUserId: text("owner_user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  content: jsonb("content").$type<CvMaster>().notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A CV tailored to one offer. `claimed_at` is the lock a generation holds; older than ten minutes it is
 * taken as dead. `last_error` is the error's name only. `master_hash` is the master it was built from.
 */
export const openduetCvVersions = pgTable(
  "openduet_cv_versions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    offerId: text("offer_id")
      .notNull()
      .references(() => openduetOffers.id, { onDelete: "cascade" }),
    status: text("status").$type<CvVersionStatus>().notNull().default("pending"),
    content: jsonb("content").$type<CvMaster>(),
    match: jsonb("match").$type<CvMatch>(),
    masterHash: text("master_hash"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("openduet_cv_versions_owner_offer_idx").on(table.ownerUserId, table.offerId),
    check("openduet_cv_versions_status_check", sql`${table.status} IN ('pending', 'ready', 'failed')`),
    check(
      "openduet_cv_versions_ready_check",
      sql`${table.status} <> 'ready' OR (${table.content} IS NOT NULL AND ${table.match} IS NOT NULL AND ${table.generatedAt} IS NOT NULL)`,
    ),
  ],
);

export type CvVersionStatus = "pending" | "ready" | "failed";
export type CvMatch = { covered: string[]; missing: string[] };
export type OpenduetCvMaster = typeof openduetCvMasters.$inferSelect;
export type OpenduetCvVersion = typeof openduetCvVersions.$inferSelect;
