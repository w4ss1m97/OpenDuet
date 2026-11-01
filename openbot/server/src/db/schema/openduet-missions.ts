import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Review, Stage } from "../../openduet/missions/stages";
import { users } from "./core";

/**
 * A freelance mission Duet follows from first lead to signature or refusal. The mail intake and the
 * chat tool move it along (openduet/missions/store.ts); items (an interview, a follow-up) point to it
 * through `openduet_items.mission_id`.
 *
 * `company_key` and `role_key` are the normalized names (`companyKey`), so "Acme SAS" and "acme" are one
 * mission; `role_key` is '' when no role is known. A mission is one-per-company-and-role while it is
 * open and not dismissed, which is what the partial unique index below says. An empty `company_key`
 * (a lead whose company is unknown) is exempt.
 *
 * `thread_ids` and `contact_emails` are how a later mail finds its mission: by thread, then by contact,
 * never by company alone.
 */
export const openduetMissions = pgTable(
  "openduet_missions",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    company: text("company").notNull(),
    role: text("role"),
    companyKey: text("company_key").notNull(),
    roleKey: text("role_key").notNull().default(""),
    stage: text("stage").$type<Stage>().notNull(),
    review: text("review").$type<Review>().notNull(),
    title: text("title").notNull(),
    threadIds: text("thread_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    contactEmails: text("contact_emails")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("openduet_missions_owner_review_stage_idx").on(
      table.ownerUserId,
      table.review,
      table.stage,
    ),
    index("openduet_missions_thread_ids_idx").using("gin", table.threadIds),
    uniqueIndex("openduet_missions_open_company_role_idx")
      .on(table.ownerUserId, table.companyKey, table.roleKey)
      .where(
        sql`${table.companyKey} <> '' AND ${table.stage} NOT IN ('signed', 'refused') AND ${table.review} <> 'dismissed'`,
      ),
    check(
      "openduet_missions_stage_check",
      sql`${table.stage} IN ('piste', 'applied', 'talking', 'interview', 'offer', 'signed', 'refused')`,
    ),
    check(
      "openduet_missions_review_check",
      sql`${table.review} IN ('proposed', 'active', 'dismissed')`,
    ),
    check(
      "openduet_missions_closed_check",
      sql`(${table.stage} IN ('signed', 'refused')) = (${table.closedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * Append-only history. `source_hash` (the mail id, for a mail) makes reading the same mail twice a
 * no-op: the second insert conflicts and the store stops there.
 */
export const openduetMissionEvents = pgTable(
  "openduet_mission_events",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id")
      .notNull()
      .references(() => openduetMissions.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<MissionEventType>().notNull(),
    fromStage: text("from_stage").$type<Stage>(),
    toStage: text("to_stage").$type<Stage>(),
    source: text("source").$type<MissionEventSource>().notNull(),
    sourceHash: text("source_hash"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("openduet_mission_events_mission_source_hash_idx").on(
      table.missionId,
      table.sourceHash,
    ),
    index("openduet_mission_events_mission_at_idx").on(table.missionId, table.at),
    check(
      "openduet_mission_events_type_check",
      sql`${table.type} IN ('stage', 'inbound', 'relance_sent', 'debrief')`,
    ),
    check(
      "openduet_mission_events_source_check",
      sql`${table.source} IN ('mail', 'chat', 'app')`,
    ),
  ],
);

/** A relance Duet wrote for a silent mission. One per silence window (`window_start` = the silence anchor). */
export const openduetMissionRelances = pgTable(
  "openduet_mission_relances",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id")
      .notNull()
      .references(() => openduetMissions.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    body: text("body").notNull(),
    status: text("status").$type<RelanceStatus>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("openduet_mission_relances_mission_window_idx").on(
      table.missionId,
      table.windowStart,
    ),
    check(
      "openduet_mission_relances_status_check",
      sql`${table.status} IN ('draft', 'sent', 'dismissed')`,
    ),
  ],
);

export type MissionEventType = "stage" | "inbound" | "relance_sent" | "debrief";
export type MissionEventSource = "mail" | "chat" | "app";
export type RelanceStatus = "draft" | "sent" | "dismissed";

export type OpenduetMission = typeof openduetMissions.$inferSelect;
export type OpenduetMissionEvent = typeof openduetMissionEvents.$inferSelect;
export type OpenduetMissionRelance = typeof openduetMissionRelances.$inferSelect;
