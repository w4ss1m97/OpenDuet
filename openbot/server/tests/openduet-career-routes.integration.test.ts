import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetMissions } from "../src/db/schema/openduet-missions";
import { createCareerRoutes } from "../src/openduet/career/routes";
import { createCareerStore } from "../src/openduet/career/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-career-routes-${randomUUID()}`;
const created: string[] = [];
let clock = new Date("2026-11-04T10:00:00Z"); // Wednesday

const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
  const actor = context.req.header("x-test-actor");
  if (!actor) return context.json({ error: "Sign in." }, 401);
  context.set("actor", { id: actor } as AppVariables["actor"]);
  await next();
};
const app = new Hono().route("/api/openduet/career", createCareerRoutes({ store: createCareerStore(database), now: () => clock }, asActor));
const get = (actor: string | null, query = "") =>
  app.request(`/api/openduet/career/weekly${query}`, { headers: actor ? { "x-test-actor": actor } : {} });
const json = async (res: Response) => (await res.json()) as any;

async function person() {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  created.push(id);
  return id;
}

afterAll(async () => {
  if (created.length) await database.delete(users).where(inArray(users.id, created));
});

test("needs a signed-in user", async () => {
  expect((await get(null)).status).toBe(401);
});

test("rejects bad, impossible and future weeks", async () => {
  const a = await person();
  expect((await get(a, "?week=nope")).status).toBe(400);
  expect((await get(a, "?week=2026-02-30")).status).toBe(400);
  expect((await get(a, "?week=2026-11-09")).status).toBe(400);
});

test("normalises ?week to its Monday and defaults to the last completed week on a Monday", async () => {
  const a = await person();
  expect((await json(await get(a, "?week=2026-10-29"))).week.label).toBe("2026-10-26");
  clock = new Date("2026-11-02T08:00:00Z");
  const monday = await json(await get(a));
  expect(monday.week.label).toBe("2026-10-26");
  expect(monday.week.complete).toBe(true);
  clock = new Date("2026-11-04T10:00:00Z");
  expect((await json(await get(a))).week.label).toBe("2026-11-02");
});

test("another owner gets zeros while the first has data", async () => {
  const a = await person();
  const b = await person();
  const id = randomUUID();
  await database.insert(openduetMissions).values({
    id, ownerUserId: a, company: "Acme", companyKey: id, stage: "piste", review: "active", title: "t", createdAt: new Date("2026-11-03T10:00:00Z"),
  });
  expect((await json(await get(a))).window.newMissions).toBe(1);
  const other = await json(await get(b));
  expect(other.window.newMissions).toBe(0);
  expect(other.now.pipeline).toEqual({});
});
