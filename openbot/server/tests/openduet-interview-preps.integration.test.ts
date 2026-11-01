import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetInterviewPreps } from "../src/db/schema/openduet-interview-preps";
import { openduetMissions } from "../src/db/schema/openduet-missions";
import { openduetItems } from "../src/db/schema/openduet-items";
import { ItemKindError, ItemNotFoundError, createItemStore } from "../src/openduet/items/store";
import { MAX_PREP_ATTEMPTS } from "../src/openduet/missions/prep";
import { createPrepStore } from "../src/openduet/missions/prep-store";
import { createMissionStore } from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * One sheet per interview item: queued once, claimed by one generation at a time, restarted when the
 * item's mission changes, and never visible to another person.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-preps-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const preps = createPrepStore(database);
const items = createItemStore(database);
const missions = createMissionStore(database);
const content = { pitch: "p", likelyQuestions: ["q"], questionsToAsk: ["a"] };

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

async function interview(who = owner, over: { kind?: "interview" | "bill"; dueInHours?: number; status?: "active" | "dismissed" } = {}) {
  const row = await items.insertIfNew(
    who,
    {
      kind: over.kind ?? "interview",
      title: "Entretien",
      dueAt: new Date(Date.now() + (over.dueInHours ?? 24) * 3600_000),
      sourceApp: "gcal",
      sourceHash: `gcal:${randomUUID()}`,
      dateExplicit: true,
    },
    over.status ?? "active",
    [],
  );
  return row as NonNullable<typeof row>;
}
async function mission(who = owner) {
  return (await missions.createPiste(who, { company: `Acme ${randomUUID()}`, review: "active", stage: "interview" })).mission;
}

test("ensurePending is idempotent for the same mission and restarts for another one", async () => {
  const item = await interview();
  const [m1, m2] = [await mission(), await mission()];
  const first = await preps.ensurePending(owner, item.id, m1.id);
  expect(first).toMatchObject({ status: "pending", attempts: 0, missionId: m1.id });
  const claim = await preps.claim(owner, item.id);
  expect(claim?.attempts).toBe(1);
  await preps.complete(owner, item.id, claim?.claimedAt as Date, content);

  const again = await preps.ensurePending(owner, item.id, m1.id);
  expect(again).toMatchObject({ id: first.id, status: "ready", attempts: 1 });

  const moved = await preps.ensurePending(owner, item.id, m2.id);
  expect(moved).toMatchObject({ id: first.id, status: "pending", attempts: 0, missionId: m2.id, content: null, claimedAt: null });
  expect(await database.select().from(openduetInterviewPreps).where(eq(openduetInterviewPreps.itemId, item.id))).toHaveLength(1);
});

test("two parallel claims: exactly one wins, and a ready sheet cannot be claimed", async () => {
  const item = await interview();
  await preps.ensurePending(owner, item.id, (await mission()).id);
  const results = await Promise.all([preps.claim(owner, item.id), preps.claim(owner, item.id), preps.claim(owner, item.id)]);
  const won = results.filter((r) => r !== null);
  expect(won).toHaveLength(1);
  expect(won[0]?.attempts).toBe(1);
  await preps.complete(owner, item.id, won[0]?.claimedAt as Date, content);
  expect(await preps.claim(owner, item.id)).toBeNull();
});

test("a claim older than ten minutes is taken over, a fresh one is not, and the old holder cannot finish", async () => {
  const item = await interview();
  await preps.ensurePending(owner, item.id, (await mission()).id);
  const stale = await preps.claim(owner, item.id);
  expect(await preps.claim(owner, item.id)).toBeNull();
  await database
    .update(openduetInterviewPreps)
    .set({ claimedAt: new Date(Date.now() - 11 * 60_000) })
    .where(eq(openduetInterviewPreps.itemId, item.id));
  const taken = await preps.claim(owner, item.id);
  expect(taken?.attempts).toBe(2);
  expect(await preps.complete(owner, item.id, stale?.claimedAt as Date, content)).toBe(false);
  expect(await preps.complete(owner, item.id, taken?.claimedAt as Date, content)).toBe(true);
  expect(await preps.getByItem(owner, item.id)).toMatchObject({ status: "ready", content, lastError: null });
});

test("fail records the error name, releases the claim, and attempts stop at the cap", async () => {
  const item = await interview();
  await preps.ensurePending(owner, item.id, (await mission()).id);
  for (let attempt = 1; attempt <= MAX_PREP_ATTEMPTS; attempt += 1) {
    const claim = await preps.claim(owner, item.id);
    expect(claim?.attempts).toBe(attempt);
    expect(await preps.fail(owner, item.id, claim?.claimedAt as Date, "TimeoutError")).toBe(true);
  }
  expect(await preps.getByItem(owner, item.id)).toMatchObject({ status: "failed", lastError: "TimeoutError", claimedAt: null });
  expect(await preps.claim(owner, item.id)).toBeNull();
  const again = await preps.regenerate(owner, item.id);
  expect(again).toMatchObject({ status: "pending", attempts: 0 });
  expect((await preps.claim(owner, item.id))?.attempts).toBe(1);
});

test("regenerate keeps the old content visible and is null for an unknown item", async () => {
  const item = await interview();
  await preps.ensurePending(owner, item.id, (await mission()).id);
  const claim = await preps.claim(owner, item.id);
  await preps.complete(owner, item.id, claim?.claimedAt as Date, content);
  const again = await preps.regenerate(owner, item.id);
  expect(again).toMatchObject({ status: "pending", attempts: 0, content });
  expect(await preps.regenerate(owner, randomUUID())).toBeNull();
});

test("the ready CHECK refuses a ready sheet without content", async () => {
  const item = await interview();
  await preps.ensurePending(owner, item.id, (await mission()).id);
  await expect(
    (async () => {
      await database.update(openduetInterviewPreps).set({ status: "ready" }).where(eq(openduetInterviewPreps.itemId, item.id));
    })(),
  ).rejects.toThrow();
});

test("listByMission returns the sheets of that mission, soonest interview first", async () => {
  const m = await mission();
  const [a, b] = [await interview(owner, { dueInHours: 48 }), await interview(owner, { dueInHours: 10 })];
  await items.setMission(owner, a.id, m.id);
  await items.setMission(owner, b.id, m.id);
  await preps.ensurePending(owner, a.id, m.id);
  await preps.ensurePending(owner, b.id, m.id);
  const listed = await preps.listByMission(owner, m.id);
  expect(listed.map((p) => p.itemId)).toEqual([b.id, a.id]);
});

test("another person sees, claims, completes and regenerates nothing of mine", async () => {
  const item = await interview();
  const m = await mission();
  await preps.ensurePending(owner, item.id, m.id);
  expect(await preps.getByItem(other, item.id)).toBeNull();
  expect(await preps.listByMission(other, m.id)).toEqual([]);
  expect(await preps.claim(other, item.id)).toBeNull();
  expect(await preps.regenerate(other, item.id)).toBeNull();
  const claim = await preps.claim(owner, item.id);
  expect(await preps.complete(other, item.id, claim?.claimedAt as Date, content)).toBe(false);
  expect(await preps.fail(other, item.id, claim?.claimedAt as Date, "X")).toBe(false);
  expect((await preps.getByItem(owner, item.id))?.status).toBe("pending");
});

test("deleting the item or the mission deletes the sheet", async () => {
  const [a, b] = [await interview(), await interview()];
  const m = await mission();
  await preps.ensurePending(owner, a.id, m.id);
  await preps.ensurePending(owner, b.id, m.id);
  await database.delete(openduetItems).where(eq(openduetItems.id, a.id));
  expect(await preps.getByItem(owner, a.id)).toBeNull();
  await database.delete(openduetMissions).where(eq(openduetMissions.id, m.id));
  expect(await preps.getByItem(owner, b.id)).toBeNull();
});

test("item store: get and setMission are owner-filtered, the mission link only fits interviews and follow-ups", async () => {
  const item = await interview();
  const bill = await interview(owner, { kind: "bill" });
  const m = await mission();
  expect((await items.get(owner, item.id)).id).toBe(item.id);
  await expect(items.get(other, item.id)).rejects.toThrow(ItemNotFoundError);
  await expect(items.setMission(other, item.id, m.id)).rejects.toThrow(ItemNotFoundError);
  await expect(items.setMission(owner, bill.id, m.id)).rejects.toThrow(ItemKindError);
  expect((await items.setMission(owner, item.id, m.id)).missionId).toBe(m.id);
  const m2 = await mission();
  expect((await items.setMission(owner, item.id, m2.id)).missionId).toBe(m2.id);
  expect((await items.setMission(owner, item.id, null)).missionId).toBeNull();
});

test("listUpcomingInterviews returns this person's active interviews due in the window, soonest first", async () => {
  const who = `${prefix}-lister`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const [late, soon] = [await interview(who, { dueInHours: 40 }), await interview(who, { dueInHours: 5 })];
    await interview(who, { dueInHours: 200 });
    await interview(who, { dueInHours: 6, status: "dismissed" });
    await interview(who, { kind: "bill", dueInHours: 6 });
    await interview(owner, { dueInHours: 7 });
    const found = await items.listUpcomingInterviews(who, new Date(), new Date(Date.now() + 72 * 3600_000));
    expect(found.map((i) => i.id)).toEqual([soon.id, late.id]);
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});
