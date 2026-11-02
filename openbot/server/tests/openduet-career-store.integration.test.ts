import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetItems } from "../src/db/schema/openduet-items";
import { openduetOffers } from "../src/db/schema/openduet-job-offers";
import { openduetMissionEvents, openduetMissionRelances, openduetMissions } from "../src/db/schema/openduet-missions";
import { openduetRevisionCards } from "../src/db/schema/openduet-revision";
import { createCareerStore } from "../src/openduet/career/store";
import { parisWeekOf } from "../src/openduet/career/week";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createCareerStore(database);
const prefix = `openduet-career-store-${randomUUID()}`;
const created: string[] = [];
const WEEK = parisWeekOf(new Date("2026-10-28T12:00:00Z"));
const IN = new Date("2026-10-28T10:00:00Z");
const NOW = new Date("2026-11-03T08:00:00Z");

async function person() {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  created.push(id);
  return id;
}

async function seed(owner: string) {
  const mission = async (review: "active" | "dismissed", stage: "applied" | "piste" = "applied") => {
    const id = randomUUID();
    await database.insert(openduetMissions).values({
      id, ownerUserId: owner, company: "Acme", companyKey: id, stage, review, title: "t", createdAt: IN,
    });
    return id;
  };
  const live = await mission("active");
  const dismissed = await mission("dismissed");
  const event = (missionId: string, over: Partial<typeof openduetMissionEvents.$inferInsert>) =>
    database.insert(openduetMissionEvents).values({ id: randomUUID(), missionId, ownerUserId: owner, type: "stage", source: "app", at: IN, ...over });
  await event(live, { fromStage: "piste", toStage: "applied" });
  await event(live, { fromStage: "applied", toStage: "applied" }); // no real move
  await event(dismissed, { fromStage: "piste", toStage: "applied" });
  await event(live, { type: "relance_sent" });
  await database.insert(openduetMissionRelances).values({ id: randomUUID(), missionId: live, ownerUserId: owner, windowStart: IN, body: "b", status: "draft" });
  const offer = (over: Partial<typeof openduetOffers.$inferInsert>) =>
    database.insert(openduetOffers).values({ id: randomUUID(), ownerUserId: owner, dedupKey: randomUUID(), platform: "malt", title: "t", ...over });
  await offer({ createdAt: IN, score: 80, scoredAt: IN });
  await offer({ createdAt: new Date("2026-06-01T00:00:00Z"), scoredAt: new Date("2026-06-01T00:00:00Z") }); // outside both windows
  await database.insert(openduetItems).values({
    id: randomUUID(), ownerUserId: owner, kind: "interview", title: "i", dueAt: IN, sourceApp: "gcal", sourceHash: randomUUID(), status: "active",
  });
  await database.insert(openduetRevisionCards).values({
    id: randomUUID(), ownerUserId: owner, kind: "concept", topic: "x", question: "q", answer: "a", masterHash: "h", dedupKey: randomUUID(), lastReviewedAt: IN,
  });
}

afterAll(async () => {
  if (created.length) await database.delete(users).where(inArray(users.id, created));
});

test("reads only the owner's rows and filters dismissed, no-op moves and out-of-window offers", async () => {
  const a = await person();
  const b = await person();
  await seed(a);
  await seed(b);
  const raw = await store.readWeek(a, WEEK, NOW);
  expect(raw.stageMoves).toEqual([{ toStage: "applied", at: IN }]);
  expect(raw.newMissions).toHaveLength(1);
  expect(raw.relancesSent).toHaveLength(1);
  expect(raw.openMissions).toHaveLength(1);
  expect(raw.relanceDrafts).toBe(1);
  expect(raw.offers).toHaveLength(1);
  expect(raw.interviews).toEqual([{ dueAt: IN, status: "active" }]);
  expect(raw.cards).toHaveLength(1);

  const nobody = await store.readWeek(await person(), WEEK, NOW);
  expect(nobody).toEqual({
    stageMoves: [], newMissions: [], relancesSent: [], openMissions: [], relanceDrafts: 0, offers: [], interviews: [], cards: [],
  });
});
