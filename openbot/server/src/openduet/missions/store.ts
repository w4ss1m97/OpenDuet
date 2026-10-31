import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client";
import { openduetItems } from "../../db/schema/openduet-items";
import {
  type MissionEventSource,
  type OpenduetMission,
  type OpenduetMissionRelance,
  type RelanceStatus,
  openduetMissionEvents,
  openduetMissionRelances,
  openduetMissions,
} from "../../db/schema/openduet-missions";
import { companyKey, contactOf } from "./mail-signal";
import { relanceBody, relanceDue, silenceAnchor } from "./relance";
import { type Review, type Stage, canTransition, isTerminal } from "./stages";

export class MissionNotFoundError extends Error {
  constructor(id: string) {
    super(`Mission ${id} not found`);
    this.name = "MissionNotFoundError";
  }
}

export class IllegalTransitionError extends Error {
  constructor(from: Stage, to: Stage) {
    super(`A mission cannot go from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/** A mail asked to refuse or make an offer on a mission it was not matched to by thread or contact. */
export class UntrustedMatchError extends Error {
  constructor(to: Stage, matchedBy: string | undefined) {
    super(`A mail cannot move a mission to ${to} on a ${matchedBy ?? "missing"} match`);
    this.name = "UntrustedMatchError";
  }
}

/** Another open mission already has this company and role. */
export class MissionConflictError extends Error {
  constructor() {
    super("Another open mission has this company and role");
    this.name = "MissionConflictError";
  }
}

export type MatchedBy = "thread" | "contact" | "company" | "chat" | "app";

export type AdvanceInput = {
  to: Stage;
  source: MissionEventSource;
  /** Dedup key: the same hash on the same mission is read once. Mail id for a mail. */
  sourceHash?: string;
  at?: Date;
  /** How the caller found this mission. A mail may refuse or offer only on `thread` or `contact`. */
  matchedBy?: MatchedBy;
};

export type AdvanceResult = {
  mission: OpenduetMission;
  /** The stage changed. */
  moved: boolean;
  /** This source was already read: nothing was written. */
  duplicate: boolean;
};

export type MailMatch =
  | { kind: "match"; matchedBy: "thread" | "contact" | "company"; mission: OpenduetMission }
  | { kind: "ambiguous"; matchedBy: "thread" | "contact" | "company"; missions: OpenduetMission[] }
  | { kind: "none" };

export type ChatResult =
  | { kind: "created"; mission: OpenduetMission }
  | { kind: "advanced"; mission: OpenduetMission; moved: boolean }
  | { kind: "ambiguous"; missions: OpenduetMission[] };

export type MissionQuery = {
  review?: Review[];
  stage?: Stage[];
  /** Not signed, refused or dismissed. */
  open?: boolean;
};

export type MissionPatch = {
  company?: string;
  role?: string | null;
  title?: string;
  review?: Review;
  contactEmails?: string[];
  /** Fold this mission into another: threads, contacts and items move, this one is dismissed. */
  mergeInto?: string;
};

const CLOSED: Stage[] = ["signed", "refused"];

function uniqueViolation(error: unknown): boolean {
  // Bun's SQL driver puts the SQLSTATE in `errno`, node-postgres in `code`; drizzle wraps either as `cause`.
  const e = error as { code?: string; errno?: string; cause?: { code?: string; errno?: string } };
  return [e?.code, e?.errno, e?.cause?.code, e?.cause?.errno].includes("23505");
}

function titleOf(company: string, role: string | null | undefined): string {
  return role ? `${role} chez ${company}` : company;
}

export function createMissionStore(db: Database) {
  async function getOwned(ownerUserId: string, id: string): Promise<OpenduetMission> {
    const [row] = await db
      .select()
      .from(openduetMissions)
      .where(and(eq(openduetMissions.id, id), eq(openduetMissions.ownerUserId, ownerUserId)));
    if (!row) throw new MissionNotFoundError(id);
    return row;
  }

  /** Missions a mail or a chat message could still be about. */
  function openWhere(ownerUserId: string): SQL[] {
    return [
      eq(openduetMissions.ownerUserId, ownerUserId),
      notInArray(openduetMissions.stage, CLOSED),
      sql`${openduetMissions.review} <> 'dismissed'`,
    ];
  }

  async function advance(
    ownerUserId: string,
    id: string,
    input: AdvanceInput,
  ): Promise<AdvanceResult> {
    if (input.source === "mail" && (input.to === "refused" || input.to === "offer")) {
      if (input.matchedBy !== "thread" && input.matchedBy !== "contact") {
        throw new UntrustedMatchError(input.to, input.matchedBy);
      }
    }
    const at = input.at ?? new Date();
    const fromMail = input.source === "mail";

    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(openduetMissions)
        .where(and(eq(openduetMissions.id, id), eq(openduetMissions.ownerUserId, ownerUserId)));
      if (!current) throw new MissionNotFoundError(id);

      // The event goes first: a source already read stops here, before anything else is touched.
      const moves = canTransition(current.stage, input.to);
      if (!moves && !fromMail) throw new IllegalTransitionError(current.stage, input.to);
      const eventId = randomUUID();
      const [event] = await tx
        .insert(openduetMissionEvents)
        .values({
          id: eventId,
          missionId: id,
          ownerUserId,
          type: moves ? "stage" : "inbound",
          fromStage: current.stage,
          toStage: moves ? input.to : current.stage,
          source: input.source,
          sourceHash: input.sourceHash ?? null,
          at,
        })
        .onConflictDoNothing()
        .returning();
      if (!event) return { mission: current, moved: false, duplicate: true };

      async function refreshInbound(): Promise<OpenduetMission> {
        const [row] = await tx
          .update(openduetMissions)
          .set({
            lastInboundAt: sql`GREATEST(${openduetMissions.lastInboundAt}, ${at.toISOString()}::timestamptz)`,
            updatedAt: new Date(),
          })
          .where(eq(openduetMissions.id, id))
          .returning();
        return row as OpenduetMission;
      }

      if (!moves) return { mission: await refreshInbound(), moved: false, duplicate: false };

      // Compare-and-set on the stage we read. If another advance won, re-read once and judge again.
      let from = current.stage;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [row] = await tx
          .update(openduetMissions)
          .set({
            stage: input.to,
            stageEnteredAt: at,
            closedAt: isTerminal(input.to) ? at : null,
            lastInboundAt: fromMail
              ? sql`GREATEST(${openduetMissions.lastInboundAt}, ${at.toISOString()}::timestamptz)`
              : undefined,
            updatedAt: new Date(),
          })
          .where(and(eq(openduetMissions.id, id), eq(openduetMissions.stage, from)))
          .returning();
        if (row) {
          if (from !== current.stage) {
            await tx.update(openduetMissionEvents).set({ fromStage: from }).where(eq(openduetMissionEvents.id, eventId));
          }
          return { mission: row, moved: true, duplicate: false };
        }
        const [fresh] = await tx.select().from(openduetMissions).where(eq(openduetMissions.id, id));
        if (!fresh) throw new MissionNotFoundError(id);
        if (!canTransition(fresh.stage, input.to)) {
          if (!fromMail) throw new IllegalTransitionError(fresh.stage, input.to);
          await tx
            .update(openduetMissionEvents)
            .set({ type: "inbound", fromStage: fresh.stage, toStage: fresh.stage })
            .where(eq(openduetMissionEvents.id, eventId));
          return { mission: await refreshInbound(), moved: false, duplicate: false };
        }
        from = fresh.stage;
      }
      throw new IllegalTransitionError(from, input.to);
    });
  }

  async function createPiste(
    ownerUserId: string,
    input: {
      company: string;
      role?: string | null;
      review: Review;
      stage?: Stage;
      title?: string;
      threadId?: string;
      contactEmail?: string;
      at?: Date;
    },
  ): Promise<{ mission: OpenduetMission; created: boolean }> {
    const key = companyKey(input.company);
    const roleKey = companyKey(input.role ?? "");
    const stage = input.stage ?? "piste";
    const at = input.at ?? new Date();
    const [row] = await db
      .insert(openduetMissions)
      .values({
        id: randomUUID(),
        ownerUserId,
        company: input.company.trim(),
        role: input.role?.trim() || null,
        companyKey: key,
        roleKey,
        stage,
        review: input.review,
        title: input.title ?? titleOf(input.company.trim(), input.role?.trim()),
        threadIds: input.threadId ? [input.threadId] : [],
        contactEmails: input.contactEmail ? [input.contactEmail.toLowerCase()] : [],
        stageEnteredAt: at,
        lastInboundAt: input.threadId || input.contactEmail ? at : null,
        closedAt: isTerminal(stage) ? at : null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return { mission: row, created: true };
    const [existing] = await db
      .select()
      .from(openduetMissions)
      .where(
        and(
          ...openWhere(ownerUserId),
          eq(openduetMissions.companyKey, key),
          eq(openduetMissions.roleKey, roleKey),
        ),
      );
    if (!existing) throw new MissionConflictError();
    return { mission: existing, created: false };
  }

  return {
    advance,
    createPiste,

    async get(ownerUserId: string, id: string): Promise<OpenduetMission> {
      return getOwned(ownerUserId, id);
    },

    async list(ownerUserId: string, q: MissionQuery = {}): Promise<OpenduetMission[]> {
      const where: SQL[] = [eq(openduetMissions.ownerUserId, ownerUserId)];
      if (q.review?.length) where.push(inArray(openduetMissions.review, q.review));
      if (q.stage?.length) where.push(inArray(openduetMissions.stage, q.stage));
      if (q.open) where.push(notInArray(openduetMissions.stage, CLOSED), sql`${openduetMissions.review} <> 'dismissed'`);
      return db
        .select()
        .from(openduetMissions)
        .where(and(...where))
        .orderBy(desc(openduetMissions.updatedAt));
    },

    /** Thread first, then contact, then company when it names exactly one open mission. */
    async matchMail(
      ownerUserId: string,
      m: { threadId?: string; from?: string; company?: string },
    ): Promise<MailMatch> {
      const open = openWhere(ownerUserId);
      const found = (matchedBy: "thread" | "contact" | "company", rows: OpenduetMission[]): MailMatch | null =>
        rows.length === 0
          ? null
          : rows.length === 1
            ? { kind: "match", matchedBy, mission: rows[0] as OpenduetMission }
            : { kind: "ambiguous", matchedBy, missions: rows };

      if (m.threadId) {
        const rows = await db
          .select()
          .from(openduetMissions)
          .where(and(...open, sql`${m.threadId} = ANY(${openduetMissions.threadIds})`));
        const hit = found("thread", rows);
        if (hit) return hit;
      }
      const contact = m.from ? contactOf(m.from) : null;
      if (contact) {
        const rows = await db
          .select()
          .from(openduetMissions)
          .where(and(...open, sql`${contact} = ANY(${openduetMissions.contactEmails})`));
        const hit = found("contact", rows);
        if (hit) return hit;
      }
      const key = m.company ? companyKey(m.company) : "";
      if (key) {
        const rows = await db
          .select()
          .from(openduetMissions)
          .where(and(...open, eq(openduetMissions.companyKey, key)));
        const hit = found("company", rows);
        if (hit) return hit;
      }
      return { kind: "none" };
    },

    /** A mail arrived on this mission: remember when, and which thread and contact it came from. */
    async recordInbound(
      ownerUserId: string,
      id: string,
      m: { at: Date; threadId?: string; contactEmail?: string },
    ): Promise<OpenduetMission> {
      const email = m.contactEmail?.toLowerCase();
      const [row] = await db
        .update(openduetMissions)
        .set({
          lastInboundAt: sql`GREATEST(${openduetMissions.lastInboundAt}, ${m.at.toISOString()}::timestamptz)`,
          threadIds: m.threadId
            ? sql`CASE WHEN ${m.threadId} = ANY(${openduetMissions.threadIds}) THEN ${openduetMissions.threadIds} ELSE array_append(${openduetMissions.threadIds}, ${m.threadId}) END`
            : undefined,
          contactEmails: email
            ? sql`CASE WHEN ${email} = ANY(${openduetMissions.contactEmails}) THEN ${openduetMissions.contactEmails} ELSE array_append(${openduetMissions.contactEmails}, ${email}) END`
            : undefined,
          updatedAt: new Date(),
        })
        .where(and(eq(openduetMissions.id, id), eq(openduetMissions.ownerUserId, ownerUserId)))
        .returning();
      if (!row) throw new MissionNotFoundError(id);
      return row;
    },

    /** The chat said "I applied to Acme": create it active, advance the one open match, or ask which. */
    async upsertFromChat(
      ownerUserId: string,
      input: { company: string; role?: string | null; stage: Stage },
    ): Promise<ChatResult> {
      const key = companyKey(input.company);
      const where = [...openWhere(ownerUserId), eq(openduetMissions.companyKey, key)];
      if (input.role) where.push(eq(openduetMissions.roleKey, companyKey(input.role)));
      const rows = await db.select().from(openduetMissions).where(and(...where)).orderBy(asc(openduetMissions.createdAt));
      if (rows.length > 1) return { kind: "ambiguous", missions: rows };
      const only = rows[0];
      if (!only) {
        const { mission } = await createPiste(ownerUserId, {
          company: input.company,
          role: input.role,
          review: "active",
          stage: input.stage,
        });
        return { kind: "created", mission };
      }
      if (only.stage === input.stage) return { kind: "advanced", mission: only, moved: false };
      const r = await advance(ownerUserId, only.id, { to: input.stage, source: "chat", matchedBy: "chat" });
      return { kind: "advanced", mission: r.mission, moved: r.moved };
    },

    async patch(ownerUserId: string, id: string, p: MissionPatch): Promise<OpenduetMission> {
      const current = await getOwned(ownerUserId, id);
      try {
        if (p.mergeInto) {
          const target = await getOwned(ownerUserId, p.mergeInto);
          if (target.id === current.id) throw new MissionConflictError();
          return await db.transaction(async (tx) => {
            await tx
              .update(openduetMissions)
              .set({ review: "dismissed", updatedAt: new Date() })
              .where(eq(openduetMissions.id, current.id));
            await tx.update(openduetItems).set({ missionId: target.id }).where(eq(openduetItems.missionId, current.id));
            const threads = [...new Set([...target.threadIds, ...current.threadIds])];
            const contacts = [...new Set([...target.contactEmails, ...current.contactEmails])];
            const [row] = await tx
              .update(openduetMissions)
              .set({ threadIds: threads, contactEmails: contacts, updatedAt: new Date() })
              .where(eq(openduetMissions.id, target.id))
              .returning();
            return row as OpenduetMission;
          });
        }
        const company = p.company?.trim() ?? current.company;
        const role = p.role === undefined ? current.role : p.role?.trim() || null;
        const renamed = p.company !== undefined || p.role !== undefined;
        const [row] = await db
          .update(openduetMissions)
          .set({
            company,
            role,
            companyKey: companyKey(company),
            roleKey: companyKey(role ?? ""),
            title: p.title ?? (renamed ? titleOf(company, role) : current.title),
            review: p.review,
            contactEmails: p.contactEmails?.map((e) => e.toLowerCase()),
            updatedAt: new Date(),
          })
          .where(and(eq(openduetMissions.id, id), eq(openduetMissions.ownerUserId, ownerUserId)))
          .returning();
        return row as OpenduetMission;
      } catch (error) {
        if (uniqueViolation(error)) throw new MissionConflictError();
        throw error;
      }
    },

    /**
     * The relance for the current silence window, written once. Null when none is due: not silent
     * long enough, wrong stage, or two already sent in this stage.
     */
    async ensureRelance(
      ownerUserId: string,
      id: string,
      now: Date,
    ): Promise<OpenduetMissionRelance | null> {
      const mission = await getOwned(ownerUserId, id);
      const [{ sent }] = await db
        .select({ sent: sql<number>`count(*)::int` })
        .from(openduetMissionEvents)
        .where(
          and(
            eq(openduetMissionEvents.missionId, id),
            eq(openduetMissionEvents.type, "relance_sent"),
            gte(openduetMissionEvents.at, mission.stageEnteredAt),
          ),
        ) as [{ sent: number }];
      if (!relanceDue(mission, now, sent)) return null;
      const windowStart = silenceAnchor(mission);
      await db
        .insert(openduetMissionRelances)
        .values({
          id: randomUUID(),
          missionId: id,
          ownerUserId,
          windowStart,
          body: relanceBody(mission),
          status: "draft",
        })
        .onConflictDoNothing();
      const [row] = await db
        .select()
        .from(openduetMissionRelances)
        .where(and(eq(openduetMissionRelances.missionId, id), eq(openduetMissionRelances.windowStart, windowStart)));
      return row ?? null;
    },

    /** Relances of one mission, or every relance of this person with the given status, newest first. */
    async listRelances(
      ownerUserId: string,
      q: { missionId?: string; status?: RelanceStatus } = {},
    ): Promise<OpenduetMissionRelance[]> {
      const where: SQL[] = [eq(openduetMissionRelances.ownerUserId, ownerUserId)];
      if (q.missionId) where.push(eq(openduetMissionRelances.missionId, q.missionId));
      if (q.status) where.push(eq(openduetMissionRelances.status, q.status));
      return db
        .select()
        .from(openduetMissionRelances)
        .where(and(...where))
        .orderBy(desc(openduetMissionRelances.createdAt));
    },

    /** "sent" also counts as an outbound mail, which restarts the silence. */
    async setRelanceStatus(
      ownerUserId: string,
      missionId: string,
      relanceId: string,
      status: RelanceStatus,
      now: Date = new Date(),
    ): Promise<OpenduetMissionRelance> {
      const mission = await getOwned(ownerUserId, missionId);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(openduetMissionRelances)
          .set({ status })
          .where(
            and(
              eq(openduetMissionRelances.id, relanceId),
              eq(openduetMissionRelances.missionId, missionId),
              eq(openduetMissionRelances.ownerUserId, ownerUserId),
            ),
          )
          .returning();
        if (!row) throw new MissionNotFoundError(relanceId);
        if (status === "sent") {
          await tx.insert(openduetMissionEvents).values({
            id: randomUUID(),
            missionId,
            ownerUserId,
            type: "relance_sent",
            fromStage: mission.stage,
            toStage: mission.stage,
            source: "app",
            at: now,
          });
          await tx
            .update(openduetMissions)
            .set({ lastOutboundAt: now, updatedAt: new Date() })
            .where(eq(openduetMissions.id, missionId));
        }
        return row;
      });
    },

    /** Contact addresses of active, open missions, for the mail intake's `from:(a OR b …)` query. */
    async contactsForQuery(ownerUserId: string, limit = 20): Promise<string[]> {
      if (limit <= 0) return [];
      const rows = await db
        .select({ emails: openduetMissions.contactEmails })
        .from(openduetMissions)
        .where(and(...openWhere(ownerUserId), eq(openduetMissions.review, "active")))
        .orderBy(desc(openduetMissions.updatedAt));
      return [...new Set(rows.flatMap((r) => r.emails))].slice(0, limit);
    },
  };
}

export type MissionStore = ReturnType<typeof createMissionStore>;
