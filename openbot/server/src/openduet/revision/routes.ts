import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../../auth/guards";
import type { OpenduetOffer } from "../../db/schema/openduet-job-offers";
import type { ItemStore } from "../items/store";
import type { CvStore } from "../job-offers/cv-store";
import { parseMaster } from "../job-offers/cv-schema";
import type { OfferStore } from "../job-offers/store";
import { askModel, OFFER_CALL_TIMEOUT_MS } from "../job-offers/pipeline";
import type { Complete } from "../triage";
import { RevisionAnswerError } from "./cards";
import { referenceOf } from "./deep-cards";
import type { RevisionGenerator } from "./generate";
import { buildGradingPrompt, gradeOf, isAtRisk, parseGrading, pickQuestions } from "./mock";
import type { RevisionStore } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
export const FOCUS_WINDOW_MS = 3 * DAY_MS;

export type RevisionRouteDeps = {
  store: Pick<RevisionStore, "listToday" | "list" | "review" | "archive" | "get">;
  generator: Pick<RevisionGenerator, "start" | "startDeep" | "status">;
  /** Grades a mock-interview answer (one short call). */
  complete: Complete;
  cv: Pick<CvStore, "getMaster">;
  items: Pick<ItemStore, "listUpcomingInterviews">;
  offers: Pick<OfferStore, "listByMissionIds">;
  now?: () => Date;
  timeoutMs?: number;
};

export type RevisionFocus = { offerId: string; company: string | null; interviewAt: string };

/** Offers tied to an active interview due in [now, now + 3 days], soonest interview first. */
export async function focusOffers(
  deps: Pick<RevisionRouteDeps, "items" | "offers">,
  owner: string,
  now: Date,
): Promise<{ offer: OpenduetOffer; interviewAt: Date }[]> {
  const interviews = await deps.items.listUpcomingInterviews(owner, now, new Date(now.getTime() + FOCUS_WINDOW_MS));
  const dueByMission = new Map<string, Date>();
  for (const item of interviews) {
    if (item.missionId && item.dueAt && !dueByMission.has(item.missionId)) dueByMission.set(item.missionId, item.dueAt);
  }
  if (dueByMission.size === 0) return [];
  const offers = await deps.offers.listByMissionIds(owner, [...dueByMission.keys()]);
  return offers
    .map((offer) => ({ offer, interviewAt: dueByMission.get(offer.missionId as string) as Date }))
    .sort((a, b) => a.interviewAt.getTime() - b.interviewAt.getTime());
}

export async function loadFocus(
  deps: Pick<RevisionRouteDeps, "items" | "offers">,
  owner: string,
  now: Date,
): Promise<RevisionFocus[]> {
  return (await focusOffers(deps, owner, now)).map(({ offer, interviewAt }) => ({
    offerId: offer.id,
    company: offer.company,
    interviewAt: interviewAt.toISOString(),
  }));
}

const limitParam = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .optional()
    .transform((value) => (value === undefined ? fallback : Number(value)))
    .pipe(z.number().int().min(min).max(max));

const todayQuery = z.object({ limit: limitParam(1, 20, 5) });
const cardsQuery = z.object({
  kind: z.enum(["concept", "story", "pitch", "deep"]).optional(),
  topic: z.string().trim().min(1).max(60).optional(),
  limit: limitParam(1, 100, 100),
});
const reviewBody = z.object({ grade: z.enum(["again", "hard", "good"]) }).strict();
const mockQuery = z.object({ limit: limitParam(1, 10, 5) });
const mockBody = z
  .object({
    cardId: z.string().min(1),
    trapIndex: z.number().int().min(0).nullable(),
    reviewCount: z.number().int().min(0),
    answer: z.string().trim().min(1).max(4000),
  })
  .strict();

/** Derived flag: a deep card stuck in box 1 after 3 reviews. */
const withRisk = <T extends { kind: string; box: number; reviewCount: number }>(card: T) => ({ ...card, atRisk: isAtRisk(card) });

const errorName = (error: unknown) => (error instanceof Error ? error.name : "UnknownError");

/** The revision deck: generate, today's cards, browse, review, archive. Only ever the caller's own. */
export function createRevisionRoutes(deps: RevisionRouteDeps, requireUser: MiddlewareHandler<{ Variables: AppVariables }>) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const now = () => deps.now?.() ?? new Date();
  routes.use("*", requireUser);
  routes.onError((error, context) => {
    console.error(
      JSON.stringify({
        type: "openduet-revision-route-error",
        error: errorName(error),
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json({ error: "Impossible de charger tes fiches. Réessaie." }, 503);
  });
  const cardNotFound = (context: { json: (body: unknown, status: 404) => Response }) =>
    context.json({ error: "Cette fiche n'existe plus." }, 404);

  routes.post("/generate", async (context) => {
    const owner = context.var.actor.id;
    if (!(await deps.cv.getMaster(owner)))
      return context.json({ error: "Ajoute d'abord ton CV maître.", code: "no_master" }, 409);
    const started = deps.generator.start(owner);
    if (started === "in_progress")
      return context.json({ error: "Génération déjà en cours.", code: "generation_in_progress" }, 409);
    return context.json({ started: true }, 202);
  });

  routes.post("/deep/generate", async (context) => {
    const owner = context.var.actor.id;
    if (!(await deps.cv.getMaster(owner)))
      return context.json({ error: "Ajoute d'abord ton CV maître.", code: "no_master" }, 409);
    if (deps.generator.startDeep(owner) === "in_progress")
      return context.json({ error: "Génération déjà en cours.", code: "generation_in_progress" }, 409);
    return context.json({ started: true }, 202);
  });

  routes.get("/status", async (context) => context.json(await deps.generator.status(context.var.actor.id)));

  routes.get("/today", async (context) => {
    const query = todayQuery.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Limite invalide." }, 400);
    const owner = context.var.actor.id;
    const at = now();
    const [focus, master] = await Promise.all([loadFocus(deps, owner, at), deps.cv.getMaster(owner)]);
    const cards = await deps.store.listToday(owner, at, {
      limit: query.data.limit,
      focusOfferIds: focus.map((f) => f.offerId),
      masterHash: master?.contentHash ?? null,
    });
    return context.json({ cards: cards.map(withRisk), focus });
  });

  routes.get("/cards", async (context) => {
    const query = cardsQuery.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Filtre invalide." }, 400);
    return context.json({ cards: (await deps.store.list(context.var.actor.id, query.data)).map(withRisk) });
  });

  routes.get("/mock/questions", async (context) => {
    const query = mockQuery.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "Limite invalide." }, 400);
    const owner = context.var.actor.id;
    const at = now();
    const [cards, master, focus] = await Promise.all([
      deps.store.list(owner, { kind: "deep", limit: 100 }),
      deps.cv.getMaster(owner),
      focusOffers(deps, owner, at),
    ]);
    const envByBullet = new Map<string, string[]>();
    if (master)
      for (const e of parseMaster(master.content).experiences) for (const b of e.bullets) envByBullet.set(b.id, e.environment);
    const questions = pickQuestions(
      cards.map((c) => ({ ...c, environment: envByBullet.get(c.bulletIds[0]) ?? [] })),
      { limit: query.data.limit, now: at, focusSkills: focus.flatMap((f) => f.offer.skills ?? []) },
    );
    return context.json({ questions });
  });

  routes.post("/mock/answer", async (context) => {
    const body = mockBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "Réponse invalide (1 à 4000 caractères)." }, 400);
    const owner = context.var.actor.id;
    const card = await deps.store.get(owner, body.data.cardId);
    if (!card || card.kind !== "deep" || !card.details) return cardNotFound(context);
    if (card.archivedAt) return context.json({ error: "Cette fiche est archivée.", code: "archived" }, 409);
    if (card.reviewCount !== body.data.reviewCount)
      return context.json({ error: "Cette fiche vient d'être notée. Réessaie.", code: "review_conflict" }, 409);
    const { trapIndex } = body.data;
    if (trapIndex !== null && trapIndex >= card.details.traps.length)
      return context.json({ error: "Question invalide." }, 400);
    const reference = referenceOf({ answer: card.answer, details: card.details });
    const prompt = buildGradingPrompt({
      question: trapIndex === null ? card.question : card.details.traps[trapIndex].question,
      reference,
      answer: body.data.answer,
    });
    let grading: ReturnType<typeof parseGrading>;
    try {
      grading = parseGrading(await askModel(deps.complete, prompt, deps.timeoutMs ?? OFFER_CALL_TIMEOUT_MS), reference);
    } catch (error) {
      if (!(error instanceof RevisionAnswerError)) console.error(JSON.stringify({ type: "openduet-revision-mock-error", error: errorName(error), timestamp: new Date().toISOString() }));
      return context.json({ error: "Impossible de noter ta réponse. Réessaie." }, 503);
    }
    const grade = gradeOf(grading.scores);
    const outcome = await deps.store.review(owner, card.id, grade, now(), body.data.reviewCount);
    if (outcome.result !== "ok") {
      if (outcome.result === "not_found") return cardNotFound(context);
      if (outcome.result === "archived") return context.json({ error: "Cette fiche est archivée.", code: "archived" }, 409);
      return context.json({ error: "Cette fiche vient d'être notée. Réessaie.", code: "review_conflict" }, 409);
    }
    return context.json({ ...grading, grade, card: withRisk(outcome.card) });
  });

  routes.post("/cards/:id/review", async (context) => {
    const body = reviewBody.safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: "Note invalide (again, hard ou good)." }, 400);
    const outcome = await deps.store.review(context.var.actor.id, context.req.param("id"), body.data.grade, now());
    if (outcome.result !== "ok") {
      if (outcome.result === "not_found") return cardNotFound(context);
      if (outcome.result === "archived") return context.json({ error: "Cette fiche est archivée.", code: "archived" }, 409);
      return context.json({ error: "Cette fiche vient d'être notée. Réessaie.", code: "review_conflict" }, 409);
    }
    return context.json({ card: outcome.card });
  });

  routes.post("/cards/:id/archive", async (context) => {
    const card = await deps.store.archive(context.var.actor.id, context.req.param("id"), now());
    return card ? context.json({ card }) : cardNotFound(context);
  });

  return routes;
}
