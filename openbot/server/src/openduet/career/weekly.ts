import type { OfferContract, OfferRateUnit } from "../../db/schema/openduet-job-offers";
import { dueTodayBefore } from "../revision/leitner";
import { SHOW_THRESHOLD } from "../job-offers/status";
import type { Stage } from "../missions/stages";
import { previousWeeks, type ParisWeek } from "./week";

/*
 * The weekly career check: pure aggregation of what career/store.ts read. No database, no model.
 * Counts only, so nothing here can carry a company name or a mail's text.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const TJM_WEEKS = 4;

export type WeeklyOffer = {
  createdAt: Date;
  scoredAt: Date | null;
  score: number | null;
  tjmMin: number | null;
  tjmMax: number | null;
  rateUnit: OfferRateUnit;
  tjmUnknown: boolean;
  contract: OfferContract;
};

export type WeeklyRaw = {
  stageMoves: { toStage: Stage; at: Date }[];
  newMissions: { createdAt: Date }[];
  relancesSent: { at: Date }[];
  openMissions: { stage: Stage; review: "proposed" | "active" | "dismissed" }[];
  relanceDrafts: number;
  offers: WeeklyOffer[];
  interviews: { dueAt: Date; status: string }[];
  cards: { box: number; dueAt: Date | null; lastReviewedAt: Date | null }[];
};

export type TjmWeek = { week: string; median: number | null; withRate: number; offers: number };

export type WeeklyCheck = {
  week: { label: string; start: string; end: string; complete: boolean };
  window: {
    newMissions: number;
    movesTo: Partial<Record<Stage, number>>;
    relancesSent: number;
    offersShown: number;
    interviewsHeld: number;
    cardsReviewed: number;
  };
  now: {
    asOf: string;
    pipeline: Partial<Record<Stage, number>>;
    proposedMissions: number;
    relanceDrafts: number;
    upcomingInterviews: number;
    revision: { boxes: number[]; dueNow: number; newCount: number };
  };
  tjm: TjmWeek[];
};

/** The day rate of a freelance offer quoted per day: the midpoint of a range, else the one bound. */
export function tjmValue(o: Pick<WeeklyOffer, "rateUnit" | "tjmUnknown" | "contract" | "tjmMin" | "tjmMax">): number | null {
  if (o.rateUnit !== "day" || o.tjmUnknown || o.contract === "salaried") return null;
  if (o.tjmMin != null && o.tjmMax != null) return (o.tjmMin + o.tjmMax) / 2;
  return o.tjmMin ?? o.tjmMax ?? null;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return Math.round(sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

const within = (d: Date | null, start: Date, end: Date) => d !== null && d >= start && d < end;

function countBy<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
  return out;
}

export function summarizeWeek(raw: WeeklyRaw, week: ParisWeek, now: Date): WeeklyCheck {
  const { start, end } = week;
  const heldEnd = now < end ? now : end;
  const weekAhead = new Date(now.getTime() + 7 * DAY_MS);
  const dueBefore = dueTodayBefore(now);
  const boxes = [0, 0, 0, 0, 0];
  let dueNow = 0;
  let newCount = 0;
  for (const card of raw.cards) {
    boxes[Math.min(Math.max(card.box, 1), 5) - 1] += 1;
    if (card.dueAt === null) newCount += 1;
    else if (card.dueAt < dueBefore) dueNow += 1;
  }
  const tjm = previousWeeks(week, TJM_WEEKS).map((w) => {
    const inWeek = raw.offers.filter((o) => within(o.createdAt, w.start, w.end));
    const values = inWeek.map(tjmValue).filter((v): v is number => v !== null);
    return { week: w.label, median: median(values), withRate: values.length, offers: inWeek.length };
  });
  return {
    week: { label: week.label, start: start.toISOString(), end: end.toISOString(), complete: now >= end },
    window: {
      newMissions: raw.newMissions.filter((m) => within(m.createdAt, start, end)).length,
      movesTo: countBy(
        raw.stageMoves.filter((m) => within(m.at, start, end)),
        (m) => m.toStage,
      ) as Partial<Record<Stage, number>>,
      relancesSent: raw.relancesSent.filter((r) => within(r.at, start, end)).length,
      offersShown: raw.offers.filter((o) => (o.score ?? -1) >= SHOW_THRESHOLD && within(o.scoredAt, start, end)).length,
      interviewsHeld: raw.interviews.filter((i) => within(i.dueAt, start, heldEnd)).length,
      cardsReviewed: raw.cards.filter((c) => within(c.lastReviewedAt, start, end)).length,
    },
    now: {
      asOf: now.toISOString(),
      pipeline: countBy(
        raw.openMissions.filter((m) => m.review === "active"),
        (m) => m.stage,
      ) as Partial<Record<Stage, number>>,
      proposedMissions: raw.openMissions.filter((m) => m.review === "proposed").length,
      relanceDrafts: raw.relanceDrafts,
      upcomingInterviews: raw.interviews.filter((i) => i.status === "active" && within(i.dueAt, now, weekAhead)).length,
      revision: { boxes, dueNow, newCount },
    },
    tjm,
  };
}

const STAGE_WORDS: Record<Stage, string> = {
  piste: "piste",
  applied: "candidature",
  talking: "discussion",
  interview: "entretien",
  offer: "offre",
  signed: "signature",
  refused: "refus",
};
const STAGE_ORDER: Stage[] = ["piste", "applied", "talking", "interview", "offer", "signed", "refused"];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const stageCounts = (counts: Partial<Record<Stage, number>>) =>
  STAGE_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${STAGE_WORDS[s]}`);

/** French lines for the brief, counts only, one per non-empty section. */
export function weeklyBriefLines(check: WeeklyCheck): string[] {
  const lines: string[] = [];
  const [, month, day] = check.week.label.split("-");
  const w = check.window;
  const head: string[] = [];
  if (w.newMissions) head.push(plural(w.newMissions, "nouvelle mission", "nouvelles missions"));
  for (const s of STAGE_ORDER) {
    const n = w.movesTo[s];
    if (n) head.push(`${plural(n, "passage")} en ${STAGE_WORDS[s]}`);
  }
  if (w.relancesSent) head.push(plural(w.relancesSent, "relance envoyée", "relances envoyées"));
  if (head.length) lines.push(`Semaine du ${day}/${month} : ${head.join(", ")}.`);

  const pipeline = stageCounts(check.now.pipeline);
  const waiting: string[] = [];
  if (check.now.relanceDrafts) waiting.push(plural(check.now.relanceDrafts, "relance en attente", "relances en attente"));
  if (check.now.proposedMissions) waiting.push(plural(check.now.proposedMissions, "mission à valider", "missions à valider"));
  if (pipeline.length || waiting.length) lines.push(`Pipeline : ${[...pipeline, ...waiting].join(", ")}.`);

  const current = check.tjm[check.tjm.length - 1];
  const offerParts: string[] = [];
  if (w.offersShown) offerParts.push(`${plural(w.offersShown, "retenue")}.`);
  if (current?.median != null)
    offerParts.push(`TJM médian ${current.median} €/j (${plural(current.withRate, "offre chiffrée")} sur ${current.offers}).`);
  if (offerParts.length) lines.push(`Offres : ${offerParts.join(" ")}`);

  const interviews: string[] = [];
  if (w.interviewsHeld) interviews.push(plural(w.interviewsHeld, "passé"));
  if (check.now.upcomingInterviews) interviews.push(plural(check.now.upcomingInterviews, "à venir", "à venir"));
  if (interviews.length) lines.push(`Entretiens : ${interviews.join(", ")}.`);

  const rev = check.now.revision;
  const revParts: string[] = [];
  if (w.cardsReviewed) revParts.push(plural(w.cardsReviewed, "carte revue", "cartes revues"));
  if (rev.dueNow) revParts.push(`${rev.dueNow} à revoir`);
  if (revParts.length) lines.push(`Révision : ${revParts.join(", ")}.`);
  return lines;
}
