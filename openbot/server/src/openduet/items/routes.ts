import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import { ItemNotFoundError, type ItemStore } from "./store";
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
const snoozeBody = z.object({ minutes: z.number().int().min(1).max(1440) });

/** The Duet app's items: what to remind, and what to sort. Only ever the caller's own. */
export function createItemRoutes(
  store: ItemStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    if (error instanceof ItemNotFoundError)
      return context.json({ error: "Cet élément n'existe plus." }, 404);
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

  return routes;
}
