import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createPrepStore } from "../src/openduet/missions/prep-store";
import { createMissionStore } from "../src/openduet/missions/store";
import { loadBriefInterviews } from "../src/openduet/wiring";
import { createItemRoutes } from "../src/openduet/items/routes";
import { createItemStore } from "../src/openduet/items/store";
import { INTAKE_REPORT_TOOL, intakeReportTools } from "../src/openduet/items/tool";
import type { ItemCandidate } from "../src/openduet/items/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The app reads and changes only its own person's items; the brief reads what the intake found. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-items-routes-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const store = createItemStore(database);
const missions = createMissionStore(database);
const preps = createPrepStore(database);

const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
  const actor = context.req.header("x-test-actor");
  if (!actor) return context.json({ error: "Sign in." }, 401);
  context.set("actor", { id: actor } as AppVariables["actor"]);
  await next();
};
const app = new Hono().route("/api/openduet/items", createItemRoutes(store, asActor, { missions, preps }));

function request(actor: string | null, path: string, body?: unknown) {
  return app.request(`/api/openduet/items${path}`, {
    method: body === undefined && !path.endsWith("/regenerate") ? "GET" : "POST",
    headers: {
      ...(actor ? { "x-test-actor": actor } : {}),
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function candidate(overrides: Partial<ItemCandidate> = {}): ItemCandidate {
  return {
    kind: "bill",
    title: "Facture",
    dueAt: new Date(Date.now() + 24 * 3600_000),
    amount: 45,
    sourceApp: "gmail",
    sourceHash: `gmail:${randomUUID()}`,
    dateExplicit: true,
    ...overrides,
  };
}

let mine = "";

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  mine = (await store.insertIfNew(owner, candidate(), "active", []))?.id ?? "";
  await store.insertIfNew(other, candidate(), "active", []);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

test("GET returns only the caller's items", async () => {
  const response = await request(owner, "?status=active,proposed");
  expect(response.status).toBe(200);
  const { items } = (await response.json()) as { items: { id: string }[] };
  expect(items.map((i) => i.id)).toEqual([mine]);
});

test("401 without user", async () => {
  expect((await request(null, "")).status).toBe(401);
});

test("400 on unknown status", async () => {
  expect((await request(owner, `/${mine}/status`, { status: "deleted" })).status).toBe(400);
  expect((await request(owner, "?status=deleted")).status).toBe(400);
});

test("404 for another person's item", async () => {
  expect((await request(other, `/${mine}/status`, { status: "done" })).status).toBe(404);
});

test("snooze 60 adds a reminder 60 min from now", async () => {
  const before = Date.now();
  const response = await request(owner, `/${mine}/snooze`, { minutes: 60 });
  expect(response.status).toBe(200);
  const { item } = (await response.json()) as { item: { remindAt: string[] } };
  const last = new Date(item.remindAt.at(-1) ?? 0).getTime();
  expect(last - before).toBeGreaterThanOrEqual(60 * 60_000);
  expect(last - before).toBeLessThan(61 * 60_000);
  expect((await request(owner, `/${mine}/snooze`, { minutes: 0 })).status).toBe(400);
});

test("status change to done", async () => {
  const response = await request(owner, `/${mine}/status`, { status: "done" });
  const { item } = (await response.json()) as { item: { status: string; resolvedAt: string } };
  expect(item.status).toBe("done");
  expect(item.resolvedAt).toBeTruthy();
});

test("intake_report lists failed sources and what is due within 48 h", async () => {
  await store.insertIfNew(other, candidate({ title: "Amende" , kind: "fine" }), "active", []);
  const [tool] = intakeReportTools({
    actorId: other,
    initiator: { kind: "person" },
    store,
    report: () => ({
      at: new Date(),
      added: 2,
      proposed: 1,
      failed: [{ scanner: "notes", error: "Mac bridge non connecté" }],
    }),
  });
  expect(tool?.name).toBe(INTAKE_REPORT_TOOL);
  const result = JSON.parse(String(await tool?.execute({})));
  expect(result).toMatchObject({ added: 2, proposed: 1, failedSources: ["Apple Notes (Mac bridge non connecté)"] });
  expect(result.dueWithin48h.map((d: { title: string }) => d.title).sort()).toEqual(["Amende", "Facture"]);
});

test("intake_report says when no intake ran yet", async () => {
  const [tool] = intakeReportTools({ actorId: other, initiator: { kind: "person" }, store, report: () => null });
  expect(JSON.parse(String(await tool?.execute({})))).toMatchObject({ ranYet: false });
});

// ---- Interview prep ------------------------------------------------------------------------------

const sheet = { pitch: "p", likelyQuestions: ["q"], questionsToAsk: ["a"] };
const interviewIn = async (who: string, hours: number) =>
  (await store.insertIfNew(
    who,
    { kind: "interview", title: "Entretien", dueAt: new Date(Date.now() + hours * 3600_000), sourceApp: "gcal", sourceHash: `gcal:${randomUUID()}`, dateExplicit: true },
    "active",
    [],
  ))?.id ?? "";
const missionFor = async (who: string) =>
  (await missions.createPiste(who, { company: `Acme ${randomUUID()}`, review: "active", stage: "interview" })).mission.id;

test("GET prep is 404 until a sheet exists, then 200 with its status and content", async () => {
  const id = await interviewIn(owner, 24);
  expect((await request(owner, `/${id}/prep`)).status).toBe(404);
  const missionId = await missionFor(owner);
  expect((await request(owner, `/${id}/mission`, { missionId })).status).toBe(200);
  const queued = await request(owner, `/${id}/prep`);
  expect(queued.status).toBe(200);
  expect(await queued.json()).toMatchObject({ prep: { status: "pending", content: null, missionId } });
  const claim = await preps.claim(owner, id);
  await preps.complete(owner, id, claim?.claimedAt as Date, sheet);
  expect(await (await request(owner, `/${id}/prep`)).json()).toMatchObject({ prep: { status: "ready", content: sheet } });
  expect((await request(other, `/${id}/prep`)).status).toBe(404);
});

test("POST mission: 404 for another person's mission or item, 422 for a bill, null unties and keeps the sheet", async () => {
  const id = await interviewIn(owner, 24);
  const theirs = await missionFor(other);
  expect((await request(owner, `/${id}/mission`, { missionId: theirs })).status).toBe(404);
  expect((await request(other, `/${id}/mission`, { missionId: theirs })).status).toBe(404);
  expect((await request(owner, `/${id}/mission`, { missionId: 5 })).status).toBe(400);
  const bill = (await store.insertIfNew(owner, candidate({ kind: "bill" }), "active", []))?.id ?? "";
  expect((await request(owner, `/${bill}/mission`, { missionId: await missionFor(owner) })).status).toBe(422);

  const missionId = await missionFor(owner);
  await request(owner, `/${id}/mission`, { missionId });
  const untied = await request(owner, `/${id}/mission`, { missionId: null });
  expect(untied.status).toBe(200);
  expect(((await untied.json()) as { item: { missionId: string | null } }).item.missionId).toBeNull();
  expect((await request(owner, `/${id}/prep`)).status).toBe(200);
});

test("POST prep/regenerate queues again, 404 without a sheet or for someone else", async () => {
  const id = await interviewIn(owner, 24);
  expect((await request(owner, `/${id}/prep/regenerate`)).status).toBe(404);
  await request(owner, `/${id}/mission`, { missionId: await missionFor(owner) });
  const claim = await preps.claim(owner, id);
  await preps.fail(owner, id, claim?.claimedAt as Date, "TimeoutError");
  const response = await request(owner, `/${id}/prep/regenerate`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ prep: { status: "pending" } });
  expect((await request(other, `/${id}/prep/regenerate`)).status).toBe(404);
});

test("loadBriefInterviews lists tomorrow's interviews in Paris with their sheet", async () => {
  const who = `${prefix}-brief`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const now = new Date("2026-11-11T10:00:00Z");
    const at = async (iso: string) =>
      (await store.insertIfNew(who, { kind: "interview", title: iso, dueAt: new Date(iso), sourceApp: "gcal", sourceHash: `gcal:${randomUUID()}`, dateExplicit: true }, "active", []))?.id ?? "";
    const tomorrow = await at("2026-11-12T13:00:00Z");
    await at("2026-11-11T13:00:00Z");
    await at("2026-11-13T13:00:00Z");
    const missionId = await missionFor(who);
    await store.setMission(who, tomorrow, missionId);
    await preps.ensurePending(who, tomorrow, missionId);
    const rows = await loadBriefInterviews(store, preps, who, now);
    expect(rows).toEqual([
      { itemId: tomorrow, title: "2026-11-12T13:00:00Z", dueAt: "2026-11-12T13:00:00.000Z", missionId, prep: { status: "pending", content: null } },
    ]);
  } finally {
    await database.delete(users).where(inArray(users.id, [who]));
  }
});
