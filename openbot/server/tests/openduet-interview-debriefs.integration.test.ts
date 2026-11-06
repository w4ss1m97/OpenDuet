import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetInterviewDebriefs } from "../src/db/schema/openduet-interview-debriefs";
import { openduetItems } from "../src/db/schema/openduet-items";
import { openduetMissionEvents, openduetMissions } from "../src/db/schema/openduet-missions";
import { createDebriefStore } from "../src/openduet/missions/debrief-store";
import { MAX_DEBRIEF_ATTEMPTS } from "../src/openduet/missions/debrief";
import { createItemStore } from "../src/openduet/items/store";
import { createMissionStore } from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** One debrief per interview item and per recording: queued once, claimed by one generation, event written once. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-debriefs-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const debriefs = createDebriefStore(database);
const items = createItemStore(database);
const missions = createMissionStore(database);
const content = { summary: "s", positives: ["p"], concerns: ["c"], nextSteps: ["n"], followUpBody: "Bonjour" };
const endedAt = new Date("2026-10-30T10:30:00.000Z");

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

async function interview(who = owner, dueAt = new Date(Date.now() - 48 * 3600_000), status: "active" | "done" | "dismissed" = "active") {
  const row = await items.insertIfNew(
    who,
    { kind: "interview", title: "Entretien", dueAt, sourceApp: "gcal", sourceHash: `gcal:${randomUUID()}`, dateExplicit: true },
    status,
    [],
  );
  return row as NonNullable<typeof row>;
}
async function mission(who = owner) {
  return (await missions.createPiste(who, { company: `Acme ${randomUUID()}`, review: "active", stage: "interview" })).mission;
}
const meeting = () => `m-${randomUUID()}`;
const eventsOf = (missionId: string) =>
  database.select().from(openduetMissionEvents).where(eq(openduetMissionEvents.missionId, missionId));

test("ensurePending is idempotent, restarts for another meeting or mission", async () => {
  const item = await interview();
  const [m1, m2] = [await mission(), await mission()];
  const meet = meeting();
  const first = await debriefs.ensurePending(owner, item.id, m1.id, meet);
  expect(first).toMatchObject({ status: "pending", attempts: 0, missionId: m1.id, anarlogMeetingId: meet });
  const claim = await debriefs.claim(owner, item.id);
  await debriefs.complete(owner, item.id, claim?.claimedAt as Date, content, endedAt);

  expect(await debriefs.ensurePending(owner, item.id, m1.id, meet)).toMatchObject({ id: first?.id, status: "ready", attempts: 1 });

  const newMeet = meeting();
  const moved = await debriefs.ensurePending(owner, item.id, m1.id, newMeet);
  expect(moved).toMatchObject({ id: first?.id, status: "pending", attempts: 0, anarlogMeetingId: newMeet, content: null, claimedAt: null });
  const relinked = await debriefs.ensurePending(owner, item.id, m2.id, newMeet);
  expect(relinked).toMatchObject({ id: first?.id, status: "pending", missionId: m2.id });
  expect(await database.select().from(openduetInterviewDebriefs).where(eq(openduetInterviewDebriefs.itemId, item.id))).toHaveLength(1);
});

test("the same meeting on a second item gives null and does not throw; another owner may reuse the id", async () => {
  const [a, b, c] = [await interview(), await interview(), await interview(other)];
  const m = await mission();
  const meet = meeting();
  expect(await debriefs.ensurePending(owner, a.id, m.id, meet)).not.toBeNull();
  expect(await debriefs.ensurePending(owner, b.id, m.id, meet)).toBeNull();
  expect(await debriefs.getByItem(owner, b.id)).toBeNull();
  expect(await debriefs.ensurePending(other, c.id, (await mission(other)).id, meet)).not.toBeNull();
  expect(await debriefs.listUsedMeetingIds(owner)).toContain(meet);
  expect((await debriefs.listUsedMeetingIds(owner)).size).toBeGreaterThanOrEqual(1);
});

test("two parallel claims: exactly one wins, and a ready debrief cannot be claimed", async () => {
  const item = await interview();
  await debriefs.ensurePending(owner, item.id, (await mission()).id, meeting());
  const results = await Promise.all([debriefs.claim(owner, item.id), debriefs.claim(owner, item.id), debriefs.claim(owner, item.id)]);
  const won = results.filter((r) => r !== null);
  expect(won).toHaveLength(1);
  expect(won[0]?.attempts).toBe(1);
  expect(await debriefs.complete(owner, item.id, won[0]?.claimedAt as Date, content, endedAt)).toBe(true);
  expect(await debriefs.claim(owner, item.id)).toBeNull();
  expect(await debriefs.getByItem(owner, item.id)).toMatchObject({ status: "ready", content });
});

test("a stale claim is taken over and the old holder cannot finish", async () => {
  const item = await interview();
  const m = await mission();
  await debriefs.ensurePending(owner, item.id, m.id, meeting());
  const stale = await debriefs.claim(owner, item.id);
  expect(await debriefs.claim(owner, item.id)).toBeNull();
  await database
    .update(openduetInterviewDebriefs)
    .set({ claimedAt: new Date(Date.now() - 11 * 60_000) })
    .where(eq(openduetInterviewDebriefs.itemId, item.id));
  const taken = await debriefs.claim(owner, item.id);
  expect(taken?.attempts).toBe(2);
  expect(await debriefs.complete(owner, item.id, stale?.claimedAt as Date, content, endedAt)).toBe(false);
  expect(await eventsOf(m.id)).toHaveLength(0);
  expect(await debriefs.fail(owner, item.id, stale?.claimedAt as Date, "X")).toBe(false);
  expect(await debriefs.complete(owner, item.id, taken?.claimedAt as Date, content, endedAt)).toBe(true);
});

test("fail records the error name and attempts stop at the cap until regenerate", async () => {
  const item = await interview();
  await debriefs.ensurePending(owner, item.id, (await mission()).id, meeting());
  for (let attempt = 1; attempt <= MAX_DEBRIEF_ATTEMPTS; attempt += 1) {
    const claim = await debriefs.claim(owner, item.id);
    expect(claim?.attempts).toBe(attempt);
    expect(await debriefs.fail(owner, item.id, claim?.claimedAt as Date, "TimeoutError")).toBe(true);
  }
  expect(await debriefs.getByItem(owner, item.id)).toMatchObject({ status: "failed", lastError: "TimeoutError", claimedAt: null });
  expect(await debriefs.claim(owner, item.id)).toBeNull();
  expect(await debriefs.regenerate(owner, item.id)).toMatchObject({ status: "pending", attempts: 0 });
  expect((await debriefs.claim(owner, item.id))?.attempts).toBe(1);
  expect(await debriefs.regenerate(owner, randomUUID())).toBeNull();
});

test("complete inserts the debrief event once, at the meeting end, even after regenerate", async () => {
  const item = await interview();
  const m = await mission();
  const meet = meeting();
  await debriefs.ensurePending(owner, item.id, m.id, meet);
  const claim = await debriefs.claim(owner, item.id);
  await debriefs.complete(owner, item.id, claim?.claimedAt as Date, content, endedAt);
  expect(await debriefs.complete(owner, item.id, claim?.claimedAt as Date, content, endedAt)).toBe(false);
  await debriefs.regenerate(owner, item.id);
  const again = await debriefs.claim(owner, item.id);
  expect(await debriefs.complete(owner, item.id, again?.claimedAt as Date, { ...content, summary: "v2" }, endedAt)).toBe(true);
  const events = await eventsOf(m.id);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "debrief", source: "app", sourceHash: `anarlog:${meet}`, ownerUserId: owner });
  expect(events[0]?.at.getTime()).toBe(endedAt.getTime());
  expect((await debriefs.getByItem(owner, item.id))?.generatedAt).not.toBeNull();
});

test("another person sees, claims, completes and regenerates nothing of mine", async () => {
  const item = await interview();
  const m = await mission();
  await debriefs.ensurePending(owner, item.id, m.id, meeting());
  expect(await debriefs.getByItem(other, item.id)).toBeNull();
  expect(await debriefs.claim(other, item.id)).toBeNull();
  expect(await debriefs.regenerate(other, item.id)).toBeNull();
  const claim = await debriefs.claim(owner, item.id);
  expect(await debriefs.complete(other, item.id, claim?.claimedAt as Date, content, endedAt)).toBe(false);
  expect(await debriefs.fail(other, item.id, claim?.claimedAt as Date, "X")).toBe(false);
  expect((await debriefs.getByItem(owner, item.id))?.status).toBe("pending");
});

test("deleting the item or the mission deletes the debrief", async () => {
  const [a, b] = [await interview(), await interview()];
  const m = await mission();
  await debriefs.ensurePending(owner, a.id, m.id, meeting());
  await debriefs.ensurePending(owner, b.id, m.id, meeting());
  await database.delete(openduetItems).where(eq(openduetItems.id, a.id));
  expect(await debriefs.getByItem(owner, a.id)).toBeNull();
  await database.delete(openduetMissions).where(eq(openduetMissions.id, m.id));
  expect(await debriefs.getByItem(owner, b.id)).toBeNull();
});

test("listEndedInterviews returns active or done interviews linked to a mission, due in the range", async () => {
  const who = `${prefix}-lister`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const m = await mission(who);
    const h = 3600_000;
    const [inRange, done, unlinked, dismissed, old] = [
      await interview(who, new Date(Date.now() - 6 * h)),
      await interview(who, new Date(Date.now() - 5 * h), "done"),
      await interview(who, new Date(Date.now() - 4 * h)),
      await interview(who, new Date(Date.now() - 3 * h), "dismissed"),
      await interview(who, new Date(Date.now() - 500 * h)),
    ];
    for (const i of [inRange, done, dismissed, old]) await items.setMission(who, i.id, m.id);
    await items.setMission(owner, (await interview()).id, (await mission()).id);
    const found = await items.listEndedInterviews(who, new Date(Date.now() - 200 * h), new Date(Date.now()));
    expect(found.map((i) => i.id)).toEqual([inRange.id, done.id]);
    expect(unlinked.missionId).toBeNull();
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});
