import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../../auth/guards";
import type { CareerStore } from "./store";
import { defaultWeek, parseWeekParam } from "./week";
import { summarizeWeek } from "./weekly";

export type CareerRouteDeps = {
  store: Pick<CareerStore, "readWeek">;
  now?: () => Date;
};

const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");

/** The weekly career check. The owner is the signed-in user, so another owner's rows are never read. */
export function createCareerRoutes(deps: CareerRouteDeps, requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "openduet-career-route-error",
        error: errorName(error),
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Impossible de charger ton bilan. Réessaie." }, 503);
  });

  routes.get("/weekly", async (context) => {
    const now = deps.now?.() ?? new Date();
    const param = context.req.query("week");
    const week = param === undefined ? defaultWeek(now) : parseWeekParam(param);
    if (!week) return context.json({ error: "Semaine invalide : attendu AAAA-MM-JJ." }, 400);
    if (week.start > now) return context.json({ error: "Cette semaine n'a pas encore commencé." }, 400);
    const raw = await deps.store.readWeek(context.var.actor.id, week, now);
    return context.json(summarizeWeek(raw, week, now));
  });

  return routes;
}
