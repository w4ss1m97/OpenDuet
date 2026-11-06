import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../../auth/guards";
import type { CvMatch, OpenduetCvVersion } from "../../db/schema/openduet-cv";
import type { Complete } from "../triage";
import { PdfBusy, type PdfRenderer, renderCvHtml } from "./cv-render";
import { cvMasterSchema, MAX_MASTER_BYTES } from "./cv-schema";
import type { CvStore } from "./cv-store";
import { applyTailoring, buildTailorPrompt, matchSkills, parseTailoring } from "./cv-tailor";
import { askModel } from "./pipeline";
import type { OfferStore } from "./store";

export type CvRouteDeps = {
  store: CvStore;
  /** Without a usable browser it throws PdfUnavailable, which is a 503. */
  render: PdfRenderer;
  complete: Complete;
};

const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");
const logError = (type: string, error: unknown) =>
  console.error(JSON.stringify({ type, error: errorName(error), timestamp: new Date().toISOString() }));

/** ASCII, lowercase, hyphens, at most `max` characters. */
export function slug(value: string, max = 40): string {
  return (
    value
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "x"
  );
}

/** The master CV: read, replace, and its own PDF. */
export function createCvRoutes(deps: Pick<CvRouteDeps, "store" | "render">, requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    logError("openduet-cv-route-error", error);
    return context.json({ error: "Impossible de charger ton CV. Réessaie." }, 503);
  });

  routes.get("/", async (context) => {
    const master = await deps.store.getMaster(context.var.actor.id);
    return master ? context.json({ master: master.content, contentHash: master.contentHash, updatedAt: master.updatedAt }) : context.json({ error: "Pas encore de CV maître." }, 404);
  });

  routes.put("/", async (context) => {
    const declared = Number(context.req.header("content-length") ?? 0);
    if (declared > MAX_MASTER_BYTES) return context.json({ error: "CV trop volumineux (64 Ko max)." }, 413);
    const text = await context.req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_MASTER_BYTES) return context.json({ error: "CV trop volumineux (64 Ko max)." }, 413);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return context.json({ error: "JSON invalide." }, 400);
    }
    const parsed = cvMasterSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") || "(racine)";
      return context.json({ error: `CV invalide : ${path} (${issue?.message ?? "invalide"}).`, path }, 400);
    }
    const saved = await deps.store.putMaster(context.var.actor.id, parsed.data);
    return context.json({ contentHash: saved.contentHash, updatedAt: saved.updatedAt });
  });

  routes.get("/pdf", async (context) => {
    const master = await deps.store.getMaster(context.var.actor.id);
    if (!master) return context.json({ error: "Pas encore de CV maître." }, 404);
    return pdfResponse(context, deps.render, master.content, [], `CV-${slug(master.content.header.name)}.pdf`);
  });

  return routes;
}

type Ctx = { json: (body: unknown, status?: 503) => Response; body: (data: Uint8Array<ArrayBuffer>, status: 200, headers: Record<string, string>) => Response };

async function pdfResponse(
  context: Ctx,
  render: PdfRenderer,
  cv: Parameters<typeof renderCvHtml>[0],
  highlight: string[],
  filename: string,
): Promise<Response> {
  try {
    const pdf = await render(renderCvHtml(cv, { highlight }));
    const bytes = new Uint8Array(new ArrayBuffer(pdf.byteLength));
    bytes.set(pdf);
    return context.body(bytes, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename.slice(0, 100)}"`,
      "Cache-Control": "no-store",
    });
  } catch (error) {
    if (error instanceof PdfBusy) return context.json({ error: "Trop de PDF en cours. Réessaie dans un instant.", code: "pdf_busy" }, 503);
    logError("openduet-cv-pdf-error", error);
    return context.json({ error: "Impossible de fabriquer le PDF ici.", code: "pdf_unavailable" }, 503);
  }
}

const highlightOf = (version: OpenduetCvVersion): string[] => {
  const value = (version.content as { highlight?: unknown } | null)?.highlight;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
};

/** The tailored CV of an offer, on `/:id/cv`. Registered by createOfferRoutes before its `/:id` routes. */
export function registerOfferCvRoutes(
  routes: Hono<{ Variables: AppVariables }>,
  cv: CvRouteDeps,
  offers: Pick<OfferStore, "get">,
) {
  const offerNotFound = (context: { json: (body: unknown, status: 404) => Response }) =>
    context.json({ error: "Cette offre n'existe plus." }, 404);

  /** `stale`: the master changed since this version was built. */
  async function view(owner: string, version: OpenduetCvVersion | null) {
    const master = version?.status === "ready" ? await cv.store.getMaster(owner) : null;
    return {
      version,
      match: version?.match ?? null,
      stale: Boolean(version?.status === "ready" && master && master.contentHash !== version.masterHash),
    };
  }

  routes.post("/:id/cv", async (context) => {
    const owner = context.var.actor.id;
    const offer = await offers.get(owner, context.req.param("id"));
    if (!offer) return offerNotFound(context);
    const regenerate = context.req.query("regenerate") === "1";

    const existing = await cv.store.ensureVersion(owner, offer.id);
    if (!existing) return offerNotFound(context);
    if (existing.status === "ready" && !regenerate) return context.json(await view(owner, existing));
    const master = await cv.store.getMaster(owner);
    if (!master) return context.json({ error: "Ajoute d'abord ton CV maître.", code: "no_master" }, 409);

    const claim = await cv.store.claimVersion(owner, offer.id, { regenerate });
    if (!claim?.claimedAt) {
      const now = await cv.store.getVersion(owner, offer.id);
      if (now?.status === "ready" && !regenerate) return context.json(await view(owner, now));
      return context.json({ error: "Ce CV est déjà en cours de préparation.", code: "cv_in_progress" }, 409);
    }
    try {
      const answer = parseTailoring(
        await askModel(cv.complete, buildTailorPrompt(master.content, { title: offer.title, company: offer.company, skills: offer.skills, description: offer.description ?? "" }), 60_000),
      );
      const tailored = applyTailoring(master.content, answer);
      const match = matchSkills(master.content, offer.skills) satisfies CvMatch;
      const held = await cv.store.completeVersion(owner, offer.id, claim.claimedAt, tailored, match, master.contentHash);
      if (!held) return context.json({ error: "Ce CV est déjà en cours de préparation.", code: "cv_in_progress" }, 409);
    } catch (error) {
      logError("openduet-cv-generate-error", error);
      await cv.store.failVersion(owner, offer.id, claim.claimedAt, errorName(error));
      return context.json({ error: "Impossible d'adapter ton CV à cette offre. Réessaie.", code: "cv_failed" }, 503);
    }
    return context.json(await view(owner, await cv.store.getVersion(owner, offer.id)));
  });

  routes.get("/:id/cv", async (context) => {
    const owner = context.var.actor.id;
    const offer = await offers.get(owner, context.req.param("id"));
    if (!offer) return offerNotFound(context);
    return context.json(await view(owner, await cv.store.getVersion(owner, offer.id)));
  });

  routes.get("/:id/cv/pdf", async (context) => {
    const owner = context.var.actor.id;
    const offer = await offers.get(owner, context.req.param("id"));
    if (!offer) return offerNotFound(context);
    const version = await cv.store.getVersion(owner, offer.id);
    if (version?.status !== "ready" || !version.content)
      return context.json({ error: "Ce CV n'est pas prêt.", code: "cv_not_ready" }, 404);
    const name = `CV-${slug(version.content.header.name)}-${slug(offer.company ?? offer.platform)}.pdf`;
    return pdfResponse(context, cv.render, version.content, highlightOf(version), name);
  });
}
