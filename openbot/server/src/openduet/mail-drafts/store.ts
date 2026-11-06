import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client";
import {
  type MailDraftKind,
  type MailDraftStatus,
  type OpenduetMailDraft,
  openduetMailDrafts,
} from "../../db/schema/openduet-mail-drafts";

/** A claim held this long is taken as dead and may be claimed again. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

export type NewMailDraft = {
  kind: MailDraftKind;
  missionId?: string | null;
  relanceId?: string | null;
  offerId?: string | null;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  threadId?: string | null;
  attachmentPdf?: Buffer | null;
  attachmentName?: string | null;
};

export type MailDraftPatch = { to?: string[]; cc?: string[]; subject?: string; body?: string };

export type PatchResult =
  | { ok: true; draft: OpenduetMailDraft }
  | { ok: false; reason: "not_found" | "conflict" };

/**
 * Mail drafts Duet prepared. Every query is owner-filtered, so another owner's id is just "not found".
 * A push is claimed (UPDATE ... WHERE claimable RETURNING) and only the holder of a claim (the exact
 * `claimed_at` it was given) may complete or release it.
 */
export function createMailDraftStore(db: Database) {
  const d = openduetMailDrafts;
  const mine = (owner: string, id: string) => and(eq(d.ownerUserId, owner), eq(d.id, id));
  const staleBefore = (now: Date) => new Date(now.getTime() - STALE_CLAIM_MS);
  const unclaimed = (now: Date) => or(sql`${d.claimedAt} IS NULL`, lt(d.claimedAt, staleBefore(now)));

  async function getDraft(owner: string, id: string): Promise<OpenduetMailDraft | null> {
    const [row] = await db.select().from(d).where(mine(owner, id));
    return row ?? null;
  }

  return {
    getDraft,

    /**
     * Creates the draft, or returns the live one (status draft) of the same relance or offer.
     * `created` tells which. The caller has already checked the mission and offer are the owner's.
     */
    async createDraft(
      owner: string,
      input: NewMailDraft,
    ): Promise<{ draft: OpenduetMailDraft; created: boolean }> {
      const [row] = await db
        .insert(d)
        .values({
          id: randomUUID(),
          ownerUserId: owner,
          kind: input.kind,
          missionId: input.missionId ?? null,
          relanceId: input.relanceId ?? null,
          offerId: input.offerId ?? null,
          toAddrs: input.to,
          ccAddrs: input.cc,
          subject: input.subject,
          body: input.body,
          threadId: input.threadId ?? null,
          attachmentPdf: input.attachmentPdf ?? null,
          attachmentName: input.attachmentName ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (row) return { draft: row, created: true };
      const live =
        input.kind === "relance" && input.relanceId
          ? eq(d.relanceId, input.relanceId)
          : eq(d.offerId, input.offerId ?? "");
      const [existing] = await db
        .select()
        .from(d)
        .where(and(eq(d.ownerUserId, owner), eq(d.kind, input.kind), eq(d.status, "draft"), live));
      if (!existing) throw new Error("mail draft conflict without a live draft");
      return { draft: existing, created: false };
    },

    async listDrafts(owner: string, status?: MailDraftStatus): Promise<OpenduetMailDraft[]> {
      return db
        .select()
        .from(d)
        .where(and(eq(d.ownerUserId, owner), status ? eq(d.status, status) : undefined))
        .orderBy(desc(d.createdAt));
    },

    /** Editable while it is a draft and no push holds it. */
    async patchDraft(
      owner: string,
      id: string,
      patch: MailDraftPatch,
      now = new Date(),
    ): Promise<PatchResult> {
      const [row] = await db
        .update(d)
        .set({
          ...(patch.to ? { toAddrs: patch.to } : {}),
          ...(patch.cc ? { ccAddrs: patch.cc } : {}),
          ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          updatedAt: now,
        })
        .where(and(mine(owner, id), eq(d.status, "draft"), unclaimed(now)))
        .returning();
      if (row) return { ok: true, draft: row };
      return { ok: false, reason: (await getDraft(owner, id)) ? "conflict" : "not_found" };
    },

    /** Takes the draft to push: status draft, unclaimed or with a stale claim. Null when there is nothing to take. */
    async claimPush(owner: string, id: string, now = new Date()): Promise<OpenduetMailDraft | null> {
      const [row] = await db
        .update(d)
        .set({ claimedAt: now, updatedAt: now })
        .where(and(mine(owner, id), eq(d.status, "draft"), unclaimed(now)))
        .returning();
      return row ?? null;
    },

    /** False when the claim is no longer this holder's. */
    async completePush(
      owner: string,
      id: string,
      claimedAt: Date,
      gmailDraftId: string,
    ): Promise<boolean> {
      const now = new Date();
      const rows = await db
        .update(d)
        .set({ status: "pushed", gmailDraftId, pushedAt: now, claimedAt: null, lastError: null, updatedAt: now })
        .where(and(mine(owner, id), eq(d.claimedAt, claimedAt)))
        .returning({ id: d.id });
      return rows.length > 0;
    },

    /** Gives the claim back, with the failure when there was one. False when the claim is not this holder's. */
    async releasePush(owner: string, id: string, claimedAt: Date, error: string | null): Promise<boolean> {
      const rows = await db
        .update(d)
        .set({ claimedAt: null, lastError: error, updatedAt: new Date() })
        .where(and(mine(owner, id), eq(d.claimedAt, claimedAt)))
        .returning({ id: d.id });
      return rows.length > 0;
    },

    /** Only a live draft can be dismissed. Null when it is not this owner's, or no longer a draft. */
    async dismissDraft(owner: string, id: string): Promise<OpenduetMailDraft | null> {
      const [row] = await db
        .update(d)
        .set({ status: "dismissed", claimedAt: null, updatedAt: new Date() })
        .where(and(mine(owner, id), eq(d.status, "draft")))
        .returning();
      return row ?? null;
    },
  };
}

export type MailDraftStore = ReturnType<typeof createMailDraftStore>;
