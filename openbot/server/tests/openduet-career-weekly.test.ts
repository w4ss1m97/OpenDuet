import { describe, expect, test } from "bun:test";
import { parisWeekOf } from "../src/openduet/career/week";
import { median, summarizeWeek, tjmValue, weeklyBriefLines, type WeeklyOffer, type WeeklyRaw } from "../src/openduet/career/weekly";

const WEEK = parisWeekOf(new Date("2026-10-28T12:00:00Z")); // 2026-10-25T23:00Z .. 2026-11-01T23:00Z
const AFTER = new Date("2026-11-03T08:00:00Z");
const D = (s: string) => new Date(s);
const empty = (): WeeklyRaw => ({
  stageMoves: [],
  newMissions: [],
  relancesSent: [],
  openMissions: [],
  relanceDrafts: 0,
  offers: [],
  interviews: [],
  cards: [],
});
const offer = (over: Partial<WeeklyOffer> = {}): WeeklyOffer => ({
  createdAt: D("2026-10-27T10:00:00Z"),
  scoredAt: null,
  score: null,
  tjmMin: 600,
  tjmMax: 700,
  rateUnit: "day",
  tjmUnknown: false,
  contract: "freelance",
  ...over,
});

describe("tjmValue and median", () => {
  test("tjmValue", () => {
    expect(tjmValue(offer())).toBe(650);
    expect(tjmValue(offer({ tjmMin: null }))).toBe(700);
    expect(tjmValue(offer({ tjmMax: null }))).toBe(600);
    expect(tjmValue(offer({ tjmMin: null, tjmMax: null }))).toBeNull();
    expect(tjmValue(offer({ rateUnit: "hour" }))).toBeNull();
    expect(tjmValue(offer({ tjmUnknown: true }))).toBeNull();
    expect(tjmValue(offer({ contract: "salaried" }))).toBeNull();
  });
  test("median", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3); // 2.5 rounds up
    expect(median([600, 700])).toBe(650);
  });
});

describe("summarizeWeek", () => {
  test("empty data gives zeros and four empty TJM weeks", () => {
    const c = summarizeWeek(empty(), WEEK, AFTER);
    expect(c.window).toEqual({ newMissions: 0, movesTo: {}, relancesSent: 0, offersShown: 0, interviewsHeld: 0, cardsReviewed: 0 });
    expect(c.now.revision).toEqual({ boxes: [0, 0, 0, 0, 0], dueNow: 0, newCount: 0 });
    expect(c.tjm).toHaveLength(4);
    expect(c.tjm.every((t) => t.median === null && t.offers === 0)).toBe(true);
    expect(c.week.complete).toBe(true);
    expect(weeklyBriefLines(c)).toEqual([]);
  });

  test("the start is in, the end is out", () => {
    const raw = empty();
    raw.newMissions = [{ createdAt: WEEK.start }, { createdAt: WEEK.end }, { createdAt: new Date(WEEK.start.getTime() - 1) }];
    expect(summarizeWeek(raw, WEEK, AFTER).window.newMissions).toBe(1);
  });

  test("interviewsHeld stops at now and a running week is not complete", () => {
    const raw = empty();
    raw.interviews = [
      { dueAt: D("2026-10-27T09:00:00Z"), status: "done" },
      { dueAt: D("2026-10-30T09:00:00Z"), status: "active" },
    ];
    const c = summarizeWeek(raw, WEEK, D("2026-10-28T12:00:00Z"));
    expect(c.window.interviewsHeld).toBe(1);
    expect(c.now.upcomingInterviews).toBe(1);
    expect(c.week.complete).toBe(false);
  });

  test("offersShown ignores status and needs a score of 75", () => {
    const raw = empty();
    const at = D("2026-10-29T10:00:00Z");
    raw.offers = [offer({ score: 75, scoredAt: at }), offer({ score: 74, scoredAt: at }), offer({ score: 90, scoredAt: D("2026-10-10T10:00:00Z") }), offer({ score: null })];
    expect(summarizeWeek(raw, WEEK, AFTER).window.offersShown).toBe(1);
  });

  test("movesTo, pipeline, boxes and dueNow", () => {
    const raw = empty();
    raw.stageMoves = [
      { toStage: "interview", at: D("2026-10-27T10:00:00Z") },
      { toStage: "interview", at: D("2026-10-28T10:00:00Z") },
      { toStage: "applied", at: D("2026-10-20T10:00:00Z") },
    ];
    raw.openMissions = [
      { stage: "applied", review: "active" },
      { stage: "applied", review: "active" },
      { stage: "piste", review: "proposed" },
    ];
    raw.cards = [
      { box: 1, dueAt: null, lastReviewedAt: null },
      { box: 2, dueAt: D("2026-11-02T10:00:00Z"), lastReviewedAt: D("2026-10-27T10:00:00Z") },
      { box: 5, dueAt: D("2026-11-20T10:00:00Z"), lastReviewedAt: D("2026-10-10T10:00:00Z") },
    ];
    const c = summarizeWeek(raw, WEEK, AFTER);
    expect(c.window.movesTo).toEqual({ interview: 2 });
    expect(c.now.pipeline).toEqual({ applied: 2 });
    expect(c.now.proposedMissions).toBe(1);
    expect(c.now.revision).toEqual({ boxes: [1, 1, 0, 0, 5 > 0 ? 1 : 0], dueNow: 1, newCount: 1 });
    expect(c.window.cardsReviewed).toBe(1);
  });

  test("tjm trend groups by creation week", () => {
    const raw = empty();
    raw.offers = [offer(), offer({ tjmMin: 800, tjmMax: 800 }), offer({ rateUnit: "year" }), offer({ createdAt: D("2026-10-14T10:00:00Z"), tjmMin: 500, tjmMax: 500 })];
    const t = summarizeWeek(raw, WEEK, AFTER).tjm;
    expect(t.map((x) => x.week)).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(t[3]).toEqual({ week: "2026-10-26", median: 725, withRate: 2, offers: 3 });
    expect(t[1]).toEqual({ week: "2026-10-12", median: 500, withRate: 1, offers: 1 });
  });

  test("brief lines carry counts and no company name", () => {
    const raw = empty();
    raw.newMissions = [{ createdAt: D("2026-10-27T10:00:00Z") }, { createdAt: D("2026-10-28T10:00:00Z") }];
    raw.stageMoves = [{ toStage: "interview", at: D("2026-10-27T10:00:00Z") }];
    raw.relancesSent = [{ at: D("2026-10-27T10:00:00Z") }];
    raw.offers = [offer({ score: 80, scoredAt: D("2026-10-27T10:00:00Z"), tjmMin: 620, tjmMax: 620 })];
    raw.cards = [{ box: 1, dueAt: D("2026-10-30T10:00:00Z"), lastReviewedAt: D("2026-10-27T10:00:00Z") }];
    const lines = weeklyBriefLines(summarizeWeek(raw, WEEK, AFTER)).join("\n");
    expect(lines).toContain("Semaine du 26/10 : 2 nouvelles missions, 1 passage en entretien, 1 relance envoyée.");
    expect(lines).toContain("Offres : 1 retenue. TJM médian 620 €/j (1 offre chiffrée sur 1).");
    expect(lines).toContain("Révision : 1 carte revue, 1 à revoir.");
    expect(lines).not.toContain("Acme");
  });
});
