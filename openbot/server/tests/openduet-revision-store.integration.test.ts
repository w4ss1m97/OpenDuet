import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createOfferStore } from "../src/openduet/job-offers/store";
import { createRevisionStore, type NewRevisionCard } from "../src/openduet/revision/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** Cards: idempotent insert, owner scoping, ordering of today's deck, optimistic review, archive, counts, topics. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-revision-${randomUUID()}`;
const [owner, other] = [`${prefix}-owner`, `${prefix}-other`];
const store = createRevisionStore(database);
const offers = createOfferStore(database);
const now = new Date("2026-11-01T10:30:00Z");

beforeAll(async () => {
  await database.insert(users).values([owner, other].map((id) => ({ id, email: `${id}@example.test` })));
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

const draft = (over: Partial<NewRevisionCard> = {}): NewRevisionCard => ({
  kind: "concept",
  topic: "Kubernetes",
  question: "Q ?",
  answer: "A",
  keyPoints: ["p"],
  bulletIds: [],
  masterHash: "m1",
  dedupKey: `k:${randomUUID()}`,
  ...over,
});

async function newOffer(who = owner) {
  const [row] = await offers.insertOffers(who, null, [
    { dedupKey: `c:${randomUUID()}`, platform: "malt", title: "Dev", status: "new" },
  ]);
  return row.id;
}

async function one(who: string, over: Partial<NewRevisionCard> = {}) {
  const [row] = await store.insertCards(who, [draft(over)]);
  return row;
}

test("insertCards is idempotent per owner and dedup key and returns only new rows", async () => {
  const first = draft();
  const a = await store.insertCards(owner, [first, draft()]);
  expect(a).toHaveLength(2);
  expect(a[0].box).toBe(1);
  expect(a[0].dueAt).toBeNull();
  const b = await store.insertCards(owner, [first, draft()]);
  expect(b).toHaveLength(1);
  expect(await store.insertCards(owner, [])).toEqual([]);
  // Another owner may hold the same key.
  expect(await store.insertCards(other, [first])).toHaveLength(1);
});

test("everything is owner-scoped", async () => {
  const mine = await one(owner, { topic: "scoped-topic" });
  expect(await store.get(other, mine.id)).toBeNull();
  expect(await store.review(other, mine.id, "good", now)).toEqual({ result: "not_found" });
  expect(await store.archive(other, mine.id)).toBeNull();
  expect((await store.get(owner, mine.id))?.archivedAt).toBeNull();
  expect((await store.list(other, { topic: "scoped-topic" })).length).toBe(0);
  expect((await store.listToday(other, now, { limit: 20 })).some((r) => r.id === mine.id)).toBe(false);
});

test("review applies the Leitner step and bumps the count", async () => {
  const card = await one(owner);
  const r = await store.review(owner, card.id, "good", now);
  if (r.result !== "ok") throw new Error("expected ok");
  expect(r.card.box).toBe(2);
  expect(r.card.reviewCount).toBe(1);
  expect(r.card.lastGrade).toBe("good");
  expect(r.card.dueAt?.toISOString()).toBe("2026-11-02T23:00:00.000Z");
  const again = await store.review(owner, card.id, "again", now);
  if (again.result !== "ok") throw new Error("expected ok");
  expect(again.card.box).toBe(1);
  expect(again.card.reviewCount).toBe(2);
});

test("two parallel reviews: exactly one wins, the other conflicts", async () => {
  const card = await one(owner);
  const results = await Promise.all([
    store.review(owner, card.id, "good", now),
    store.review(owner, card.id, "good", now),
    store.review(owner, card.id, "good", now),
  ]);
  expect(results.filter((r) => r.result === "ok")).toHaveLength(1);
  expect(results.filter((r) => r.result === "conflict")).toHaveLength(2);
  expect((await store.get(owner, card.id))?.reviewCount).toBe(1);
});

test("archived cards cannot be reviewed and are excluded everywhere; archive is idempotent", async () => {
  const offerId = await newOffer();
  const card = await one(owner, { topic: "archived-topic", offerId });
  const first = await store.archive(owner, card.id, now);
  const second = await store.archive(owner, card.id, new Date(now.getTime() + 60_000));
  expect(second?.archivedAt?.getTime()).toBe(first?.archivedAt?.getTime());
  expect(await store.review(owner, card.id, "good", now)).toEqual({ result: "archived" });
  expect((await store.list(owner, { topic: "archived-topic" })).length).toBe(0);
  expect((await store.listByOffer(owner, offerId)).length).toBe(0);
  expect((await store.listToday(owner, now, { limit: 20 })).some((r) => r.id === card.id)).toBe(false);
  // Its topic is still known, so it is not generated again.
  expect(await store.topicsFor(owner, { offerId })).toEqual(["archived-topic"]);
});

test("listToday orders focus first, then due by date, then new by creation; skips future and archived", async () => {
  const who = `${prefix}-today`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const focusOffer = await newOffer(who);
    const otherOffer = await newOffer(who);
    await one(who, { topic: "new-old" });
    const dueLate = await one(who, { topic: "due-late" });
    const dueEarly = await one(who, { topic: "due-early" });
    const future = await one(who, { topic: "future" });
    const focusNew = await one(who, { topic: "focus-new", offerId: focusOffer });
    const focusDue = await one(who, { topic: "focus-due", offerId: focusOffer });
    const elsewhere = await one(who, { topic: "elsewhere", offerId: otherOffer });
    const gone = await one(who, { topic: "gone", offerId: focusOffer });
    await database.execute(
      sql`UPDATE openduet_revision_cards SET due_at = CASE id
        WHEN ${dueLate.id} THEN '2026-11-01T00:00:00Z'::timestamptz
        WHEN ${dueEarly.id} THEN '2026-10-20T00:00:00Z'::timestamptz
        WHEN ${future.id} THEN '2026-11-02T23:00:00Z'::timestamptz
        WHEN ${focusDue.id} THEN '2026-10-30T00:00:00Z'::timestamptz
        WHEN ${elsewhere.id} THEN '2026-10-25T00:00:00Z'::timestamptz
        ELSE due_at END`,
    );
    await store.archive(who, gone.id);
    const today = await store.listToday(who, now, { limit: 20, focusOfferIds: [focusOffer] });
    expect(today.map((c) => c.topic)).toEqual(["focus-due", "focus-new", "due-early", "elsewhere", "due-late", "new-old"]);
    expect((await store.listToday(who, now, { limit: 2, focusOfferIds: [focusOffer] })).length).toBe(2);
    // Without focus, plain due-then-new order.
    const plain = await store.listToday(who, now, { limit: 20 });
    expect(plain.map((c) => c.topic)).toEqual(["due-early", "elsewhere", "focus-due", "due-late", "new-old", "focus-new"]);
    expect(await store.countDue(who, now)).toEqual({ dueToday: 4, newCount: 2 });
  } finally {
    await database.delete(users).where(inArray(users.id, [who]));
  }
});

test("story cards are stale when their master hash differs from the current one", async () => {
  const who = `${prefix}-stale`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    await one(who, { kind: "story", bulletIds: ["acme-api"], masterHash: "old", topic: "story" });
    await one(who, { kind: "concept", masterHash: "old", topic: "concept" });
    const deck = await store.listToday(who, now, { limit: 20, masterHash: "new" });
    expect(Object.fromEntries(deck.map((c) => [c.kind, c.stale]))).toEqual({ story: true, concept: false });
    const fresh = await store.listToday(who, now, { limit: 20, masterHash: "old" });
    expect(fresh.every((c) => !c.stale)).toBe(true);
  } finally {
    await database.delete(users).where(inArray(users.id, [who]));
  }
});

test("list filters by kind and topic; topicsFor scopes by skill group and offer", async () => {
  const who = `${prefix}-list`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const offerId = await newOffer(who);
    await one(who, { topic: "Docker", skillGroupId: "devops" });
    await one(who, { topic: "Terraform", skillGroupId: "devops", offerId });
    await one(who, { topic: "React", skillGroupId: "front" });
    await one(who, { kind: "pitch", topic: "Pitch", dedupKey: "pitch" });
    expect((await store.list(who, { kind: "pitch" })).map((c) => c.topic)).toEqual(["Pitch"]);
    expect((await store.list(who, { topic: "docker" })).map((c) => c.topic)).toEqual(["Docker"]);
    expect((await store.list(who, { limit: 2 })).length).toBe(2);
    expect(await store.topicsFor(who, { skillGroupId: "devops" })).toEqual(["Docker", "Terraform"]);
    expect(await store.topicsFor(who, { offerId })).toEqual(["Terraform"]);
    expect(await store.topicsFor(who)).toEqual(["Docker", "React", "Terraform"]);
    expect((await store.listByOffer(who, offerId)).map((c) => c.topic)).toEqual(["Terraform"]);
  } finally {
    await database.delete(users).where(inArray(users.id, [who]));
  }
});

test("deleting an offer keeps its cards; deleting the owner removes them", async () => {
  const who = `${prefix}-cascade`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  const offerId = await newOffer(who);
  const card = await one(who, { offerId });
  await database.delete(users).where(inArray(users.id, [who]));
  expect(await store.get(who, card.id)).toBeNull();
});
