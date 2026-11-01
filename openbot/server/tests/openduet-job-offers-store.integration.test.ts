import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetOfferSources, openduetOffers, type OfferStatus } from "../src/db/schema/openduet-job-offers";
import { openduetMissions } from "../src/db/schema/openduet-missions";
import { SHOW_THRESHOLD, canTransition } from "../src/openduet/job-offers/status";
import { type NewOffer, createOfferStore } from "../src/openduet/job-offers/store";
import { createMissionStore } from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** Sources and offers: idempotent intake, one claim winner, holder-only results, dedup, owner isolation. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-job-offers-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const store = createOfferStore(database);
const missions = createMissionStore(database);
const NOW = new Date("2026-11-01T10:00:00.000Z");

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

const key = () => `gmail:${randomUUID()}`;
const offer = (over: Partial<NewOffer> = {}): NewOffer => ({
  dedupKey: `c:${randomUUID()}`,
  platform: "malt",
  title: "Dev TypeScript",
  status: "new",
  ...over,
});
async function oneOffer(who = owner, over: Partial<NewOffer> = {}) {
  const [row] = await store.insertOffers(who, null, [offer(over)]);
  return (await store.get(who, row.id))!;
}

test("canTransition covers the whole table", () => {
  const all: OfferStatus[] = ["new", "scored", "shown", "filtered", "dismissed", "applied"];
  const allowed = new Set([
    "new>shown", "new>scored", "new>dismissed", "new>applied",
    "scored>dismissed", "scored>applied",
    "shown>dismissed", "shown>applied",
    "filtered>dismissed", "filtered>applied",
    "dismissed>applied",
  ]);
  for (const from of all) for (const to of all) expect(canTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
  expect(SHOW_THRESHOLD).toBe(75);
});

test("ensureSource is idempotent per key and per owner", async () => {
  const k = key();
  const a = await store.ensureSource(owner, k, "malt", NOW);
  const b = await store.ensureSource(owner, k, "free-work", new Date(NOW.getTime() + 1000));
  expect(b.id).toBe(a.id);
  expect(b).toMatchObject({ platform: "malt", status: "pending", attempts: 0 });
  const c = await store.ensureSource(other, k, "malt", NOW);
  expect(c.id).not.toBe(a.id);
  const pasted = await store.ensureSource(owner, `paste:${randomUUID()}`, "paste", NOW, "texte collé");
  expect(pasted.pasteText).toBe("texte collé");
});

test("parallel claims have one winner and count the attempt", async () => {
  const src = await store.ensureSource(owner, key(), "malt", NOW);
  const results = await Promise.all(Array.from({ length: 5 }, () => store.claimSource(owner, src.id, NOW)));
  const winners = results.filter((r) => r !== null);
  expect(winners).toHaveLength(1);
  expect(winners[0]).toMatchObject({ attempts: 1 });
  expect(winners[0]!.claimedAt).toEqual(NOW);
});

test("a stale claim can be taken again, a fresh one cannot; the old holder is out", async () => {
  const src = await store.ensureSource(owner, key(), "malt", NOW);
  const first = (await store.claimSource(owner, src.id, NOW))!;
  expect(await store.claimSource(owner, src.id, new Date(NOW.getTime() + 9 * 60_000))).toBeNull();
  const later = new Date(NOW.getTime() + 11 * 60_000);
  const second = (await store.claimSource(owner, src.id, later))!;
  expect(second.attempts).toBe(2);
  expect(await store.completeSource(owner, src.id, first.claimedAt!, 2)).toBe(false);
  expect(await store.failSource(owner, src.id, first.claimedAt!, "Err")).toBe(false);
  expect(await store.completeSource(owner, src.id, second.claimedAt!, 2)).toBe(true);
});

test("a source completes, fails to a cap of 3 attempts, or is skipped", async () => {
  const done = await store.ensureSource(owner, key(), "paste", NOW, "texte");
  const c = (await store.claimSource(owner, done.id, NOW))!;
  expect(await store.completeSource(owner, done.id, c.claimedAt!, 3)).toBe(true);
  expect(await store.claimSource(owner, done.id, NOW)).toBeNull();
  expect(await store.listDueSources(owner, NOW)).not.toContainEqual(expect.objectContaining({ id: done.id }));
  const [row] = await database.select().from(openduetOfferSources).where(eq(openduetOfferSources.id, done.id));
  expect(row).toMatchObject({ status: "done", offersFound: 3, pasteText: null, claimedAt: null });

  const flaky = await store.ensureSource(owner, key(), "malt", NOW);
  let t = NOW;
  for (let i = 1; i <= 3; i++) {
    const claim = (await store.claimSource(owner, flaky.id, t))!;
    expect(claim.attempts).toBe(i);
    expect(await store.failSource(owner, flaky.id, claim.claimedAt!, "TypeError")).toBe(true);
    t = new Date(t.getTime() + 1000);
  }
  expect(await store.claimSource(owner, flaky.id, t)).toBeNull();
  const [failed] = await database.select().from(openduetOfferSources).where(eq(openduetOfferSources.id, flaky.id));
  expect(failed).toMatchObject({ status: "failed", lastError: "TypeError" });

  const empty = await store.ensureSource(owner, key(), "malt", NOW);
  const claim = (await store.claimSource(owner, empty.id, NOW))!;
  expect(await store.skipSource(owner, empty.id, claim.claimedAt!)).toBe(true);
  const [skipped] = await database.select().from(openduetOfferSources).where(eq(openduetOfferSources.id, empty.id));
  expect(skipped.status).toBe("skipped");
});

test("listDueSources: pending or failed under 3 attempts, within 14 days, newest first, limited; old ones are skipped", async () => {
  const who = `${prefix}-due`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const day = 24 * 3600_000;
    const s1 = await store.ensureSource(who, key(), "malt", new Date(NOW.getTime() - 3 * day));
    const s2 = await store.ensureSource(who, key(), "malt", new Date(NOW.getTime() - 1 * day));
    const s3 = await store.ensureSource(who, key(), "malt", new Date(NOW.getTime() - 2 * day));
    const old = await store.ensureSource(who, key(), "malt", new Date(NOW.getTime() - 20 * day));
    expect((await store.listDueSources(who, NOW)).map((s) => s.id)).toEqual([s2.id, s3.id, s1.id]);
    expect((await store.listDueSources(who, NOW, 2)).map((s) => s.id)).toEqual([s2.id, s3.id]);
    expect(await store.skipOldSources(who, NOW)).toBe(1);
    const [row] = await database.select().from(openduetOfferSources).where(eq(openduetOfferSources.id, old.id));
    expect(row.status).toBe("skipped");
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});

test("listDueSources never returns pasted sources: paste is handled inline only", async () => {
  const who = `${prefix}-paste-due`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const pasted = await store.ensureSource(who, `paste:${randomUUID()}`, "paste", NOW, "texte collé");
    const mail = await store.ensureSource(who, key(), "malt", new Date(NOW.getTime() - 1000));
    expect((await store.listDueSources(who, NOW, 1)).map((s) => s.id)).toEqual([mail.id]);
    expect((await store.listDueSources(who, NOW)).map((s) => s.id)).not.toContain(pasted.id);
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});

test("insertOffers stores new and filtered offers, and a re-sighting bumps the count but keeps the status", async () => {
  const src = await store.ensureSource(owner, key(), "malt", NOW);
  const dk = `c:${randomUUID()}`;
  const [a, b] = await store.insertOffers(owner, src.id, [
    offer({ dedupKey: dk, tjmMax: 600 }),
    offer({ status: "filtered", filterReason: "low_tjm", tjmUnknown: false }),
  ]);
  expect(a.created).toBe(true);
  expect(await store.get(owner, b.id)).toMatchObject({ status: "filtered", filterReason: "low_tjm", sourceId: src.id });

  const claim = (await store.claimScore(owner, a.id, NOW))!;
  await store.completeScore(owner, a.id, claim.claimedAt!, { score: 90, reasons: ["r"], missingSkills: [], profileHash: "h" });
  await store.dismiss(owner, a.id);
  const [again] = await store.insertOffers(owner, src.id, [offer({ dedupKey: dk, title: "Autre titre" })]);
  expect(again).toMatchObject({ id: a.id, created: false });
  const row = (await store.get(owner, a.id))!;
  expect(row).toMatchObject({ status: "dismissed", seenCount: 2, title: "Dev TypeScript", score: 90 });
  expect(row.lastSeenAt.getTime()).toBeGreaterThan(row.createdAt.getTime() - 1);

  const [mine] = await store.insertOffers(other, null, [offer({ dedupKey: dk })]);
  expect(mine.created).toBe(true);
  expect(mine.id).not.toBe(a.id);
});

test("scoring: parallel claim one winner, stale takeover, holder-only, 75 shows, below scores", async () => {
  const hi = await oneOffer();
  const claims = await Promise.all(Array.from({ length: 4 }, () => store.claimScore(owner, hi.id, NOW)));
  expect(claims.filter((c) => c)).toHaveLength(1);
  const first = claims.find((c) => c)!;
  expect(first.scoreAttempts).toBe(1);
  expect(await store.claimScore(owner, hi.id, new Date(NOW.getTime() + 5 * 60_000))).toBeNull();
  const second = (await store.claimScore(owner, hi.id, new Date(NOW.getTime() + 11 * 60_000)))!;
  expect(second.scoreAttempts).toBe(2);
  const result = { score: 75, reasons: ["a", "b"], missingSkills: ["Rust"], profileHash: "hash1" };
  expect(await store.completeScore(owner, hi.id, first.claimedAt!, result)).toBe(false);
  expect(await store.failScore(owner, hi.id, first.claimedAt!, "Err")).toBe(false);
  expect(await store.completeScore(owner, hi.id, second.claimedAt!, result)).toBe(true);
  expect(await store.get(owner, hi.id)).toMatchObject({
    status: "shown", score: 75, reasons: ["a", "b"], missingSkills: ["Rust"], profileHash: "hash1", claimedAt: null,
  });
  expect((await store.get(owner, hi.id))!.scoredAt).toBeInstanceOf(Date);

  const lo = await oneOffer();
  const c = (await store.claimScore(owner, lo.id, NOW))!;
  await store.completeScore(owner, lo.id, c.claimedAt!, { ...result, score: 74 });
  expect((await store.get(owner, lo.id))!.status).toBe("scored");
});

test("failed scores keep the offer new with no score, and stop being due after 3", async () => {
  const o = await oneOffer();
  let t = NOW;
  for (let i = 1; i <= 3; i++) {
    expect((await store.listDueScores(owner, 100)).map((x) => x.id)).toContain(o.id);
    const c = (await store.claimScore(owner, o.id, t))!;
    expect(await store.failScore(owner, o.id, c.claimedAt!, "TypeError")).toBe(true);
    t = new Date(t.getTime() + 1000);
  }
  expect(await store.claimScore(owner, o.id, t)).toBeNull();
  expect((await store.listDueScores(owner, 100)).map((x) => x.id)).not.toContain(o.id);
  expect(await store.get(owner, o.id)).toMatchObject({ status: "new", score: null, lastError: "TypeError", scoreAttempts: 3 });
});

test("listDueScores: new offers only, newest first, limited", async () => {
  const who = `${prefix}-scores`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const a = await oneOffer(who);
    await new Promise((r) => setTimeout(r, 5));
    const b = await oneOffer(who);
    await oneOffer(who, { status: "filtered", filterReason: "salaried" });
    expect((await store.listDueScores(who, 10)).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(await store.listDueScores(who, 1)).toHaveLength(1);
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});

test("a dismissed offer cannot be scored by a late holder", async () => {
  const o = await oneOffer();
  const c = (await store.claimScore(owner, o.id, NOW))!;
  await store.dismiss(owner, o.id);
  expect(await store.completeScore(owner, o.id, c.claimedAt!, { score: 99, reasons: [], missingSkills: [], profileHash: "h" })).toBe(false);
  expect((await store.get(owner, o.id))!.status).toBe("dismissed");
});

test("list orders by score then recency, filters by status, and isolates owners", async () => {
  const who = `${prefix}-list`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const mk = async (score: number | null) => {
      const o = await oneOffer(who);
      if (score !== null) {
        const c = (await store.claimScore(who, o.id, NOW))!;
        await store.completeScore(who, o.id, c.claimedAt!, { score, reasons: [], missingSkills: [], profileHash: "h" });
      }
      return o.id;
    };
    const low = await mk(40);
    const high = await mk(90);
    const none = await mk(null);
    const filtered = (await oneOffer(who, { status: "filtered", filterReason: "salaried" })).id;
    expect((await store.list(who, { statuses: ["new", "scored", "shown"], limit: 100 })).map((o) => o.id)).toEqual([high, low, none]);
    expect((await store.list(who, { statuses: ["filtered"], limit: 100 })).map((o) => o.id)).toEqual([filtered]);
    expect(await store.list(who, { statuses: ["new", "scored", "shown"], limit: 1 })).toHaveLength(1);
    expect(await store.list(other, { statuses: ["new", "scored", "shown", "filtered"], limit: 100 })).not.toContainEqual(expect.objectContaining({ id: high }));
    expect(await store.get(other, high)).toBeNull();
    expect(await store.dismiss(other, high)).toEqual({ result: "not_found" });
    expect(await store.setApplied(other, high, null)).toBeNull();
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});

test("dismiss and setApplied follow the transitions and are idempotent", async () => {
  const o = await oneOffer();
  expect(await store.dismiss(owner, o.id)).toMatchObject({ result: "ok", offer: { status: "dismissed" } });
  expect(await store.dismiss(owner, o.id)).toMatchObject({ result: "ok", offer: { status: "dismissed" } });

  const { mission } = await missions.createPiste(owner, { company: `Acme ${randomUUID()}`, review: "active", stage: "piste" });
  const applied = await store.setApplied(owner, o.id, mission.id);
  expect(applied).toMatchObject({ status: "applied", missionId: mission.id });
  const { mission: m2 } = await missions.createPiste(owner, { company: `Acme ${randomUUID()}`, review: "active", stage: "piste" });
  expect(await store.setApplied(owner, o.id, m2.id)).toMatchObject({ status: "applied", missionId: mission.id });
  expect(await store.dismiss(owner, o.id)).toEqual({ result: "conflict" });
  expect((await store.get(owner, o.id))!.status).toBe("applied");
});

test("deleting a mission clears the offer's link; deleting the owner removes the rows", async () => {
  const who = `${prefix}-cascade`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  const o = await oneOffer(who);
  const { mission } = await missions.createPiste(who, { company: `Acme ${randomUUID()}`, review: "active", stage: "piste" });
  await store.setApplied(who, o.id, mission.id);
  await database.delete(openduetMissions).where(eq(openduetMissions.id, mission.id));
  expect(await store.get(who, o.id)).toMatchObject({ status: "applied", missionId: null });
  await store.ensureSource(who, key(), "malt", NOW);
  await database.delete(users).where(eq(users.id, who));
  expect(await database.select().from(openduetOffers).where(eq(openduetOffers.ownerUserId, who))).toHaveLength(0);
  expect(await database.select().from(openduetOfferSources).where(eq(openduetOfferSources.ownerUserId, who))).toHaveLength(0);
});

test("topShown: shown only, scored since the cutoff, best first, limited", async () => {
  const who = `${prefix}-top`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const score = async (s: number) => {
      const o = await oneOffer(who);
      const c = (await store.claimScore(who, o.id, NOW))!;
      await store.completeScore(who, o.id, c.claimedAt!, { score: s, reasons: ["x"], missingSkills: [], profileHash: "h" });
      return o.id;
    };
    const a = await score(80);
    const b = await score(95);
    await score(50);
    const stale = await score(99);
    await database.update(openduetOffers).set({ scoredAt: new Date(Date.now() - 30 * 3600_000) }).where(eq(openduetOffers.id, stale));
    const since = new Date(Date.now() - 24 * 3600_000);
    expect((await store.topShown(who, since, 5)).map((o) => o.id)).toEqual([b, a]);
    expect(await store.topShown(who, since, 1)).toHaveLength(1);
    expect(await store.topShown(other, since, 5)).toHaveLength(0);
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});
