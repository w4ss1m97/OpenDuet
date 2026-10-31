import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import { REVIEWS, STAGES } from "./stages";
import {
  IllegalTransitionError,
  MissionConflictError,
  MissionNotFoundError,
  type MissionPatch,
  type MissionStore,
} from "./store";

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined))
    .pipe(z.array(z.enum(values)).optional());

const listQuery = z.object({
  stage: csv(STAGES),
  review: csv(REVIEWS),
  open: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
});
const patchBody = z
  .object({
    stage: z.enum(STAGES).optional(),
    review: z.enum(REVIEWS).optional(),
    company: z.string().trim().min(1).optional(),
    role: z.string().trim().nullable().optional(),
    contactEmail: z.string().trim().email().optional(),
    mergeInto: z.string().min(1).optional(),
  })
  .strict();
const relanceBody = z.object({ status: z.enum(["sent", "dismissed"]) }).strict();

/** The Duet app's missions: the pipeline, its relance drafts and the pistes to confirm. Only ever the caller's own. */
export function createMissionRoutes(
  store: MissionStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof MissionNotFoundError)
      return context.json({ error: "Cette mission n'existe plus." }, 404);
    if (error instanceof IllegalTransitionError)
      return context.json({ error: "Cette étape n'est pas possible depuis l'étape actuelle." }, 409);
    if (error instanceof MissionConflictError)
      return context.json({ error: "Une autre mission ouverte a déjà cette entreprise et ce poste." }, 409);
    console.error(
      JSON.stringify({
        type: "openduet-missions-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Impossible de charger tes missions. Réessaie." }, 503);
  });

  routes.get("/", async (context) => {
    const query = listQuery.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Filtre invalide." }, 400);
    return context.json({ missions: await store.list(context.var.actor.id, query.data) });
  });

  routes.get("/:id", async (context) => {
    const owner = context.var.actor.id;
    const mission = await store.get(owner, context.req.param("id"));
    const relances = await store.listRelances(owner, { missionId: mission.id });
    return context.json({ mission, relances });
  });

  routes.patch("/:id", async (context) => {
    const body = patchBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "Modification invalide." }, 400);
    const owner = context.var.actor.id;
    const id = context.req.param("id");
    const { stage, contactEmail, ...fields } = body.data;
    if (fields.mergeInto && (stage || contactEmail || Object.keys(fields).length > 1))
      return context.json({ error: "Une fusion se demande seule." }, 400);

    const current = await store.get(owner, id);
    // The stage first: an illegal move changes nothing else.
    if (stage) await store.advance(owner, id, { to: stage, source: "app", matchedBy: "app" });
    const patch: MissionPatch = { ...fields };
    if (contactEmail) patch.contactEmails = [...new Set([...current.contactEmails, contactEmail.toLowerCase()])];
    const changes = Object.values(patch).some((value) => value !== undefined);
    const mission = changes ? await store.patch(owner, id, patch) : await store.get(owner, id);
    return context.json({ mission });
  });

  routes.patch("/:id/relances/:rid", async (context) => {
    const body = relanceBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "Statut invalide." }, 400);
    const relance = await store.setRelanceStatus(
      context.var.actor.id,
      context.req.param("id"),
      context.req.param("rid"),
      body.data.status,
    );
    return context.json({ relance });
  });

  return routes;
}
