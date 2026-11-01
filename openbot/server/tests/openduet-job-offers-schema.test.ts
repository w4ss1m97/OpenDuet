import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetMissions } from "../src/db/schema/openduet-missions";
import { openduetOfferSources, openduetOffers } from "../src/db/schema/openduet-job-offers";
import { createMissionStore } from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The offer tables' guarantees: CHECKs on every enum and range, one row per owner and key, cascades. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-job-offers-schema-${randomUUID()}`;
const owner = `${prefix}-owner`;

beforeAll(async () => {
  await database.insert(users).values({ id: owner, email: `${owner}@example.test` });
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner]));
});

const source = (over: Partial<typeof openduetOfferSources.$inferInsert> = {}) => ({
  id: randomUUID(),
  ownerUserId: owner,
  sourceKey: `gmail:${randomUUID()}`,
  platform: "malt" as const,
  receivedAt: new Date(),
  ...over,
});
const offer = (over: Partial<typeof openduetOffers.$inferInsert> = {}) => ({
  id: randomUUID(),
  ownerUserId: owner,
  dedupKey: `c:${randomUUID()}`,
  platform: "malt" as const,
  title: "Dev TypeScript",
  ...over,
});
const rejects = (fn: () => Promise<unknown>) => expect(fn()).rejects.toThrow();

test("source status and counters are checked", async () => {
  await rejects(async () => database.insert(openduetOfferSources).values(source({ status: "bogus" as never })));
  await rejects(async () => database.insert(openduetOfferSources).values(source({ attempts: -1 })));
  await rejects(async () => database.insert(openduetOfferSources).values(source({ offersFound: -1 })));
  const [row] = await database.insert(openduetOfferSources).values(source()).returning();
  expect(row).toMatchObject({ status: "pending", attempts: 0, offersFound: 0, pasteText: null });
});

test("a second source with the same owner and key is rejected", async () => {
  const key = `paste:${randomUUID()}`;
  await database.insert(openduetOfferSources).values(source({ sourceKey: key }));
  await rejects(async () => database.insert(openduetOfferSources).values(source({ sourceKey: key })));
});

test("offer enums and ranges are checked", async () => {
  for (const over of [
    { status: "bogus" },
    { filterReason: "bogus" },
    { rateUnit: "week" },
    { contract: "cdi" },
    { remote: "maybe" },
    { score: 101 },
    { score: -1 },
    { scoreAttempts: -1 },
    { seenCount: 0 },
  ] as Partial<typeof openduetOffers.$inferInsert>[]) {
    await rejects(async () => database.insert(openduetOffers).values(offer(over)));
  }
  const [row] = await database.insert(openduetOffers).values(offer()).returning();
  expect(row).toMatchObject({
    status: "new",
    rateUnit: "unknown",
    contract: "unknown",
    remote: "unknown",
    skills: [],
    reasons: [],
    missingSkills: [],
    seenCount: 1,
    scoreAttempts: 0,
    tjmUnknown: false,
    score: null,
  });
});

test("a second offer with the same owner and dedup key is rejected", async () => {
  const key = `c:${randomUUID()}`;
  await database.insert(openduetOffers).values(offer({ dedupKey: key }));
  await rejects(async () => database.insert(openduetOffers).values(offer({ dedupKey: key })));
});

test("deleting a source or a mission nulls the offer's link; deleting the owner removes everything", async () => {
  const missions = createMissionStore(database);
  const [src] = await database.insert(openduetOfferSources).values(source()).returning();
  const { mission } = await missions.createPiste(owner, { company: `Acme ${randomUUID()}`, review: "active", stage: "piste" });
  const [row] = await database.insert(openduetOffers).values(offer({ sourceId: src.id, missionId: mission.id })).returning();
  await database.delete(openduetOfferSources).where(eq(openduetOfferSources.id, src.id));
  await database.delete(openduetMissions).where(eq(openduetMissions.id, mission.id));
  const [after] = await database.select().from(openduetOffers).where(eq(openduetOffers.id, row.id));
  expect(after).toMatchObject({ sourceId: null, missionId: null });

  const lone = `${prefix}-lone`;
  await database.insert(users).values({ id: lone, email: `${lone}@example.test` });
  await database.insert(openduetOfferSources).values(source({ ownerUserId: lone }));
  await database.insert(openduetOffers).values(offer({ ownerUserId: lone }));
  await database.delete(users).where(eq(users.id, lone));
  expect(await database.select().from(openduetOffers).where(eq(openduetOffers.ownerUserId, lone))).toHaveLength(0);
  expect(await database.select().from(openduetOfferSources).where(eq(openduetOfferSources.ownerUserId, lone))).toHaveLength(0);
});
