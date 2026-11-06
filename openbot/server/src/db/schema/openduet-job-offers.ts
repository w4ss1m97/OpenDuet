import { sql } from "drizzle-orm";
import {
  boolean,
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
import { openduetMissions } from "./openduet-missions";

/**
 * A mail or pasted text that may carry job offers (Malt, Free-Work, Collective). One row per Gmail id or
 * per pasted text for an owner. `claimed_at` is the lock a sweep holds while it reads and extracts; a claim
 * older than ten minutes is taken as dead. `last_error` is the error's name only. `paste_text` is emptied
 * once the source is done.
 */
export const openduetOfferSources = pgTable(
  "openduet_offer_sources",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceKey: text("source_key").notNull(),
    platform: text("platform").$type<OfferPlatform>().notNull(),
    status: text("status").$type<OfferSourceStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    offersFound: integer("offers_found").notNull().default(0),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    pasteText: text("paste_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("openduet_offer_sources_owner_key_idx").on(table.ownerUserId, table.sourceKey),
    index("openduet_offer_sources_owner_status_idx").on(table.ownerUserId, table.status),
    check(
      "openduet_offer_sources_status_check",
      sql`${table.status} IN ('pending', 'done', 'failed', 'skipped')`,
    ),
    check("openduet_offer_sources_attempts_check", sql`${table.attempts} >= 0`),
    check("openduet_offer_sources_found_check", sql`${table.offersFound} >= 0`),
  ],
);

/** One job offer seen in a source, scored against the profile. Unique per owner and `dedup_key`. */
export const openduetOffers = pgTable(
  "openduet_offers",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceId: text("source_id").references(() => openduetOfferSources.id, { onDelete: "set null" }),
    dedupKey: text("dedup_key").notNull(),
    platform: text("platform").$type<OfferPlatform>().notNull(),
    url: text("url"),
    title: text("title").notNull(),
    company: text("company"),
    tjmMin: integer("tjm_min"),
    tjmMax: integer("tjm_max"),
    rateUnit: text("rate_unit").$type<OfferRateUnit>().notNull().default("unknown"),
    contract: text("contract").$type<OfferContract>().notNull().default("unknown"),
    remote: text("remote").$type<OfferRemote>().notNull().default("unknown"),
    location: text("location"),
    durationMonths: integer("duration_months"),
    startAsap: boolean("start_asap").notNull().default(false),
    skills: text("skills")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    description: text("description"),
    status: text("status").$type<OfferStatus>().notNull().default("new"),
    filterReason: text("filter_reason").$type<OfferFilterReason>(),
    tjmUnknown: boolean("tjm_unknown").notNull().default(false),
    score: integer("score"),
    reasons: jsonb("reasons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    missingSkills: jsonb("missing_skills").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    profileHash: text("profile_hash"),
    scoreAttempts: integer("score_attempts").notNull().default(0),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    scoredAt: timestamp("scored_at", { withTimezone: true }),
    missionId: text("mission_id").references(() => openduetMissions.id, { onDelete: "set null" }),
    seenCount: integer("seen_count").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("openduet_offers_owner_dedup_idx").on(table.ownerUserId, table.dedupKey),
    index("openduet_offers_owner_status_score_idx").on(table.ownerUserId, table.status, table.score),
    check(
      "openduet_offers_status_check",
      sql`${table.status} IN ('new', 'scored', 'shown', 'filtered', 'dismissed', 'applied')`,
    ),
    check(
      "openduet_offers_filter_reason_check",
      sql`${table.filterReason} IS NULL OR ${table.filterReason} IN ('salaried', 'low_tjm', 'outside_idf')`,
    ),
    check("openduet_offers_rate_unit_check", sql`${table.rateUnit} IN ('day', 'hour', 'year', 'unknown')`),
    check("openduet_offers_contract_check", sql`${table.contract} IN ('freelance', 'salaried', 'unknown')`),
    check("openduet_offers_remote_check", sql`${table.remote} IN ('full', 'hybrid', 'onsite', 'unknown')`),
    check("openduet_offers_score_check", sql`${table.score} IS NULL OR (${table.score} >= 0 AND ${table.score} <= 100)`),
    check("openduet_offers_score_attempts_check", sql`${table.scoreAttempts} >= 0`),
    check("openduet_offers_seen_count_check", sql`${table.seenCount} >= 1`),
  ],
);

export type OfferPlatform = "malt" | "free-work" | "collective" | "paste";
export type OfferSourceStatus = "pending" | "done" | "failed" | "skipped";
export type OfferStatus = "new" | "scored" | "shown" | "filtered" | "dismissed" | "applied";
export type OfferFilterReason = "salaried" | "low_tjm" | "outside_idf";
export type OfferRateUnit = "day" | "hour" | "year" | "unknown";
export type OfferContract = "freelance" | "salaried" | "unknown";
export type OfferRemote = "full" | "hybrid" | "onsite" | "unknown";

export type OpenduetOfferSource = typeof openduetOfferSources.$inferSelect;
export type OpenduetOffer = typeof openduetOffers.$inferSelect;
