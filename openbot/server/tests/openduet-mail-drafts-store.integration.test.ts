import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetMailDrafts } from "../src/db/schema/openduet-mail-drafts";
import { openduetMissionRelances } from "../src/db/schema/openduet-missions";
import { createMailDraftStore } from "../src/openduet/mail-drafts/store";
import { createOfferStore } from "../src/openduet/job-offers/store";
import { createMissionStore } from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** Mail drafts: CHECKs, idempotent create, patch only while draft, one claim winner, holder-only results, cascades. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-mail-drafts-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const store = createMailDraftStore(database);
const missions = createMissionStore(database);
const offers = createOfferStore(database);

beforeAll(async () => {
  await database.insert(users).values([owner, other].map((id) => ({ id, email: `${id}@example.test` })));
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

async function newMission(who = owner) {
  const { mission } = await missions.createPiste(who, { company: `Acme ${randomUUID()}`, role: "Dev", review: "active" });
  return mission;
}
async function newRelance(missionId: string, who = owner) {
  const id = randomUUID();
  await database.insert(openduetMissionRelances).values({ id, missionId, ownerUserId: who, windowStart: new Date(), body: "Bonjour", status: "draft" });
  return id;
}
async function newOffer(who = owner) {
  const [row] = await offers.insertOffers(who, null, [{ dedupKey: `c:${randomUUID()}`, platform: "malt", title: "Dev", status: "new" }]);
  return row.id;
}
const base = { to: ["a@x.com"], cc: [], subject: "Relance", body: "Bonjour" };

test("create is idempotent per relance and per offer while a draft is live", async () => {
  const mission = await newMission();
  const relanceId = await newRelance(mission.id);
  const a = await store.createDraft(owner, { ...base, kind: "relance", missionId: mission.id, relanceId });
  const b = await store.createDraft(owner, { ...base, kind: "relance", missionId: mission.id, relanceId, subject: "Autre" });
  expect(a.created).toBe(true);
  expect(b.created).toBe(false);
  expect(b.draft.id).toBe(a.draft.id);

  const offerId = await newOffer();
  const pdf = Buffer.from("%PDF-1.4 x");
  const c = await store.createDraft(owner, { ...base, kind: "application", offerId, attachmentPdf: pdf, attachmentName: "CV.pdf" });
  const e = await store.createDraft(owner, { ...base, kind: "application", offerId });
  expect(e.created).toBe(false);
  expect(e.draft.id).toBe(c.draft.id);
  expect(Buffer.from(c.draft.attachmentPdf!).equals(pdf)).toBe(true);

  // Once dismissed, a new one may be made.
  await store.dismissDraft(owner, c.draft.id);
  expect((await store.createDraft(owner, { ...base, kind: "application", offerId })).created).toBe(true);
});

test("the CHECKs reject a relance without mission, an application without offer, and pushed without ids", async () => {
  await expect((async () => database.insert(openduetMailDrafts).values({ id: randomUUID(), ownerUserId: owner, kind: "relance", subject: "s", body: "b" }))()).rejects.toThrow();
  await expect((async () => database.insert(openduetMailDrafts).values({ id: randomUUID(), ownerUserId: owner, kind: "application", subject: "s", body: "b" }))()).rejects.toThrow();
  await expect((async () => database.insert(openduetMailDrafts).values({ id: randomUUID(), ownerUserId: owner, kind: "bogus" as never, subject: "s", body: "b" }))()).rejects.toThrow();
  const offerId = await newOffer();
  const { draft } = await store.createDraft(owner, { ...base, kind: "application", offerId });
  await expect((async () => database.update(openduetMailDrafts).set({ status: "pushed" }).where(eq(openduetMailDrafts.id, draft.id)))()).rejects.toThrow();
});

test("patch works only while a draft that nobody holds; other owner is not found", async () => {
  const { draft } = await store.createDraft(owner, { ...base, kind: "application", offerId: await newOffer() });
  const ok = await store.patchDraft(owner, draft.id, { subject: "Nouveau", to: ["b@x.com"] });
  expect(ok.ok && ok.draft.subject).toBe("Nouveau");
  expect(ok.ok && ok.draft.toAddrs).toEqual(["b@x.com"]);
  expect(await store.patchDraft(other, draft.id, { subject: "x" })).toEqual({ ok: false, reason: "not_found" });

  const claim = await store.claimPush(owner, draft.id);
  expect(await store.patchDraft(owner, draft.id, { subject: "x" })).toEqual({ ok: false, reason: "conflict" });
  await store.completePush(owner, draft.id, claim!.claimedAt!, "r1");
  expect(await store.patchDraft(owner, draft.id, { subject: "x" })).toEqual({ ok: false, reason: "conflict" });
});

test("parallel claims have one winner; a stale claim can be retaken; only the holder completes", async () => {
  const { draft } = await store.createDraft(owner, { ...base, kind: "application", offerId: await newOffer() });
  const claims = await Promise.all(Array.from({ length: 5 }, () => store.claimPush(owner, draft.id)));
  const winners = claims.filter(Boolean);
  expect(winners).toHaveLength(1);
  const held = winners[0]!.claimedAt!;

  expect(await store.claimPush(owner, draft.id)).toBeNull();
  const later = new Date(held.getTime() + 11 * 60 * 1000);
  const retaken = await store.claimPush(owner, draft.id, later);
  expect(retaken?.claimedAt?.getTime()).toBe(later.getTime());

  // The first holder lost the claim: its result is ignored.
  expect(await store.completePush(owner, draft.id, held, "old")).toBe(false);
  expect(await store.releasePush(owner, draft.id, held, "x")).toBe(false);
  expect((await store.getDraft(owner, draft.id))?.status).toBe("draft");

  expect(await store.completePush(owner, draft.id, later, "gmail-1")).toBe(true);
  const done = await store.getDraft(owner, draft.id);
  expect(done).toMatchObject({ status: "pushed", gmailDraftId: "gmail-1", claimedAt: null });
  expect(done?.pushedAt).toBeInstanceOf(Date);
  expect(await store.claimPush(owner, draft.id)).toBeNull();
  expect(await store.dismissDraft(owner, draft.id)).toBeNull();
});

test("release gives the claim back with the error; another owner sees nothing", async () => {
  const { draft } = await store.createDraft(owner, { ...base, kind: "application", offerId: await newOffer() });
  expect(await store.claimPush(other, draft.id)).toBeNull();
  const claim = await store.claimPush(owner, draft.id);
  expect(await store.releasePush(owner, draft.id, claim!.claimedAt!, "boom")).toBe(true);
  expect(await store.getDraft(owner, draft.id)).toMatchObject({ claimedAt: null, lastError: "boom" });
  expect(await store.getDraft(other, draft.id)).toBeNull();
  expect(await store.listDrafts(other)).toEqual([]);
  expect((await store.listDrafts(owner, "draft")).some((row) => row.id === draft.id)).toBe(true);
  expect(await store.dismissDraft(other, draft.id)).toBeNull();
  expect((await store.dismissDraft(owner, draft.id))?.status).toBe("dismissed");
});

test("deleting the mission removes its drafts; deleting the relance keeps the draft", async () => {
  const mission = await newMission();
  const relanceId = await newRelance(mission.id);
  const { draft } = await store.createDraft(owner, { ...base, kind: "relance", missionId: mission.id, relanceId });
  await database.delete(openduetMissionRelances).where(eq(openduetMissionRelances.id, relanceId));
  expect((await store.getDraft(owner, draft.id))?.relanceId).toBeNull();
  const { openduetMissions } = await import("../src/db/schema/openduet-missions");
  await database.delete(openduetMissions).where(eq(openduetMissions.id, mission.id));
  expect(await store.getDraft(owner, draft.id)).toBeNull();
});
