import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetCvMasters, openduetCvVersions } from "../src/db/schema/openduet-cv";
import { openduetOffers } from "../src/db/schema/openduet-job-offers";
import { createCvStore } from "../src/openduet/job-offers/cv-store";
import { createOfferStore } from "../src/openduet/job-offers/store";
import { cvMasterFixture } from "./fixtures/cv-master";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** Master and tailored versions: CHECKs, upsert/hash, idempotent ensure, one claim winner, holder-only results. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-cv-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const doomed = `${prefix}-doomed`;
const store = createCvStore(database);
const offers = createOfferStore(database);
const match = { covered: ["typescript"], missing: ["go"] };

beforeAll(async () => {
  await database.insert(users).values(
    [owner, other, doomed].map((id) => ({ id, email: `${id}@example.test` })),
  );
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other, doomed]));
});

async function newOffer(who = owner) {
  const [row] = await offers.insertOffers(who, null, [
    { dedupKey: `c:${randomUUID()}`, platform: "malt", title: "Dev", status: "new" },
  ]);
  return row.id;
}

test("putMaster upserts and hashes the content", async () => {
  expect(await store.getMaster(owner)).toBeNull();
  const first = await store.putMaster(owner, cvMasterFixture);
  expect(first.contentHash).toBe(createHash("sha256").update(JSON.stringify(cvMasterFixture)).digest("hex"));
  const changed = { ...cvMasterFixture, titles: ["Autre titre"] };
  const second = await store.putMaster(owner, changed);
  expect(second.contentHash).not.toBe(first.contentHash);
  expect((await store.getMaster(owner))?.content.titles).toEqual(["Autre titre"]);
  const rows = await database.select().from(openduetCvMasters).where(eq(openduetCvMasters.ownerUserId, owner));
  expect(rows).toHaveLength(1);
  expect(await store.getMaster(other)).toBeNull();
});

test("ensureVersion is idempotent and owner-filtered", async () => {
  const offerId = await newOffer();
  const a = await store.ensureVersion(owner, offerId);
  const b = await store.ensureVersion(owner, offerId);
  expect(a?.id).toBe(b?.id);
  expect(a?.status).toBe("pending");
  expect(await store.ensureVersion(other, offerId)).toBeNull();
  expect(await store.getVersion(other, offerId)).toBeNull();
  expect((await store.getVersion(owner, offerId))?.id).toBe(a?.id);
});

test("the CHECKs reject a bad status and a ready version without content", async () => {
  const offerId = await newOffer();
  const v = (await store.ensureVersion(owner, offerId))!;
  await expect(
    (async () => database.update(openduetCvVersions).set({ status: "bogus" as never }).where(eq(openduetCvVersions.id, v.id)))(),
  ).rejects.toThrow();
  await expect(
    (async () => database.update(openduetCvVersions).set({ status: "ready" }).where(eq(openduetCvVersions.id, v.id)))(),
  ).rejects.toThrow();
});

test("parallel claims have one winner; only the holder completes", async () => {
  const offerId = await newOffer();
  await store.ensureVersion(owner, offerId);
  const claims = await Promise.all(
    Array.from({ length: 5 }, () => store.claimVersion(owner, offerId, { regenerate: false })),
  );
  const winners = claims.filter((c) => c !== null);
  expect(winners).toHaveLength(1);
  const claimedAt = winners[0]!.claimedAt!;
  expect(await store.completeVersion(owner, offerId, new Date(claimedAt.getTime() + 1), cvMasterFixture, match, "h")).toBe(false);
  expect(await store.failVersion(owner, offerId, new Date(claimedAt.getTime() + 1), "Err")).toBe(false);
  expect(await store.completeVersion(other, offerId, claimedAt, cvMasterFixture, match, "h")).toBe(false);
  expect(await store.completeVersion(owner, offerId, claimedAt, cvMasterFixture, match, "hash1")).toBe(true);
  const done = (await store.getVersion(owner, offerId))!;
  expect(done.status).toBe("ready");
  expect(done.masterHash).toBe("hash1");
  expect(done.claimedAt).toBeNull();
  expect(done.generatedAt).not.toBeNull();
  expect(done.match).toEqual(match);
});

test("ready needs regenerate to be claimed again; another owner gets null", async () => {
  const offerId = await newOffer();
  await store.ensureVersion(owner, offerId);
  const c = (await store.claimVersion(owner, offerId, { regenerate: false }))!;
  await store.completeVersion(owner, offerId, c.claimedAt!, cvMasterFixture, match, "h");
  expect(await store.claimVersion(owner, offerId, { regenerate: false })).toBeNull();
  expect(await store.claimVersion(other, offerId, { regenerate: true })).toBeNull();
  const again = await store.claimVersion(owner, offerId, { regenerate: true });
  expect(again?.claimedAt).not.toBeNull();
});

test("a failed version can be claimed again; the error is the name only", async () => {
  const offerId = await newOffer();
  await store.ensureVersion(owner, offerId);
  const c = (await store.claimVersion(owner, offerId, { regenerate: false }))!;
  expect(await store.failVersion(owner, offerId, c.claimedAt!, "TypeError")).toBe(true);
  const failed = (await store.getVersion(owner, offerId))!;
  expect(failed.status).toBe("failed");
  expect(failed.lastError).toBe("TypeError");
  expect(await store.claimVersion(owner, offerId, { regenerate: false })).not.toBeNull();
});

test("a stale claim can be taken again, a fresh one cannot", async () => {
  const offerId = await newOffer();
  await store.ensureVersion(owner, offerId);
  const first = (await store.claimVersion(owner, offerId, { regenerate: false }))!;
  expect(await store.claimVersion(owner, offerId, { regenerate: false })).toBeNull();
  const later = new Date(first.claimedAt!.getTime() + 11 * 60 * 1000);
  const second = await store.claimVersion(owner, offerId, { regenerate: false }, later);
  expect(second?.claimedAt?.getTime()).toBe(later.getTime());
  // the first holder lost its claim
  expect(await store.completeVersion(owner, offerId, first.claimedAt!, cvMasterFixture, match, "h")).toBe(false);
});

test("deleting the offer, then the user, cascades", async () => {
  const offerId = await newOffer(doomed);
  await store.ensureVersion(doomed, offerId);
  await store.putMaster(doomed, cvMasterFixture);
  await database.delete(openduetOffers).where(eq(openduetOffers.id, offerId));
  expect(await store.getVersion(doomed, offerId)).toBeNull();
  const second = await newOffer(doomed);
  await store.ensureVersion(doomed, second);
  await database.delete(users).where(eq(users.id, doomed));
  expect(await database.select().from(openduetCvVersions).where(eq(openduetCvVersions.ownerUserId, doomed))).toHaveLength(0);
  expect(await database.select().from(openduetCvMasters).where(eq(openduetCvMasters.ownerUserId, doomed))).toHaveLength(0);
});
