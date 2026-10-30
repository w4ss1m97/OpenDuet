import { expect, test } from "bun:test";
import { parseEvent } from "../src/openduet/items/calendar-parser";

test('"Entretien Société X" is an interview in missions', () => {
  const item = parseEvent({
    id: "ev1",
    summary: "Entretien Société X",
    start: "2026-11-12T14:00:00+01:00",
  });
  expect(item).toMatchObject({
    kind: "interview",
    channelId: "missions",
    sourceApp: "gcal",
    dateExplicit: true,
    allDay: false,
  });
  expect(item?.dueAt?.toISOString()).toBe("2026-11-12T13:00:00.000Z");
});

test("all-day event sets allDay at Paris midnight", () => {
  const item = parseEvent({ id: "ev2", summary: "Call client Acme", start: "2026-11-20" });
  expect(item?.allDay).toBe(true);
  expect(item?.dueAt?.toISOString()).toBe("2026-11-19T23:00:00.000Z");
});

test('"Dentiste" is not an item', () => {
  expect(parseEvent({ id: "ev3", summary: "Dentiste", start: "2026-11-12T10:00:00+01:00" })).toBeNull();
});

test("the location can mark an interview too", () => {
  expect(
    parseEvent({ id: "ev5", summary: "Point", location: "Visio entretien Teams", start: "2026-11-12T10:00:00+01:00" })?.kind,
  ).toBe("interview");
});

test("a moved event keeps its hash, so it updates one item", () => {
  const a = parseEvent({ id: "ev4", summary: "Interview Acme", start: "2026-11-12T10:00:00+01:00" });
  const b = parseEvent({ id: "ev4", summary: "Interview Acme", start: "2026-11-13T10:00:00+01:00" });
  expect(a?.sourceHash).toBe("gcal:ev4");
  expect(b?.sourceHash).toBe(a?.sourceHash);
});

test("an event with no start is ignored", () => {
  expect(parseEvent({ id: "ev6", summary: "Entretien", start: "" })).toBeNull();
});
