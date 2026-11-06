import { expect, test } from "bun:test";
import { parisBusinessDaysSince, parisDate } from "../src/openduet/items/paris-time";
import { relanceBody, relanceDue, silenceAnchor } from "../src/openduet/missions/relance";

/** Business days are counted on the Paris calendar: weekends skipped, DST-proof. */

test("parisBusinessDaysSince skips the weekend", () => {
  const fri = parisDate(2026, 10, 30, 10); // Friday
  expect(parisBusinessDaysSince(fri, parisDate(2026, 10, 30, 18))).toBe(0);
  expect(parisBusinessDaysSince(fri, parisDate(2026, 10, 31, 10))).toBe(0); // Saturday
  expect(parisBusinessDaysSince(fri, parisDate(2026, 11, 1, 10))).toBe(0); // Sunday
  expect(parisBusinessDaysSince(fri, parisDate(2026, 11, 2, 9))).toBe(1); // Monday
  expect(parisBusinessDaysSince(fri, parisDate(2026, 11, 6, 9))).toBe(5); // next Friday
});

test("parisBusinessDaysSince is stable across the October DST change", () => {
  // Clocks go back on Sunday 2026-10-25. Wed 21 -> Wed 28 is 5 business days.
  expect(parisBusinessDaysSince(parisDate(2026, 10, 21, 23, 30), parisDate(2026, 10, 28, 0, 30))).toBe(5);
  // Late evening Paris is already the next UTC-less day boundary: 23:30 Paris is still Wednesday.
  expect(parisBusinessDaysSince(parisDate(2026, 10, 21, 23, 30), parisDate(2026, 10, 21, 23, 59))).toBe(0);
});

test("parisBusinessDaysSince is stable across the March DST change", () => {
  // Clocks go forward on Sunday 2026-03-29. Fri 27 -> Mon 30 is 1 business day.
  expect(parisBusinessDaysSince(parisDate(2026, 3, 27, 12), parisDate(2026, 3, 30, 0, 10))).toBe(1);
});

test("an anchor in the future counts zero", () => {
  expect(parisBusinessDaysSince(parisDate(2026, 11, 5, 9), parisDate(2026, 11, 2, 9))).toBe(0);
});

const base = {
  company: "Acme",
  role: "Lead dev" as string | null,
  stage: "applied" as const,
  review: "active" as const,
  stageEnteredAt: parisDate(2026, 11, 2, 9), // Monday
  lastInboundAt: null as Date | null,
  lastOutboundAt: null as Date | null,
};
const friday = parisDate(2026, 11, 6, 9); // 4 business days later
const monday = parisDate(2026, 11, 9, 9); // 5 business days later

test("silenceAnchor is the latest sign of life", () => {
  expect(silenceAnchor(base)).toEqual(base.stageEnteredAt);
  const later = parisDate(2026, 11, 4, 9);
  expect(silenceAnchor({ ...base, lastInboundAt: later })).toEqual(later);
  expect(silenceAnchor({ ...base, lastOutboundAt: later, lastInboundAt: parisDate(2026, 11, 3, 9) })).toEqual(later);
});

test("relanceDue: 5 business days of silence on applied or talking, active only", () => {
  expect(relanceDue(base, friday, 0)).toBe(false);
  expect(relanceDue(base, monday, 0)).toBe(true);
  expect(relanceDue({ ...base, stage: "talking" }, monday, 0)).toBe(true);
  expect(relanceDue({ ...base, stage: "piste" }, monday, 0)).toBe(false);
  expect(relanceDue({ ...base, stage: "interview" }, monday, 0)).toBe(false);
  expect(relanceDue({ ...base, review: "proposed" }, monday, 0)).toBe(false);
});

test("relanceDue stops after 2 relances in the stage", () => {
  expect(relanceDue(base, monday, 1)).toBe(true);
  expect(relanceDue(base, monday, 2)).toBe(false);
});

test("relanceBody is a short French note naming the role and company", () => {
  const body = relanceBody(base);
  expect(body).toContain("Acme");
  expect(body).toContain("Lead dev");
  expect(body).toMatch(/Bonjour/);
  expect(relanceBody({ ...base, role: null })).not.toContain("null");
});

import { relanceAnchor } from "../src/openduet/missions/relance";

const noInterview = { lastEndedInterviewEnd: null, hasUpcomingInterview: false };

test("relanceAnchor is the later of the silence anchor and the last ended interview", () => {
  expect(relanceAnchor(base, null)).toEqual(base.stageEnteredAt);
  const later = parisDate(2026, 11, 4, 15);
  expect(relanceAnchor(base, later)).toEqual(later);
  expect(relanceAnchor({ ...base, lastInboundAt: parisDate(2026, 11, 5, 9) }, later)).toEqual(parisDate(2026, 11, 5, 9));
});

test("relanceDue keeps applied and talking as before when given no interview facts", () => {
  expect(relanceDue(base, friday, 0, noInterview)).toBe(false);
  expect(relanceDue(base, monday, 0, noInterview)).toBe(true);
  expect(relanceDue({ ...base, stage: "talking" }, monday, 0, noInterview)).toBe(true);
});

test("relanceDue: an interview stage needs an ended interview and no upcoming one", () => {
  const m = { ...base, stage: "interview" as const };
  const ended = parisDate(2026, 11, 2, 15); // Monday
  expect(relanceDue(m, monday, 0, noInterview)).toBe(false);
  expect(relanceDue(m, monday, 0, { lastEndedInterviewEnd: ended, hasUpcomingInterview: false })).toBe(true);
  expect(relanceDue(m, monday, 0, { lastEndedInterviewEnd: ended, hasUpcomingInterview: true })).toBe(false);
});

test("relanceDue counts five business days from the interview end, not the stage entry", () => {
  const m = { ...base, stage: "interview" as const };
  const ended = parisDate(2026, 11, 4, 15); // Wednesday
  expect(relanceDue(m, parisDate(2026, 11, 10, 9), 0, { lastEndedInterviewEnd: ended, hasUpcomingInterview: false })).toBe(false);
  expect(relanceDue(m, parisDate(2026, 11, 11, 9), 0, { lastEndedInterviewEnd: ended, hasUpcomingInterview: false })).toBe(true);
  expect(relanceDue(m, parisDate(2026, 11, 11, 9), 2, { lastEndedInterviewEnd: ended, hasUpcomingInterview: false })).toBe(false);
});
