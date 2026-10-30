import { expect, test } from "bun:test";
import { type Item, MAX_SCHEDULED, planReminders } from "../src/reminders-plan";

const now = new Date("2026-11-07T08:00:00Z");
const day = 24 * 3600_000;

function item(id: string, remindAt: Date[], overrides: Partial<Item> = {}): Item {
  return {
    id,
    kind: "interview",
    title: `Entretien ${id}`,
    why: "Agenda Google",
    dueAt: null,
    remindAt: remindAt.map((d) => d.toISOString()),
    amount: null,
    currency: "EUR",
    status: "active",
    ...overrides,
  };
}

test("keeps only the next 14 days", () => {
  const plan = planReminders(
    [item("a", [new Date(now.getTime() + 2 * day), new Date(now.getTime() + 15 * day)])],
    now,
  );
  expect(plan.map((p) => p.at.toISOString())).toEqual([new Date(now.getTime() + 2 * day).toISOString()]);
});

test("never schedules a past date", () => {
  expect(planReminders([item("a", [new Date(now.getTime() - 60_000)])], now)).toEqual([]);
});

test("skips items that are not active", () => {
  expect(
    planReminders([item("a", [new Date(now.getTime() + day)], { status: "done" })], now),
  ).toEqual([]);
});

test(`caps at ${MAX_SCHEDULED}, soonest first`, () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    item(`i${i}`, [new Date(now.getTime() + (80 - i) * 60_000)]),
  );
  const plan = planReminders(many, now);
  expect(plan).toHaveLength(64);
  expect(plan[0]?.itemId).toBe("i79");
  const times = plan.map((p) => p.at.getTime());
  expect([...times].sort((a, b) => a - b)).toEqual(times);
});

test("body says the amount for bills", () => {
  const [p] = planReminders(
    [
      item("b", [new Date(now.getTime() + day)], {
        kind: "bill",
        title: "Facture EDF",
        amount: 45,
        dueAt: "2026-11-19T23:00:00.000Z",
      }),
    ],
    now,
  );
  expect(p?.title).toBe("Facture EDF");
  expect(p?.body).toBe("45,00 € — échéance 20/11");
});

test("ids are stable per item and time", () => {
  const at = new Date(now.getTime() + day);
  const [p] = planReminders([item("x", [at])], now);
  expect(p?.id).toBe(`x:${at.toISOString()}`);
});
