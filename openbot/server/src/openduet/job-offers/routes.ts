import { createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import type { OfferPlatform, OpenduetOffer } from "../../db/schema/openduet-job-offers";
import type { Complete } from "../triage";
import type { MissionStore } from "../missions/store";
import { htmlToText } from "./extract";
import { askModel, extractAndStore, OFFER_CALL_TIMEOUT_MS, scoreOffer } from "./pipeline";
import type { ProfileSource } from "./profile";
import type { OfferStore } from "./store";

const STATUSES = ["new", "scored", "shown", "filtered", "dismissed", "applied"] as const;
const DEFAULT_STATUSES = ["new", "scored", "shown"] as const;
const MAX_PASTE_OFFERS = 3;
const PASTE_OVERALL_MS = 120_000;

const PLATFORM_LABEL: Record<OfferPlatform, string> = {
  malt: "Malt",
  "free-work": "Free-Work",
  collective: "Collective",
  paste: "Offre collée",
};

const listQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : [...DEFAULT_STATUSES]))
    .pipe(z.array(z.enum(STATUSES)).min(1)),
  limit: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .transform((value) => (value === undefined ? 50 : Number(value)))
    .pipe(z.number().int().min(1).max(100)),
});
const pasteBody = z
  .object({
    text: z.string().trim().min(50).max(20_000),
    url: z.string().trim().url().max(500).startsWith("https://").optional(),
  })
  .strict();

export type OfferRouteDeps = {
  store: OfferStore;
  missions: Pick<MissionStore, "createPiste" | "get">;
  profile: ProfileSource;
  complete: Complete;
  /** Overall bound of a paste (120 s). One model call is bounded at 60 s. */
  overallMs?: number;
};

const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");

/** The Duet app's job offers: list, dismiss, apply and paste. Only ever the caller's own. */
export function createOfferRoutes(deps: OfferRouteDeps, requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
  const { store, missions } = deps;
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "openduet-offers-route-error",
        error: errorName(error),
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Impossible de charger tes offres. Réessaie." }, 503);
  });
  const notFound = (context: { json: (body: unknown, status: 404) => Response }) =>
    context.json({ error: "Cette offre n'existe plus." }, 404);

  routes.get("/", async (context) => {
    const query = listQuery.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Filtre invalide." }, 400);
    return context.json({
      offers: await store.list(context.var.actor.id, { statuses: query.data.status, limit: query.data.limit }),
    });
  });

  // Declared before `/:id`, which would take "paste" for an id.
  routes.post("/paste", async (context) => {
    const owner = context.var.actor.id;
    const body = pasteBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "Colle un texte de 50 à 20 000 caractères (lien https en option)." }, 400);
    const { text, url } = body.data;
    const now = new Date();
    const source = await store.ensureSource(
      owner,
      `paste:${createHash("sha256").update(text).digest("hex")}`,
      "paste",
      now,
      text,
    );
    if (source.status === "done") return context.json({ offers: await store.listBySource(owner, source.id) });
    const claim = await store.claimSource(owner, source.id, now);
    if (!claim?.claimedAt) return context.json({ error: "Ce texte est déjà en cours de lecture." }, 409);

    const deadline = Date.now() + (deps.overallMs ?? PASTE_OVERALL_MS);
    const ask = (prompt: string) => {
      const left = deadline - Date.now();
      if (left <= 0) return Promise.reject(new Error("PasteTimeout"));
      return askModel(deps.complete, prompt, Math.min(OFFER_CALL_TIMEOUT_MS, left));
    };
    const logError = (error: unknown) =>
      console.error(
        JSON.stringify({ type: "openduet-offers-error", error: errorName(error), timestamp: new Date().toISOString() }),
      );
    try {
      if (!htmlToText(text)) throw new Error("EmptyPaste");
      const { found, stored } = await extractAndStore(
        store,
        owner,
        claim.id,
        "paste",
        { subject: "", body: text, max: MAX_PASTE_OFFERS, url: url ?? null },
        ask,
      );
      const ids = [...new Set(stored.map((s) => s.id))];
      const profile = await deps.profile.text(owner);
      if (profile) for (const id of ids) await scoreOffer(store, owner, id, profile, ask, logError);
      await store.completeSource(owner, claim.id, claim.claimedAt, found);
      const offers = (await Promise.all(ids.map((id) => store.get(owner, id)))).filter(
        (offer): offer is OpenduetOffer => offer !== null,
      );
      return context.json({ offers });
    } catch (error) {
      logError(error);
      await store.failSource(owner, claim.id, claim.claimedAt, errorName(error));
      return context.json({ error: "Impossible de lire cette offre. Réessaie." }, 503);
    }
  });

  routes.get("/:id", async (context) => {
    const offer = await store.get(context.var.actor.id, context.req.param("id"));
    return offer ? context.json({ offer }) : notFound(context);
  });

  routes.post("/:id/dismiss", async (context) => {
    const outcome = await store.dismiss(context.var.actor.id, context.req.param("id"));
    if (outcome.result === "not_found") return notFound(context);
    if (outcome.result === "conflict")
      return context.json({ error: "Tu as déjà postulé à cette offre." }, 409);
    return context.json({ offer: outcome.offer });
  });

  routes.post("/:id/apply", async (context) => {
    const owner = context.var.actor.id;
    const offer = await store.get(owner, context.req.param("id"));
    if (!offer) return notFound(context);
    const linked = async (missionId: string | null) =>
      missionId ? await missions.get(owner, missionId).catch(() => null) : null;
    if (offer.status === "applied") return context.json({ offer, mission: await linked(offer.missionId) });
    const { mission } = await missions.createPiste(owner, {
      company: offer.company ?? PLATFORM_LABEL[offer.platform],
      role: offer.title,
      review: "active",
      stage: "piste",
      at: new Date(),
    });
    const applied = await store.setApplied(owner, offer.id, mission.id);
    if (!applied) return notFound(context);
    // Applied by a concurrent call first: answer with the mission that call linked.
    return context.json({ offer: applied, mission: applied.missionId === mission.id ? mission : await linked(applied.missionId) });
  });

  return routes;
}
