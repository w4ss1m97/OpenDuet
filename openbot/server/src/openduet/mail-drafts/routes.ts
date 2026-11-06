import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { PERSON_INITIATOR } from "../../audit";
import type { AppVariables } from "../../auth/guards";
import type { OpenduetMailDraft } from "../../db/schema/openduet-mail-drafts";
import type { CallTool } from "../brief";
import { PdfBusy, type PdfRenderer, renderCvHtml } from "../job-offers/cv-render";
import { slug } from "../job-offers/cv-routes";
import type { CvStore } from "../job-offers/cv-store";
import { askModel } from "../job-offers/pipeline";
import type { ProfileSource } from "../job-offers/profile";
import type { OfferStore } from "../job-offers/store";
import { MissionNotFoundError, type MissionStore } from "../missions/store";
import type { Complete } from "../triage";
import { buildCoverPrompt, parseCover } from "./cover";
import type { MailDraftStore } from "./store";

export type MailDraftRouteDeps = {
  store: MailDraftStore;
  missions: Pick<MissionStore, "get" | "listRelances">;
  offers: Pick<OfferStore, "get">;
  cv: Pick<CvStore, "getVersion">;
  profile: ProfileSource;
  /** Renders the tailored CV once, when an application draft is made. Absent: applications are 503. */
  render?: PdfRenderer;
  /** Writes the cover message. Absent: applications are 503. */
  complete?: Complete;
  /** The plugin store's callTool. Absent, or without a Bot for the owner: a push is 503. */
  callTool?: CallTool;
  botFor?: (ownerUserId: string) => Promise<string | null>;
};

const GMAIL_CREATE_DRAFT = "google-workspace/gmail_create_draft";
const HEADER_BREAK = /[\r\n\0\u0085\u2028\u2029]/;

const address = z
  .string()
  .trim()
  .max(320)
  .refine((value) => value.includes("@") && !HEADER_BREAK.test(value));
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !HEADER_BREAK.test(value));
const patchBody = z
  .object({
    to: z.array(address).max(10).optional(),
    cc: z.array(address).max(10).optional(),
    subject: line(200).optional(),
    body: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict();
const createBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("relance"), missionId: z.string().min(1), relanceId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("application"), offerId: z.string().min(1) }).strict(),
]);
const statusQuery = z.enum(["draft", "pushed", "dismissed"]).optional();

const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");
const logError = (type: string, error: unknown) =>
  console.error(JSON.stringify({ type, error: errorName(error), timestamp: new Date().toISOString() }));

/** A draft as the app sees it: no PDF bytes, no claim. */
function view(row: OpenduetMailDraft) {
  return {
    id: row.id,
    kind: row.kind,
    missionId: row.missionId,
    relanceId: row.relanceId,
    offerId: row.offerId,
    to: row.toAddrs,
    cc: row.ccAddrs,
    subject: row.subject,
    body: row.body,
    threadId: row.threadId,
    hasAttachment: row.attachmentPdf !== null,
    attachmentName: row.attachmentName,
    status: row.status,
    gmailDraftId: row.gmailDraftId,
    lastError: row.lastError,
    pushedAt: row.pushedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Mail drafts. Duet prepares them and the owner pushes one, which creates a Gmail DRAFT through the
 * normal approval gate. Nothing here sends mail.
 */
export function createMailDraftRoutes(deps: MailDraftRouteDeps, requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    logError("openduet-mail-drafts-route-error", error);
    return context.json({ error: "Impossible de traiter ce brouillon. Réessaie." }, 503);
  });
  const notFound = { error: "Ce brouillon n'existe plus." };

  routes.get("/", async (context) => {
    const status = statusQuery.safeParse(context.req.query("status") || undefined);
    if (!status.success) return context.json({ error: "Statut inconnu." }, 400);
    const rows = await deps.store.listDrafts(context.var.actor.id, status.data);
    return context.json({ drafts: rows.map(view) });
  });

  routes.post("/", async (context) => {
    const owner = context.var.actor.id;
    const raw = await context.req.json().catch(() => undefined);
    const parsed = createBody.safeParse(raw);
    if (!parsed.success) return context.json({ error: "Demande invalide." }, 400);
    const input = parsed.data;

    if (input.kind === "relance") {
      let mission: Awaited<ReturnType<MailDraftRouteDeps["missions"]["get"]>>;
      try {
        mission = await deps.missions.get(owner, input.missionId);
      } catch (error) {
        if (error instanceof MissionNotFoundError) return context.json({ error: "Cette mission n'existe plus." }, 404);
        throw error;
      }
      const relance = (await deps.missions.listRelances(owner, { missionId: mission.id })).find((r) => r.id === input.relanceId);
      if (!relance) return context.json({ error: "Cette relance n'existe plus." }, 404);
      if (relance.status !== "draft") return context.json({ error: "Cette relance n'est plus à envoyer.", code: "relance_not_draft" }, 409);
      const { draft, created } = await deps.store.createDraft(owner, {
        kind: "relance",
        missionId: mission.id,
        relanceId: relance.id,
        to: mission.contactEmails.slice(0, 3),
        cc: [],
        subject: `Relance — ${mission.role ?? mission.title} chez ${mission.company}`,
        body: relance.body,
        // Threads are appended as they appear, so the last is the latest.
        threadId: mission.threadIds.at(-1) ?? null,
      });
      return context.json(view(draft), created ? 201 : 200);
    }

    const offer = await deps.offers.get(owner, input.offerId);
    if (!offer) return context.json({ error: "Cette offre n'existe plus." }, 404);
    const live = (await deps.store.listDrafts(owner, "draft")).find((row) => row.kind === "application" && row.offerId === offer.id);
    if (live) return context.json(view(live), 200);

    const version = await deps.cv.getVersion(owner, offer.id);
    if (version?.status !== "ready" || !version.content) {
      return context.json({ error: "Prépare d'abord le CV adapté à cette offre.", code: "cv_not_ready" }, 409);
    }
    if (!deps.render || !deps.complete) return context.json({ error: "L'écriture de candidatures n'est pas disponible ici.", code: "unavailable" }, 503);

    let cover: ReturnType<typeof parseCover>;
    try {
      const offerText = [offer.description ?? "", offer.url ?? ""].join("\n");
      cover = parseCover(
        await askModel(deps.complete, buildCoverPrompt({ ...offer, description: offer.description ?? "" }, (await deps.profile.text(owner)) ?? "")),
        offerText,
      );
    } catch (error) {
      logError("openduet-mail-drafts-cover-error", error);
      return context.json({ error: "Impossible d'écrire le mail de candidature. Réessaie.", code: "cover_failed" }, 503);
    }

    let pdf: Uint8Array;
    try {
      const highlight = (version.content as { highlight?: unknown }).highlight;
      pdf = await deps.render(renderCvHtml(version.content, { highlight: Array.isArray(highlight) ? highlight.filter((v): v is string => typeof v === "string") : [] }));
    } catch (error) {
      if (error instanceof PdfBusy) return context.json({ error: "Trop de PDF en cours. Réessaie dans un instant.", code: "pdf_busy" }, 503);
      logError("openduet-mail-drafts-pdf-error", error);
      return context.json({ error: "Impossible de fabriquer le PDF ici.", code: "pdf_unavailable" }, 503);
    }

    const { draft, created } = await deps.store.createDraft(owner, {
      kind: "application",
      offerId: offer.id,
      // The offers carry no contact address: the owner fills it in before pushing.
      to: [],
      cc: [],
      subject: cover.subject,
      body: cover.body,
      attachmentPdf: Buffer.from(pdf),
      attachmentName: `CV-${slug(version.content.header.name)}-${slug(offer.company ?? offer.platform)}.pdf`.slice(0, 100),
    });
    return context.json(view(draft), created ? 201 : 200);
  });

  routes.get("/:id", async (context) => {
    const row = await deps.store.getDraft(context.var.actor.id, context.req.param("id"));
    return row ? context.json(view(row)) : context.json(notFound, 404);
  });

  routes.get("/:id/attachment", async (context) => {
    const row = await deps.store.getDraft(context.var.actor.id, context.req.param("id"));
    if (!row) return context.json(notFound, 404);
    if (!row.attachmentPdf) return context.json({ error: "Ce brouillon n'a pas de pièce jointe." }, 404);
    const bytes = new Uint8Array(new ArrayBuffer(row.attachmentPdf.byteLength));
    bytes.set(row.attachmentPdf);
    return context.body(bytes, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${(row.attachmentName ?? "CV.pdf").slice(0, 100)}"`,
      "Cache-Control": "no-store",
    });
  });

  routes.patch("/:id", async (context) => {
    const raw = await context.req.json().catch(() => undefined);
    const parsed = patchBody.safeParse(raw);
    if (!parsed.success) return context.json({ error: "Modification invalide.", path: parsed.error.issues[0]?.path.join(".") }, 400);
    const result = await deps.store.patchDraft(context.var.actor.id, context.req.param("id"), parsed.data);
    if (result.ok) return context.json(view(result.draft));
    return result.reason === "not_found"
      ? context.json(notFound, 404)
      : context.json({ error: "Ce brouillon n'est plus modifiable.", code: "not_editable" }, 409);
  });

  routes.post("/:id/dismiss", async (context) => {
    const owner = context.var.actor.id;
    const id = context.req.param("id");
    const row = await deps.store.dismissDraft(owner, id);
    if (row) return context.json(view(row));
    return (await deps.store.getDraft(owner, id))
      ? context.json({ error: "Ce brouillon n'est plus un brouillon.", code: "not_a_draft" }, 409)
      : context.json(notFound, 404);
  });

  routes.post("/:id/push", async (context) => {
    const owner = context.var.actor.id;
    const id = context.req.param("id");
    const row = await deps.store.getDraft(owner, id);
    if (!row) return context.json(notFound, 404);
    if (row.status === "pushed") return context.json({ error: "Ce brouillon est déjà dans Gmail.", code: "already_pushed" }, 409);
    if (row.status !== "draft") return context.json({ error: "Ce brouillon est écarté.", code: "not_a_draft" }, 409);
    if (!deps.callTool || !deps.botFor) return context.json({ error: "Gmail n'est pas branché ici.", code: "unavailable" }, 503);
    const botId = await deps.botFor(owner);
    if (!botId) return context.json({ error: "Aucun assistant n'est configuré pour Gmail.", code: "no_bot" }, 503);

    const claim = await deps.store.claimPush(owner, id);
    if (!claim?.claimedAt) {
      const now = await deps.store.getDraft(owner, id);
      return now?.status === "pushed"
        ? context.json({ error: "Ce brouillon est déjà dans Gmail.", code: "already_pushed" }, 409)
        : context.json({ error: "Ce brouillon est déjà en cours d'envoi vers Gmail.", code: "push_in_progress" }, 409);
    }
    const claimedAt = claim.claimedAt;
    // Built only from the stored row, so a retry after an approval carries byte-identical arguments.
    const args: Record<string, unknown> = {
      to: claim.toAddrs,
      cc: claim.ccAddrs,
      subject: claim.subject,
      body: claim.body,
      ...(claim.threadId ? { threadId: claim.threadId } : {}),
      ...(claim.attachmentPdf
        ? {
            attachment: {
              filename: claim.attachmentName ?? "CV.pdf",
              mimeType: "application/pdf",
              contentBase64: Buffer.from(claim.attachmentPdf).toString("base64"),
            },
          }
        : {}),
    };

    const fail = async (message: string) => {
      await deps.store.releasePush(owner, id, claimedAt, message.slice(0, 300));
      return context.json({ error: "Gmail n'a pas créé le brouillon.", code: "push_failed", detail: message.slice(0, 300) }, 502);
    };
    try {
      // The owner pushed, so the call is theirs: never the proactive initiator.
      const result = await deps.callTool({ ref: GMAIL_CREATE_DRAFT, args, botId, actorId: owner, initiator: PERSON_INITIATOR });
      if (result.isError) return await fail(result.text);
      let gmailId = "";
      try {
        gmailId = String((JSON.parse(result.text) as { id?: unknown }).id ?? "");
      } catch {
        // Handled below.
      }
      if (!gmailId) return await fail("Gmail answered without a draft id.");
      if (!(await deps.store.completePush(owner, id, claimedAt, gmailId))) {
        return context.json({ error: "Ce brouillon est déjà en cours d'envoi vers Gmail.", code: "push_in_progress" }, 409);
      }
      return context.json(view((await deps.store.getDraft(owner, id)) ?? claim));
    } catch (error) {
      if (error instanceof HeadlessToolSuspension) {
        await deps.store.releasePush(owner, id, claimedAt, null);
        const approvalId = error.waiting.approvalId ?? error.waiting.requestId ?? null;
        return context.json({ status: "approval_pending", approvalId }, 202);
      }
      logError("openduet-mail-drafts-push-error", error);
      return await fail(error instanceof Error ? error.message : "Unknown error");
    }
  });

  return routes;
}
