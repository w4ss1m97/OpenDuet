import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import type { AnarlogSource } from "../missions/anarlog";
import { DEBRIEF_MAX_AGE_MS, interviewEnd } from "../missions/debrief";
import type { DebriefStore } from "../missions/debrief-store";
import type { PrepStore } from "../missions/prep-store";
import { MissionNotFoundError, type MissionStore } from "../missions/store";
import { findInterviewRecording } from "./intake";
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
  prep?: {
    missions: Pick<MissionStore, "get">;
    preps: PrepStore;
    /** Interview debriefs. `source` is null when Anarlog is not set up: reading works, finding a recording does not. */
    debrief?: { store: DebriefStore; source: AnarlogSource | null };
  },
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

  if (prep?.debrief) {
    const { missions } = prep;
    const debrief = prep.debrief;
    const debriefs = debrief.store;
    const shown = (row: NonNullable<Awaited<ReturnType<DebriefStore["getByItem"]>>>) => ({
      itemId: row.itemId,
      missionId: row.missionId,
      status: row.status,
      content: row.content,
      generatedAt: row.generatedAt,
    });

    routes.get("/:id/debrief", async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      await store.get(owner, id);
      const row = await debriefs.getByItem(owner, id);
      if (!row) return context.json({ error: "Pas encore de débrief pour cet entretien." }, 404);
      return context.json({ debrief: shown(row) });
    });

    routes.post("/:id/debrief/regenerate", async (context) => {
      const owner = context.var.actor.id;
      const id = context.req.param("id");
      const item = await store.get(owner, id);
      const existing = await debriefs.regenerate(owner, id);
      if (existing) return context.json({ debrief: shown(existing) }, 202);
      const source = debrief.source;
      if (!source) return context.json({ error: "anarlog_off" }, 503);
      const end = interviewEnd(item);
      const noRecording = () => context.json({ error: "no_recording" }, 404);
      if (item.kind !== "interview" || !item.missionId || !item.dueAt || !end || end.getTime() > Date.now()) return noRecording();
      const mission = await missions.get(owner, item.missionId);
      const since = new Date(Math.max(item.dueAt.getTime(), Date.now() - DEBRIEF_MAX_AGE_MS) - 15 * 60_000);
      const meeting = await findInterviewRecording(
        source,
        item,
        mission,
        await source.listMeetings(since),
        await debriefs.listUsedMeetingIds(owner),
      );
      if (!meeting) return noRecording();
      if (!meeting.transcriptReady) return context.json({ error: "transcript_not_ready" }, 409);
      const row = await debriefs.ensurePending(owner, id, mission.id, meeting.id);
      if (!row) return noRecording();
      return context.json({ debrief: shown(row) }, 202);
    });
  }

  return routes;
}
