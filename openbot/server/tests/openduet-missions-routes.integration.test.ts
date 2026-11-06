import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetMissions } from "../src/db/schema/openduet-missions";
import { createItemStore } from "../src/openduet/items/store";
import { createPrepStore } from "../src/openduet/missions/prep-store";
import { createMissionRoutes } from "../src/openduet/missions/routes";
import { createMissionStore } from "../src/openduet/missions/store";
import { loadBriefMissions } from "../src/openduet/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The app reads and changes only its own person's missions; an illegal move is a conflict. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-missions-routes-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const store = createMissionStore(database);

const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
  const actor = context.req.header("x-test-actor");
  if (!actor) return context.json({ error: "Sign in." }, 401);
  context.set("actor", { id: actor } as AppVariables["actor"]);
  await next();
};
const app = new Hono().route("/api/openduet/missions", createMissionRoutes(store, asActor, createPrepStore(database)));

function request(actor: string | null, path: string, method = "GET", body?: unknown) {
  return app.request(`/api/openduet/missions${path}`, {
    method,
    headers: { ...(actor ? { "x-test-actor": actor } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const tag = () => randomUUID().replace(/-/g, "").slice(0, 8);
const make = async (who: string, over: Partial<Parameters<typeof store.createPiste>[1]> = {}) =>
  (await store.createPiste(who, { company: `Acme${tag()}`, review: "active", stage: "applied", ...over })).mission;

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

test("needs a signed-in person", async () => {
  expect((await request(null, "")).status).toBe(401);
});

test("GET lists only the caller's missions, filtered by stage and review", async () => {
  const mine = await make(owner);
  const proposed = await make(owner, { review: "proposed", stage: "piste" });
  const theirs = await make(other);
  const all = (await (await request(owner, "")).json()) as { missions: { id: string }[] };
  const ids = all.missions.map((m) => m.id);
  expect(ids).toContain(mine.id);
  expect(ids).not.toContain(theirs.id);
  const only = (await (await request(owner, "?review=proposed")).json()) as { missions: { id: string }[] };
  expect(only.missions.map((m) => m.id)).toEqual([proposed.id]);
  expect((await request(owner, "?stage=nonsense")).status).toBe(400);
});

test("GET /:id returns the mission and its relances; another person's is a 404", async () => {
  const mission = await make(owner);
  const ok = await request(owner, `/${mission.id}`);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ mission: { id: mission.id }, relances: [] });
  expect((await request(other, `/${mission.id}`)).status).toBe(404);
  expect((await request(owner, `/${randomUUID()}`)).status).toBe(404);
});

test("PATCH stage moves forward, and an illegal move is a 409 that changes nothing", async () => {
  const mission = await make(owner);
  const moved = await request(owner, `/${mission.id}`, "PATCH", { stage: "interview" });
  expect(moved.status).toBe(200);
  expect(await moved.json()).toMatchObject({ mission: { stage: "interview" } });
  const back = await request(owner, `/${mission.id}`, "PATCH", { stage: "applied" });
  expect(back.status).toBe(409);
  expect((await store.get(owner, mission.id)).stage).toBe("interview");
});

test("PATCH of another person's mission is a 404, and so is merging into theirs", async () => {
  const mine = await make(owner);
  const theirs = await make(other);
  expect((await request(owner, `/${theirs.id}`, "PATCH", { stage: "talking" })).status).toBe(404);
  expect((await request(owner, `/${mine.id}`, "PATCH", { mergeInto: theirs.id })).status).toBe(404);
  expect((await store.get(owner, mine.id)).review).toBe("active");
});

test("PATCH review, company, role and contactEmail", async () => {
  const mission = await make(owner, { review: "proposed", stage: "piste" });
  const company = `Renamed${tag()}`;
  const res = await request(owner, `/${mission.id}`, "PATCH", {
    review: "active",
    company,
    role: "Lead",
    contactEmail: "RH@Acme.test",
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    mission: { review: "active", company, role: "Lead", contactEmails: ["rh@acme.test"] },
  });
  expect((await request(owner, `/${mission.id}`, "PATCH", { stage: "bogus" })).status).toBe(400);
});

test("PATCH mergeInto moves threads and contacts into the other mission and dismisses the piste", async () => {
  const target = await make(owner, { threadId: "thread-target" });
  const piste = await make(owner, { review: "proposed", stage: "piste", threadId: "thread-piste", contactEmail: "a@b.test" });
  const res = await request(owner, `/${piste.id}`, "PATCH", { mergeInto: target.id });
  expect(res.status).toBe(200);
  const merged = (await res.json()) as { mission: { id: string; threadIds: string[]; contactEmails: string[] } };
  expect(merged.mission.id).toBe(target.id);
  expect(merged.mission.threadIds.sort()).toEqual(["thread-piste", "thread-target"]);
  expect(merged.mission.contactEmails).toEqual(["a@b.test"]);
  const [gone] = await database.select().from(openduetMissions).where(eq(openduetMissions.id, piste.id));
  expect(gone?.review).toBe("dismissed");
  expect((await request(owner, `/${piste.id}`, "PATCH", { mergeInto: piste.id, stage: "talking" })).status).toBe(400);
});

test("PATCH relance sets its status; sent restarts the silence; another person's is a 404", async () => {
  const mission = await make(owner);
  await database
    .update(openduetMissions)
    .set({ stageEnteredAt: new Date(Date.now() - 30 * 24 * 3600_000) })
    .where(eq(openduetMissions.id, mission.id));
  const relance = await store.ensureRelance(owner, mission.id, new Date());
  expect(relance).not.toBeNull();
  const detail = (await (await request(owner, `/${mission.id}`)).json()) as { relances: { id: string; status: string }[] };
  expect(detail.relances).toMatchObject([{ id: relance?.id, status: "draft" }]);

  expect((await request(other, `/${mission.id}/relances/${relance?.id}`, "PATCH", { status: "sent" })).status).toBe(404);
  expect((await request(owner, `/${mission.id}/relances/${relance?.id}`, "PATCH", { status: "nope" })).status).toBe(400);
  const sent = await request(owner, `/${mission.id}/relances/${relance?.id}`, "PATCH", { status: "sent" });
  expect(sent.status).toBe(200);
  expect(await sent.json()).toMatchObject({ relance: { status: "sent" } });
  expect((await store.get(owner, mission.id)).lastOutboundAt).not.toBeNull();
  expect((await request(owner, `/${mission.id}/relances/${randomUUID()}`, "PATCH", { status: "sent" })).status).toBe(404);
});

test("the brief loader lists open active missions with days in stage and whether a relance waits", async () => {
  const who = `${prefix}-brief`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const old = await make(who, { company: "Old Co" });
    await database
      .update(openduetMissions)
      .set({ stageEnteredAt: new Date(Date.now() - 30 * 24 * 3600_000) })
      .where(eq(openduetMissions.id, old.id));
    await store.ensureRelance(who, old.id, new Date());
    const fresh = await make(who, { company: "Fresh Co" });
    await make(who, { company: "Piste Co", review: "proposed", stage: "piste" });
    const closed = await make(who, { company: "Closed Co" });
    await store.advance(who, closed.id, { to: "refused", source: "app" });
    const rows = await loadBriefMissions(store, who, new Date());
    expect(rows.map((r) => r.id).sort()).toEqual([old.id, fresh.id].sort());
    expect(rows.find((r) => r.id === old.id)).toMatchObject({ stage: "applied", daysInStage: 30, relanceReady: true });
    expect(rows.find((r) => r.id === fresh.id)).toMatchObject({ daysInStage: 0, relanceReady: false });
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});

test("GET /:id/preps lists the mission's sheets, 404 for another person's mission", async () => {
  const mission = await make(owner, { stage: "interview" });
  const item = await createItemStore(database).insertIfNew(
    owner,
    { kind: "interview", title: "Entretien", dueAt: new Date(Date.now() + 3600_000), sourceApp: "gcal", sourceHash: `gcal:${randomUUID()}`, dateExplicit: true },
    "active",
    [],
  );
  await createPrepStore(database).ensurePending(owner, item?.id as string, mission.id);
  const response = await request(owner, `/${mission.id}/preps`);
  expect(response.status).toBe(200);
  const { preps } = (await response.json()) as { preps: { itemId: string; status: string }[] };
  expect(preps).toMatchObject([{ itemId: item?.id, status: "pending" }]);
  expect((await request(other, `/${mission.id}/preps`)).status).toBe(404);
});
