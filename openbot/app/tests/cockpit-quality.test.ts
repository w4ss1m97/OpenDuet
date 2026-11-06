import { expect, test } from "bun:test";
import {
  gradeOf,
  trendDelta,
  trendPoints,
  weightedCategories,
} from "@/lib/cockpit/quality";

test("gradeOf uses the 90/80/70/60 bounds", () => {
  expect([100, 90, 89, 80, 79, 70, 69, 60, 59, 0].map(gradeOf)).toEqual([
    "A", "A", "B", "B", "C", "C", "D", "D", "F", "F",
  ]);
});

test("trendPoints maps days to x and scores to a flipped y", () => {
  const pts = trendPoints(
    [
      { day: "2026-10-01", score: 100, grade: "A" },
      { day: "2026-10-02", score: 50, grade: "F" },
      { day: "2026-10-03", score: 0, grade: "F" },
    ],
    200,
    100,
  );
  expect(pts).toBe("0,0 100,50 200,100");
});

test("trendPoints handles one point and none", () => {
  expect(trendPoints([], 200, 100)).toBe("");
  expect(trendPoints([{ day: "d", score: 80, grade: "B" }], 200, 100)).toBe("100,20");
});

test("trendDelta is last minus first, null under two points", () => {
  expect(trendDelta([{ day: "a", score: 70, grade: "C" }])).toBeNull();
  expect(
    trendDelta([
      { day: "a", score: 70, grade: "C" },
      { day: "b", score: 85, grade: "B" },
    ]),
  ).toBe(15);
});

test("weightedCategories lists the five categories in weight order, null kept", () => {
  const rows = weightedCategories({ tests: 80, deps: null, security: 100, health: 90, hygiene: 70 });
  expect(rows.map((r) => [r.key, r.weight, r.score])).toEqual([
    ["tests", 30, 80],
    ["deps", 20, null],
    ["security", 25, 100],
    ["health", 15, 90],
    ["hygiene", 10, 70],
  ]);
});
