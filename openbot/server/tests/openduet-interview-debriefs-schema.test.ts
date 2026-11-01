import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetInterviewDebriefs } from "../src/db/schema/openduet-interview-debriefs";
import { openduetItems } from "../src/db/schema/openduet-items";
import { openduetMissionEvents, openduetMissions } from "../src/db/schema/openduet-missions";
import { createItemStore } from "../src/openduet/items/store";
import { createMissionStore } from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The debrief table's guarantees: no ready row without content, one row per meeting, cascade on delete. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-debriefs-${randomUUID()}`;
const owner = `${prefix}-owner`;
const items = createItemStore(database);
const missions = createMissionStore(database);
const content = { summary: "s", positives: ["p"], concerns: ["c"], nextSteps: ["n"], followUpBody: "b" };

beforeAll(async () => {
  await database.insert(users).values({ id: owner, email: `${owner}@example.test` });
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner]));
});

async function setup() {
  const item = (await items.insertIfNew(
    owner,
    {
      kind: "interview",
      title: "Entretien",
      dueAt: new Date(Date.now() - 3600_000),
      sourceApp: "gcal",
      sourceHash: `gcal:${randomUUID()}`,
      dateExplicit: true,
    },
    "active",
    [],
  )) as NonNullable<Awaited<ReturnType<typeof items.insertIfNew>>>;
  const { mission } = await missions.createPiste(owner, { company: `Acme ${randomUUID()}`, review: "active", stage: "interview" });
  return { item, mission };
}

function row(itemId: string, missionId: string, over: Partial<typeof openduetInterviewDebriefs.$inferInsert> = {}) {
  return { id: randomUUID(), itemId, ownerUserId: owner, missionId, anarlogMeetingId: `m-${randomUUID()}`, status: "pending" as const, ...over };
}

test("a ready debrief without content is rejected", async () => {
  const { item, mission } = await setup();
  await expect((async () => database.insert(openduetInterviewDebriefs).values(row(item.id, mission.id, { status: "ready" })))()).rejects.toThrow();
  await database.insert(openduetInterviewDebriefs).values(row(item.id, mission.id, { status: "ready", content }));
});

test("a second row for the same owner and meeting is rejected", async () => {
  const [a, b] = [await setup(), await setup()];
  const meeting = `m-${randomUUID()}`;
  await database.insert(openduetInterviewDebriefs).values(row(a.item.id, a.mission.id, { anarlogMeetingId: meeting }));
  await expect(
    (async () => database.insert(openduetInterviewDebriefs).values(row(b.item.id, b.mission.id, { anarlogMeetingId: meeting })))(),
  ).rejects.toThrow();
});

test("deleting the mission cascades to its debrief, and a debrief event is accepted", async () => {
  const { item, mission } = await setup();
  await database.insert(openduetInterviewDebriefs).values(row(item.id, mission.id));
  await database.insert(openduetMissionEvents).values({
    id: randomUUID(),
    missionId: mission.id,
    ownerUserId: owner,
    type: "debrief",
    source: "app",
    sourceHash: `anarlog:${randomUUID()}`,
  });
  await database.delete(openduetMissions).where(eq(openduetMissions.id, mission.id));
  expect(await database.select().from(openduetInterviewDebriefs).where(eq(openduetInterviewDebriefs.itemId, item.id))).toHaveLength(0);
  expect(await database.select().from(openduetItems).where(eq(openduetItems.id, item.id))).toHaveLength(1);
});
