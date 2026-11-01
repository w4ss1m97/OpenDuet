import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import type { PrepStore } from "../missions/prep-store";
import { MissionNotFoundError, type MissionStore } from "../missions/store";
import { ItemKindError, ItemNotFoundError, type ItemStore } from "./store";
import { ITEM_STATUSES } from "./types";

const listQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined))
    .pipe(z.array(z.enum(ITEM_STATUSES)).optional()),
  remindFrom: z.coerce.date().optional(),
  remindTo: z.coerce.date().optional(),
});
const statusBody = z.object({ status: z.enum(["active", "done", "dismissed"]) });
const missionBody = z.object({ missionId: z.string().min(1).nullable() }).strict();
const snoozeBody = z.object({ minutes: z.number().int().min(1).max(1440) });

/** The Duet app's items: what to remind, and what to sort. Only ever the caller's own. */
export function createItemRoutes(
  store: ItemStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Interview prep. Absent, the mission link and the sheet routes are not served. */
  prep?: { missions: Pick<MissionStore, "get">; preps: PrepStore },
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof ItemNotFoundError)
      return context.json({ error: "Cet élément n'existe plus." }, 404);
    if (error instanceof MissionNotFoundError)
      return context.json({ error: "Cette mission n'existe plus." }, 404);
    if (error instanceof ItemKindError)
      return context.json({ error: "Seul un entretien ou une relance se lie à une mission." }, 422);
    console.error(
      JSON.stringify({
        type: "openduet-items-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Impossible de charger tes éléments. Réessaie." }, 503);
  });

  routes.get("/", async (context) => {
    const query = listQuery.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Filtre invalide." }, 400);
    return context.json({ items: await store.list(context.var.actor.id, query.data) });
  });

  routes.post("/:id/status", async (context) => {
    const body = statusBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "Statut invalide." }, 400);
    const item = await store.setStatus(context.var.actor.id, context.req.param("id"), body.data.status);
    return context.json({ item });
  });

  routes.post("/:id/snooze", async (context) => {
    const body = snoozeBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "Durée invalide (1 à 1440 minutes)." }, 400);
    const until = new Date(Date.now() + body.data.minutes * 60_000);
    const item = await store.snooze(context.var.actor.id, context.req.param("id"), until);
    return context.json({ item });
  });

  if (prep) {
    const { missions, preps } = prep;
    const shown = (row: NonNullable<Awaited<ReturnType<PrepStore["getByItem"]>>>) => ({
      itemId: row.itemId,
      missionId: row.missionId,
      status: row.status,
      content: row.content,
      generatedAt: row.generatedAt,
    });

    routes.get("/:id/prep", async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      await store.get(owner, id);
      const row = await preps.getByItem(owner, id);
      if (!row) return context.json({ error: "Pas encore de fiche pour cet entretien." }, 404);
      return context.json({ prep: shown(row) });
    });

    routes.post("/:id/mission", async (context) => {
      const body = missionBody.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return context.json({ error: "Mission invalide." }, 400);
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      const { missionId } = body.data;
      if (missionId) await missions.get(owner, missionId);
      const item = await store.setMission(owner, id, missionId);
      if (missionId) await preps.ensurePending(owner, id, missionId);
      return context.json({ item });
    });

    routes.post("/:id/prep/regenerate", async (context) => {
      const row = await preps.regenerate(context.var.actor.id, context.req.param("id"));
      if (!row) return context.json({ error: "Pas de fiche à refaire pour cet entretien." }, 404);
      return context.json({ prep: shown(row) });
    });
  }

  return routes;
}
