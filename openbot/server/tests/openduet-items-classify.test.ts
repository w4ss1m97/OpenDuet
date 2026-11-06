import { expect, test } from "bun:test";
import { classify, defaultRemindAt } from "../src/openduet/items/classify";
import type { ItemCandidate } from "../src/openduet/items/types";

const now = new Date("2026-11-01T08:00:00Z");

function c(overrides: Partial<ItemCandidate>): ItemCandidate {
  return {
    kind: "interview",
    title: "x",
    sourceApp: "gmail",
    sourceHash: "h",
    dateExplicit: true,
    ...overrides,
  };
}

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

test("interview with explicit date is active", () => {
  expect(classify(c({ dueAt: new Date("2026-11-12T13:00:00Z") }))).toBe("active");
});

test("interview without explicit date is proposed", () => {
  expect(classify(c({ dueAt: new Date(), dateExplicit: false }))).toBe("proposed");
});

test("bill without amount is proposed", () => {
  expect(classify(c({ kind: "bill", dueAt: new Date() }))).toBe("proposed");
});

test("bill with date and amount is active", () => {
  expect(classify(c({ kind: "fine", dueAt: new Date(), amount: 135 }))).toBe("active");
});

test("idea is always proposed", () => {
  expect(classify(c({ kind: "idea", dueAt: new Date() }))).toBe("proposed");
});

test("interview 2026-11-12 14:00 Paris → D-1 18:00 and 1 h before", () => {
  const dueAt = new Date("2026-11-12T13:00:00Z"); // 14:00 Paris (UTC+1)
  expect(iso(defaultRemindAt(c({ dueAt }), now))).toEqual([
    "2026-11-11T17:00:00.000Z",
    "2026-11-12T12:00:00.000Z",
  ]);
});

test("all-day bill due 2026-11-20 → D-3 09:00 and D-day 09:00 Paris", () => {
  const dueAt = new Date("2026-11-19T23:00:00Z"); // 2026-11-20 00:00 Paris
  expect(
    iso(defaultRemindAt(c({ kind: "bill", dueAt, allDay: true, amount: 45 }), now)),
  ).toEqual(["2026-11-17T08:00:00.000Z", "2026-11-20T08:00:00.000Z"]);
});

test("defaultRemindAt uses Europe/Paris across DST", () => {
  const dueAt = new Date("2027-03-29T08:00:00Z"); // 10:00 Paris (UTC+2)
  expect(iso(defaultRemindAt(c({ kind: "deadline", dueAt }), now))).toEqual([
    "2027-03-28T07:00:00.000Z", // 09:00 Paris, first day of summer time
  ]);
});

test("drops reminders already in the past", () => {
  const dueAt = new Date("2026-11-12T13:00:00Z");
  const late = new Date("2026-11-11T20:00:00Z");
  expect(iso(defaultRemindAt(c({ dueAt }), late))).toEqual([
    "2026-11-12T12:00:00.000Z",
  ]);
});

test("idea has no reminders", () => {
  expect(defaultRemindAt(c({ kind: "idea", dueAt: new Date("2026-12-01") }), now)).toEqual([]);
});

test("no due date gives no reminders", () => {
  expect(defaultRemindAt(c({ dueAt: undefined }), now)).toEqual([]);
});
