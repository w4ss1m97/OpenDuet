import { expect, test } from "bun:test";
import {
  daysInStage,
  groupByStage,
  type Mission,
  nextStages,
  STAGE_LABELS,
} from "../src/missions";

const now = new Date("2026-11-07T08:00:00Z");
const day = 24 * 3600_000;

function mission(id: string, stage: Mission["stage"], enteredDaysAgo = 0): Mission {
  return {
    id,
    company: "Acme",
    role: null,
    stage,
    review: "active",
    title: id,
    stageEnteredAt: new Date(now.getTime() - enteredDaysAgo * day).toISOString(),
    lastInboundAt: null,
    lastOutboundAt: null,
    closedAt: null,
  };
}

test("labels cover all stages", () => {
  expect(Object.keys(STAGE_LABELS).sort()).toEqual(
    ["applied", "interview", "offer", "piste", "refused", "signed", "talking"].sort(),
  );
  expect(STAGE_LABELS.talking).toBe("Échange");
});

test("nextStages goes forward and to refused, nothing from terminal", () => {
  expect(nextStages("applied")).toEqual(["talking", "interview", "offer", "signed", "refused"]);
  expect(nextStages("interview")).toEqual(["offer", "signed", "refused"]);
  expect(nextStages("signed")).toEqual([]);
  expect(nextStages("refused")).toEqual([]);
});

test("groupByStage keeps pipeline order, closed last, omits empty", () => {
  const groups = groupByStage([
    mission("a", "refused"),
    mission("b", "applied"),
    mission("c", "piste"),
    mission("d", "applied"),
  ]);
  expect(groups.map((g) => g.stage)).toEqual(["piste", "applied", "refused"]);
  expect(groups[1]?.missions.map((m) => m.id)).toEqual(["b", "d"]);
  expect(groupByStage([])).toEqual([]);
});

test("daysInStage counts whole days, never negative", () => {
  expect(daysInStage(mission("a", "applied", 3.5), now)).toBe(3);
  expect(daysInStage(mission("a", "applied", 0), now)).toBe(0);
  expect(daysInStage(mission("a", "applied", -2), now)).toBe(0);
});
