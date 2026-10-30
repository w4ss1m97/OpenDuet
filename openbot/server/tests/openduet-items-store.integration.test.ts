import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createItemStore } from "../src/openduet/items/store";
import type { ItemCandidate } from "../src/openduet/items/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The item store writes an item once per source, whatever happened to it since, so a dismissed card
 * never comes back, and keeps every person's items and cursors to themselves.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-items-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const store = createItemStore(database);

function candidate(overrides: Partial<ItemCandidate> = {}): ItemCandidate {
  return {
    kind: "bill",
    title: "Facture EDF",
    dueAt: new Date("2026-11-20T08:00:00Z"),
    amount: 45,
    sourceApp: "gmail",
    sourceHash: `gmail:${randomUUID()}`,
    dateExplicit: true,
    ...overrides,
  };
}

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

test("insertIfNew returns the item, then null for the same hash", async () => {
  const c = candidate();
  const first = await store.insertIfNew(owner, c, "active", []);
  expect(first?.title).toBe("Facture EDF");
  expect(first?.amount).toBe(45);
  expect(await store.insertIfNew(owner, c, "active", [])).toBeNull();
});

test("upsert is a no-op for a dismissed sourceHash", async () => {
  const c = candidate({ kind: "idea", title: "Idée: newsletter" });
  const item = await store.insertIfNew(owner, c, "proposed", []);
  if (!item) throw new Error("not inserted");
  await store.setStatus(owner, item.id, "dismissed");
  expect(await store.insertIfNew(owner, c, "proposed", [])).toBeNull();
  const [still] = await store.list(owner, { status: ["dismissed"] });
  expect(still?.id).toBe(item.id);
});

test("list filters by status and remind window", async () => {
  const inside = new Date("2026-12-01T09:00:00Z");
  const outside = new Date("2027-02-01T09:00:00Z");
  const a = await store.insertIfNew(owner, candidate(), "active", [inside]);
  await store.insertIfNew(owner, candidate(), "active", [outside]);
  await store.insertIfNew(owner, candidate(), "proposed", [inside]);
  const found = await store.list(owner, {
    status: ["active"],
    remindFrom: new Date("2026-11-30T00:00:00Z"),
    remindTo: new Date("2026-12-14T00:00:00Z"),
  });
  expect(found.map((item) => item.id)).toEqual([a?.id ?? ""]);
});

test("snooze appends to remindAt", async () => {
  const at = new Date("2026-11-19T09:00:00Z");
  const until = new Date("2026-11-19T10:00:00Z");
  const item = await store.insertIfNew(owner, candidate(), "active", [at]);
  if (!item) throw new Error("not inserted");
  const snoozed = await store.snooze(owner, item.id, until);
  expect(snoozed.remindAt.map((d) => d.toISOString())).toEqual([
    at.toISOString(),
    until.toISOString(),
  ]);
});

test("recordFailure keeps the previous cursor", async () => {
  const at = new Date("2026-11-01T07:00:00Z");
  await store.advanceCursor(owner, "mail", { after: "abc" }, at);
  await store.recordFailure(owner, "mail", "token expired");
  const cursor = await store.getCursor(owner, "mail");
  expect(cursor.lastSuccessAt?.toISOString()).toBe(at.toISOString());
  expect(cursor.cursor).toEqual({ after: "abc" });
});

test("getCursor is empty for a scanner that never ran", async () => {
  expect(await store.getCursor(owner, "notes")).toEqual({
    lastSuccessAt: null,
    cursor: {},
  });
});

test("setStatus on another owner's item throws", async () => {
  const item = await store.insertIfNew(owner, candidate(), "active", []);
  if (!item) throw new Error("not inserted");
  await expect(store.setStatus(other, item.id, "done")).rejects.toThrow();
});

test("countSince counts active and proposed items created after a date", async () => {
  const since = new Date(Date.now() - 1000);
  await store.insertIfNew(other, candidate(), "active", []);
  await store.insertIfNew(other, candidate({ kind: "idea" }), "proposed", []);
  expect(await store.countSince(other, since)).toEqual({ added: 1, proposed: 1 });
});

test("upsertTracked moves an active item and recomputes nothing for a dismissed one", async () => {
  const hash = `gcal:${randomUUID()}`;
  const first = await store.upsertTracked(
    owner,
    candidate({ kind: "interview", title: "Entretien", sourceHash: hash, dueAt: new Date("2026-12-01T09:00:00Z") }),
    "active",
    [new Date("2026-11-30T17:00:00Z")],
  );
  expect(first.inserted).toBe(true);
  const moved = await store.upsertTracked(
    owner,
    candidate({ kind: "interview", title: "Entretien (déplacé)", sourceHash: hash, dueAt: new Date("2026-12-03T09:00:00Z") }),
    "active",
    [new Date("2026-12-02T17:00:00Z")],
  );
  expect(moved.inserted).toBe(false);
  expect(moved.item?.id).toBe(first.item?.id);
  expect(moved.item?.title).toBe("Entretien (déplacé)");
  expect(moved.item?.dueAt?.toISOString()).toBe("2026-12-03T09:00:00.000Z");
  expect(moved.item?.remindAt.map((d) => d.toISOString())).toEqual(["2026-12-02T17:00:00.000Z"]);
  if (!first.item) throw new Error("not inserted");
  await store.setStatus(owner, first.item.id, "dismissed");
  const ignored = await store.upsertTracked(
    owner,
    candidate({ kind: "interview", sourceHash: hash, dueAt: new Date("2026-12-09T09:00:00Z") }),
    "active",
    [],
  );
  expect(ignored).toEqual({ item: null, inserted: false });
});

test("keeping a proposed bill gives it its default reminders", async () => {
  const item = await store.insertIfNew(
    owner,
    candidate({ dueAt: new Date("2099-11-19T23:00:00Z"), amount: undefined }),
    "proposed",
    [],
  );
  if (!item) throw new Error("not inserted");
  const kept = await store.setStatus(owner, item.id, "active", new Date("2099-11-01T00:00:00Z"));
  expect(kept.remindAt.map((d) => d.toISOString())).toEqual([
    "2099-11-17T08:00:00.000Z",
    "2099-11-20T08:00:00.000Z",
  ]);
});
