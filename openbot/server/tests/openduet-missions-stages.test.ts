import { expect, test } from "bun:test";
import {
  STAGES,
  canTransition,
  isTerminal,
  nextStage,
  rank,
  type MissionSignal,
  type Stage,
} from "../src/openduet/missions/stages";

/** The pipeline only moves forward, may skip stages, and stops at signed or refused. */

const OPEN: Stage[] = ["piste", "applied", "talking", "interview", "offer"];

test("stages are ordered and only signed and refused are terminal", () => {
  expect(STAGES).toEqual(["piste", "applied", "talking", "interview", "offer", "signed", "refused"]);
  expect(rank("piste")).toBeLessThan(rank("applied"));
  expect(rank("offer")).toBeLessThan(rank("signed"));
  expect(STAGES.filter(isTerminal)).toEqual(["signed", "refused"]);
});

test("canTransition: forward yes (skips allowed), same or backward no, refused from any open stage", () => {
  expect(canTransition("applied", "interview")).toBe(true);
  expect(canTransition("piste", "offer")).toBe(true);
  expect(canTransition("interview", "talking")).toBe(false);
  expect(canTransition("applied", "applied")).toBe(false);
  for (const from of OPEN) expect(canTransition(from, "refused")).toBe(true);
});

test("canTransition: nothing leaves signed or refused", () => {
  for (const to of STAGES) {
    expect(canTransition("signed", to)).toBe(false);
    expect(canTransition("refused", to)).toBe(false);
  }
});

test("nextStage: a signal at or below the current stage moves nothing", () => {
  const cases: [Stage, MissionSignal, Stage | null][] = [
    ["applied", "reply", "talking"],
    ["piste", "reply", "talking"],
    ["talking", "reply", null],
    ["interview", "reply", null],
    ["applied", "invite", "interview"],
    ["interview", "invite", null],
    ["talking", "offer", "offer"],
    ["offer", "offer", null],
    ["interview", "rejection", "refused"],
    ["signed", "rejection", null],
    ["refused", "invite", null],
  ];
  for (const [current, signal, expected] of cases) {
    expect(nextStage(current, signal)).toBe(expected);
  }
});
