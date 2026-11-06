import { describe, expect, test } from "bun:test";
import { defaultWeek, parisWeekday, parisWeekOf, parseWeekParam, previousWeeks } from "../src/openduet/career/week";

const HOUR = 3_600_000;

describe("Paris weeks", () => {
  test("a Wednesday belongs to the week starting Monday 00:00 Paris", () => {
    const w = parisWeekOf(new Date("2026-10-28T12:00:00Z"));
    expect(w.label).toBe("2026-10-26");
    expect(w.start.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-01T23:00:00.000Z");
  });

  test("DST weeks are 167 h in spring and 169 h in autumn", () => {
    const spring = parisWeekOf(new Date("2026-03-23T10:00:00Z"));
    expect((spring.end.getTime() - spring.start.getTime()) / HOUR).toBe(167);
    const autumn = parisWeekOf(new Date("2026-10-19T10:00:00Z"));
    expect(autumn.label).toBe("2026-10-19");
    expect((autumn.end.getTime() - autumn.start.getTime()) / HOUR).toBe(169);
  });

  test("Sunday 23:30 is still the old week, Monday 00:00 the new one", () => {
    expect(parisWeekOf(new Date("2026-11-01T22:30:00Z")).label).toBe("2026-10-26");
    expect(parisWeekOf(new Date("2026-11-01T23:00:00Z")).label).toBe("2026-11-02");
    expect(parisWeekday(new Date("2026-11-01T22:30:00Z"))).toBe(7);
    expect(parisWeekday(new Date("2026-11-01T23:00:00Z"))).toBe(1);
  });

  test("defaultWeek is the last completed week on Monday, the current one otherwise", () => {
    expect(defaultWeek(new Date("2026-11-02T08:00:00Z")).label).toBe("2026-10-26");
    expect(defaultWeek(new Date("2026-11-03T08:00:00Z")).label).toBe("2026-11-02");
  });

  test("parseWeekParam rejects bad input and normalises to the Monday", () => {
    for (const bad of ["2026-02-30", "2026-1-5", "x", "", "2026-10-29T00:00"]) expect(parseWeekParam(bad)).toBeNull();
    expect(parseWeekParam("2026-10-29")?.label).toBe("2026-10-26");
    expect(parseWeekParam("2026-10-26")?.label).toBe("2026-10-26");
  });

  test("previousWeeks steps by calendar days across the October DST change", () => {
    const weeks = previousWeeks(parisWeekOf(new Date("2026-11-03T08:00:00Z")), 4);
    expect(weeks.map((w) => w.label)).toEqual(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
    expect(weeks[1]?.end.getTime()).toBe(weeks[2]?.start.getTime());
    expect(weeks[2]?.start.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
});
