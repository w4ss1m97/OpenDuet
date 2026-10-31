import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
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

const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
  const actor = context.req.header("x-test-actor");
  if (!actor) return context.json({ error: "Sign in." }, 401);
  context.set("actor", { id: actor } as AppVariables["actor"]);
  await next();
};
const app = new Hono().route("/api/openduet/items", createItemRoutes(store, asActor));

function request(actor: string | null, path: string, body?: unknown) {
  return app.request(`/api/openduet/items${path}`, {
    method: body === undefined ? "GET" : "POST",
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
