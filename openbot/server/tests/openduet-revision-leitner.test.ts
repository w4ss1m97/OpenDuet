import { expect, test } from "bun:test";
import { dueTodayBefore, nextReview } from "../src/openduet/revision/leitner";

const now = new Date("2026-11-01T10:30:00Z"); // 11:30 Paris, winter
const midnight = (d: string) => new Date(d);

test("good moves up one box, capped at 5, with 1/2/4/8/16 day intervals", () => {
  const dues = ["2026-11-02T23:00:00.000Z", "2026-11-04T23:00:00.000Z", "2026-11-08T23:00:00.000Z", "2026-11-16T23:00:00.000Z", "2026-11-16T23:00:00.000Z"];
  for (let box = 1; box <= 5; box++) {
    const r = nextReview(box, "good", now);
    expect(r.box).toBe(Math.min(box + 1, 5));
    expect(r.dueAt.toISOString()).toBe(dues[box - 1]);
  }
  expect(nextReview(1, "good", now).dueAt.toISOString()).toBe("2026-11-02T23:00:00.000Z");
  expect(nextReview(4, "good", now).dueAt.toISOString()).toBe("2026-11-16T23:00:00.000Z");
});

test("again resets to box 1 (due tomorrow), hard keeps the box", () => {
  for (let box = 1; box <= 5; box++) {
    expect(nextReview(box, "again", now).box).toBe(1);
    expect(nextReview(box, "again", now).dueAt.toISOString()).toBe("2026-11-01T23:00:00.000Z");
    expect(nextReview(box, "hard", now).box).toBe(box);
  }
  expect(nextReview(3, "hard", now).dueAt.toISOString()).toBe("2026-11-04T23:00:00.000Z"); // +4 days
});

test("due dates land on Paris midnight across the DST changes", () => {
  // 2026-03-29: Paris goes to summer time; 2026-10-25 back to winter.
  expect(nextReview(1, "again", new Date("2026-03-28T12:00:00Z")).dueAt.toISOString()).toBe("2026-03-28T23:00:00.000Z");
  expect(nextReview(1, "good", new Date("2026-03-28T12:00:00Z")).dueAt.toISOString()).toBe("2026-03-29T22:00:00.000Z");
  expect(nextReview(1, "again", new Date("2026-10-24T12:00:00Z")).dueAt.toISOString()).toBe("2026-10-24T22:00:00.000Z");
  expect(nextReview(1, "good", new Date("2026-10-24T12:00:00Z")).dueAt.toISOString()).toBe("2026-10-25T23:00:00.000Z");
});

test("dueTodayBefore is the next Paris midnight, including across DST", () => {
  expect(dueTodayBefore(now).toISOString()).toBe("2026-11-01T23:00:00.000Z");
  expect(dueTodayBefore(new Date("2026-03-29T10:00:00Z")).toISOString()).toBe("2026-03-29T22:00:00.000Z");
  expect(dueTodayBefore(new Date("2026-10-25T10:00:00Z")).toISOString()).toBe("2026-10-25T23:00:00.000Z");
});

test("boundary: one minute before Paris midnight is still today, midnight is tomorrow", () => {
  const edge = dueTodayBefore(now);
  const before = new Date(edge.getTime() - 60_000);
  expect(before < dueTodayBefore(now)).toBe(true);
  expect(edge < dueTodayBefore(now)).toBe(false);
  // 22:59Z on 1 Nov is 23:59 Paris: same day; 23:00Z is already 2 Nov.
  expect(dueTodayBefore(new Date("2026-11-01T22:59:00Z")).toISOString()).toBe("2026-11-01T23:00:00.000Z");
  expect(dueTodayBefore(new Date("2026-11-01T23:00:00Z")).toISOString()).toBe("2026-11-02T23:00:00.000Z");
  void midnight;
});
