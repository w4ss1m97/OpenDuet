import { expect, test } from "bun:test";
import {
  addQuery,
  dueFromLocal,
  snoozeQuery,
} from "@/lib/cockpit/reminders";

test("addQuery percent-encodes & = and unicode", () => {
  const q = addQuery({ text: "pay a&b=c é 日本", due: 1_800_000_000, project: "", repeat: "none" });
  expect(q).toBe("?text=pay%20a%26b%3Dc%20%C3%A9%20%E6%97%A5%E6%9C%AC&due=1800000000&project=&repeat=none");
  const back = new URLSearchParams(q);
  expect(back.get("text")).toBe("pay a&b=c é 日本");
});

test("addQuery trims the text and floors the due time", () => {
  expect(addQuery({ text: "  hi  ", due: 10.9, project: "Duet", repeat: "daily" })).toBe(
    "?text=hi&due=10&project=Duet&repeat=daily",
  );
});

test("snoozeQuery carries until in epoch seconds", () => {
  expect(snoozeQuery(1_800_003_600)).toBe("?until=1800003600");
});

test("dueFromLocal reads a datetime-local value as local time", () => {
  const s = dueFromLocal("2026-11-02T09:30");
  expect(s).toBe(Math.floor(new Date(2026, 10, 2, 9, 30).getTime() / 1000));
  expect(dueFromLocal("")).toBeNull();
  expect(dueFromLocal("nope")).toBeNull();
});
