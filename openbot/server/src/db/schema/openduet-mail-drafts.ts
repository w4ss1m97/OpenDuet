import { sql } from "drizzle-orm";
import { check, customType, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./core";
import { openduetMissionRelances, openduetMissions } from "./openduet-missions";
import { openduetOffers } from "./openduet-job-offers";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * A mail Duet prepared for the owner (a mission relance, or an application with the tailored CV attached).
 * It stays in Duet, editable, until the owner pushes it: only then is a Gmail DRAFT created. Duet never sends.
 *
 * `claimed_at` is the lock a push holds; older than ten minutes it is taken as dead. `attachment_pdf` is
 * rendered once when an application draft is created, so a push retried after an approval carries
 * byte-identical arguments. `last_error` is a short message of the failed push, never a stack.
 */
export const openduetMailDrafts = pgTable(
  "openduet_mail_drafts",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<MailDraftKind>().notNull(),
    missionId: text("mission_id").references(() => openduetMissions.id, { onDelete: "cascade" }),
    relanceId: text("relance_id").references(() => openduetMissionRelances.id, { onDelete: "set null" }),
    offerId: text("offer_id").references(() => openduetOffers.id, { onDelete: "cascade" }),
    toAddrs: text("to_addrs")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ccAddrs: text("cc_addrs")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    threadId: text("thread_id"),
    attachmentPdf: bytea("attachment_pdf"),
    attachmentName: text("attachment_name"),
    status: text("status").$type<MailDraftStatus>().notNull().default("draft"),
    gmailDraftId: text("gmail_draft_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastError: text("last_error"),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("openduet_mail_drafts_owner_status_idx").on(table.ownerUserId, table.status, table.createdAt),
    uniqueIndex("openduet_mail_drafts_live_relance_idx")
      .on(table.ownerUserId, table.relanceId)
      .where(sql`${table.status} = 'draft' AND ${table.relanceId} IS NOT NULL`),
    uniqueIndex("openduet_mail_drafts_live_application_idx")
      .on(table.ownerUserId, table.offerId)
      .where(sql`${table.status} = 'draft' AND ${table.kind} = 'application'`),
    check("openduet_mail_drafts_kind_check", sql`${table.kind} IN ('relance', 'application')`),
    check("openduet_mail_drafts_status_check", sql`${table.status} IN ('draft', 'pushed', 'dismissed')`),
    check("openduet_mail_drafts_relance_check", sql`${table.kind} <> 'relance' OR ${table.missionId} IS NOT NULL`),
    check("openduet_mail_drafts_application_check", sql`${table.kind} <> 'application' OR ${table.offerId} IS NOT NULL`),
    check(
      "openduet_mail_drafts_pushed_check",
      sql`${table.status} <> 'pushed' OR (${table.gmailDraftId} IS NOT NULL AND ${table.pushedAt} IS NOT NULL)`,
    ),
  ],
);

export type MailDraftKind = "relance" | "application";
export type MailDraftStatus = "draft" | "pushed" | "dismissed";
export type OpenduetMailDraft = typeof openduetMailDrafts.$inferSelect;
