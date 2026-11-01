import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetOffers } from "../src/db/schema/openduet-job-offers";
import { openduetRevisionCards } from "../src/db/schema/openduet-revision";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The card table's guarantees: CHECKs on enums, ranges and story bullets, one row per owner and key, cascades. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-revision-schema-${randomUUID()}`;
const owner = `${prefix}-owner`;
const doomed = `${prefix}-doomed`;

beforeAll(async () => {
  await database.insert(users).values([owner, doomed].map((id) => ({ id, email: `${id}@example.test` })));
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, doomed]));
});

const card = (over: Partial<typeof openduetRevisionCards.$inferInsert> = {}) => ({
  id: randomUUID(),
  ownerUserId: owner,
  kind: "concept" as const,
  topic: "Kubernetes",
  question: "Q ?",
  answer: "A",
  masterHash: "h",
  dedupKey: `k:${randomUUID()}`,
  ...over,
});

test("defaults: box 1, never reviewed, no due date, empty arrays", async () => {
  const [row] = await database.insert(openduetRevisionCards).values(card()).returning();
  expect(row.box).toBe(1);
  expect(row.dueAt).toBeNull();
  expect(row.reviewCount).toBe(0);
  expect(row.keyPoints).toEqual([]);
  expect(row.bulletIds).toEqual([]);
  expect(row.lastGrade).toBeNull();
  expect(row.archivedAt).toBeNull();
});

test("CHECKs reject a bad kind, box, review count and grade", async () => {
  const insert = (over: Partial<typeof openduetRevisionCards.$inferInsert>) =>
    Promise.resolve(database.insert(openduetRevisionCards).values(card(over)).execute());
  await expect(insert({ kind: "quiz" as never })).rejects.toThrow();
  await expect(insert({ box: 0 })).rejects.toThrow();
  await expect(insert({ box: 6 })).rejects.toThrow();
  await expect(insert({ reviewCount: -1 })).rejects.toThrow();
  await expect(insert({ lastGrade: "easy" as never })).rejects.toThrow();
  await insert({ box: 5, lastGrade: "good" });
});

test("a story card needs at least one bullet id", async () => {
  const insert = (over: Partial<typeof openduetRevisionCards.$inferInsert>) =>
    Promise.resolve(database.insert(openduetRevisionCards).values(card(over)).execute());
  await expect(insert({ kind: "story", bulletIds: [] })).rejects.toThrow();
  await insert({ kind: "story", bulletIds: ["acme-api"] });
  await insert({ kind: "pitch", bulletIds: [] });
});

test("one card per owner and dedup key", async () => {
  const dedupKey = `k:${randomUUID()}`;
  await database.insert(openduetRevisionCards).values(card({ dedupKey }));
  await expect(Promise.resolve(database.insert(openduetRevisionCards).values(card({ dedupKey })).execute())).rejects.toThrow();
});

test("deleting the owner cascades; deleting an offer only unlinks the card", async () => {
  const offerId = randomUUID();
  await database.insert(openduetOffers).values({
    id: offerId,
    ownerUserId: owner,
    dedupKey: `c:${randomUUID()}`,
    platform: "malt",
    title: "Dev",
  });
  const [row] = await database.insert(openduetRevisionCards).values(card({ offerId })).returning();
  await database.delete(openduetOffers).where(eq(openduetOffers.id, offerId));
  const [after] = await database.select().from(openduetRevisionCards).where(eq(openduetRevisionCards.id, row.id));
  expect(after.offerId).toBeNull();

  await database.insert(openduetRevisionCards).values(card({ ownerUserId: doomed }));
  await database.delete(users).where(eq(users.id, doomed));
  const left = await database.select().from(openduetRevisionCards).where(eq(openduetRevisionCards.ownerUserId, doomed));
  expect(left).toHaveLength(0);
});
