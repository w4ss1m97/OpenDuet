import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createItemStore } from "../src/openduet/items/store";
import { createCvStore } from "../src/openduet/job-offers/cv-store";
import { createOfferRoutes } from "../src/openduet/job-offers/routes";
import { createOfferStore } from "../src/openduet/job-offers/store";
import { createMissionStore } from "../src/openduet/missions/store";
import { dedupKey } from "../src/openduet/revision/cards";
import { createRevisionGenerator, type RevisionSink } from "../src/openduet/revision/generate";
import { createRevisionRoutes } from "../src/openduet/revision/routes";
import { createRevisionStore } from "../src/openduet/revision/store";
import { loadBriefRevision } from "../src/openduet/wiring";
import { cvMasterFixture } from "./fixtures/cv-master";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-revision-routes-${randomUUID()}`;
const created: string[] = [];
const offers = createOfferStore(database);
const items = createItemStore(database);
const missions = createMissionStore(database);
const cvStore = createCvStore(database);
const store = createRevisionStore(database);
const sink: RevisionSink = store; // the store must satisfy the generator's slice

const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
  const actor = context.req.header("x-test-actor");
  if (!actor) return context.json({ error: "Sign in." }, 401);
  context.set("actor", { id: actor } as AppVariables["actor"]);
  await next();
};

let calls = 0;
let release: (() => void) | null = null;
let gate: Promise<void> | null = null;
let failOffer = false;
const concepts = (prefix: string, n: number) =>
  JSON.stringify({
    cards: Array.from({ length: n }, (_, i) => ({ topic: `${prefix} ${i}`, question: "Q ?", answer: "Réponse.", keyPoints: ["a", "b"] })),
  });
const complete = async (p: string) => {
  calls += 1;
  if (gate) await gate;
  if (failOffer && p.includes("Titre :")) throw new Error("model down");
  if (p.includes("questions comportementales")) return JSON.stringify({ stories: [{ question: "Q", theme: "T", bulletIds: ["acme-api"] }] });
  const m = p.match(/groupe de compétences « (.+?) »/);
  return concepts(m ? m[1] : "offre", m ? 5 : 3);
};
const generator = createRevisionGenerator({ store: sink, complete, getMaster: (o) => cvStore.getMaster(o), timeoutMs: 2000 });

let clock = new Date();
const app = new Hono()
  .route("/api/openduet/revision", createRevisionRoutes({ store, generator, cv: cvStore, items, offers, now: () => clock }, asActor))
  .route(
    "/api/openduet/offers",
    createOfferRoutes(
      { store: offers, missions, profile: { text: async () => null }, complete, revision: generator },
      asActor,
    ),
  );

const call = (actor: string | null, path: string, method = "GET", body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...(actor ? { "x-test-actor": actor } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (res: Response) => (await res.json()) as any;
async function person() {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  created.push(id);
  return id;
}
async function offerOf(who: string, company = "Acme") {
  const [row] = await offers.insertOffers(who, null, [
    { dedupKey: `r:${randomUUID()}`, platform: "malt", title: "Dev TS", company, skills: ["TypeScript", "Kafka"], status: "new" },
  ]);
  return row.id;
}
async function card(who: string, over: { offerId?: string; topic?: string } = {}) {
  const topic = over.topic ?? `t-${randomUUID()}`;
  const [row] = await store.insertCards(who, [
    { kind: "concept", topic, offerId: over.offerId ?? null, question: "Q", answer: "A", keyPoints: ["k"], bulletIds: [], masterHash: "h", dedupKey: dedupKey("concept", { topic }) },
  ]);
  return row.id;
}
/** An offer applied to through a mission with an interview `days` days from `clock`. */
async function offerWithInterview(who: string, days: number, company = "Acme") {
  const offerId = await offerOf(who, company);
  const { mission } = await missions.createPiste(who, { company, role: "Dev", review: "active", stage: "piste", at: new Date() });
  await offers.setApplied(who, offerId, mission.id);
  const item = await items.insertIfNew(
    who,
    { kind: "interview", title: "Entretien", dueAt: new Date(clock.getTime() + days * 86_400_000), sourceApp: "gcal", sourceHash: `gcal:${randomUUID()}`, dateExplicit: true },
    "active",
    [],
  );
  await items.setMission(who, item?.id as string, mission.id);
  return offerId;
}

afterAll(async () => {
  if (created.length) await database.delete(users).where(inArray(users.id, created));
});

test("needs a signed-in person", async () => {
  expect((await call(null, "/api/openduet/revision/today")).status).toBe(401);
  expect((await call(null, "/api/openduet/offers/x/revision", "POST")).status).toBe(401);
});

test("generate: 409 no_master, then 202 with the real generator and store, status, 409 while running, rerun adds nothing", async () => {
  const who = await person();
  const none = await call(who, "/api/openduet/revision/generate", "POST");
  expect(none.status).toBe(409);
  expect((await json(none)).code).toBe("no_master");

  await cvStore.putMaster(who, cvMasterFixture);
  calls = 0;
  gate = new Promise<void>((resolve) => (release = resolve));
  const started = await call(who, "/api/openduet/revision/generate", "POST");
  expect(started.status).toBe(202);
  expect(await json(started)).toEqual({ started: true });
  const again = await call(who, "/api/openduet/revision/generate", "POST");
  expect(again.status).toBe(409);
  expect((await json(again)).code).toBe("generation_in_progress");
  expect((await json(await call(who, "/api/openduet/revision/status"))).running).toBe(true);
  (release as unknown as () => void)();
  gate = null;
  await generator.idle(who);

  const status = await json(await call(who, "/api/openduet/revision/status"));
  expect(status.running).toBe(false);
  expect(status.lastError).toBeNull();
  expect(status.counts.pitch).toBe(1);
  expect(status.counts.story).toBe(1);
  expect(status.counts.concept).toBeGreaterThan(0);
  expect(calls).toBeLessThanOrEqual(9);
  expect((await store.list(who, { limit: 100 })).length).toBe(status.counts.concept + 2);

  const before = calls;
  expect((await call(who, "/api/openduet/revision/generate", "POST")).status).toBe(202);
  await generator.idle(who);
  expect(calls).toBe(before);
});

test("today: default 5, limit validated, other people's cards never show", async () => {
  const who = await person();
  const other = await person();
  for (let i = 0; i < 7; i++) await card(who);
  await card(other);
  const res = await json(await call(who, "/api/openduet/revision/today"));
  expect(res.cards.length).toBe(5);
  expect(res.focus).toEqual([]);
  expect((await json(await call(who, "/api/openduet/revision/today?limit=7"))).cards.length).toBe(7);
  for (const bad of ["0", "21", "x"]) expect((await call(who, `/api/openduet/revision/today?limit=${bad}`)).status).toBe(400);
});

test("today: an interview in 2 days puts its offer's cards first, in 5 days nothing", async () => {
  clock = new Date();
  const who = await person();
  for (let i = 0; i < 3; i++) await card(who);
  const soon = await offerWithInterview(who, 2, "Soonco");
  const far = await offerWithInterview(who, 5, "Farco");
  const focused = await card(who, { offerId: soon });
  const unfocused = await card(who, { offerId: far });
  const res = await json(await call(who, "/api/openduet/revision/today"));
  expect(res.cards[0].id).toBe(focused);
  expect(res.focus).toEqual([{ offerId: soon, company: "Soonco", interviewAt: expect.any(String) }]);
  const all = await json(await call(who, "/api/openduet/revision/today?limit=20"));
  expect(all.cards.findIndex((c: any) => c.id === unfocused)).toBeGreaterThan(0);
  expect(all.focus.map((f: any) => f.offerId)).not.toContain(far);
});

test("cards: filters by kind and topic, limit capped at 100", async () => {
  const who = await person();
  await card(who, { topic: "Kafka" });
  await card(who);
  expect((await json(await call(who, "/api/openduet/revision/cards?topic=kafka"))).cards.length).toBe(1);
  expect((await json(await call(who, "/api/openduet/revision/cards?kind=story"))).cards).toEqual([]);
  expect((await call(who, "/api/openduet/revision/cards?kind=nope")).status).toBe(400);
  expect((await call(who, "/api/openduet/revision/cards?limit=101")).status).toBe(400);
});

test("review: 400, 404 for unknown or other owner, box moves, conflict and archived are 409", async () => {
  const who = await person();
  const other = await person();
  const id = await card(who);
  const path = `/api/openduet/revision/cards/${id}/review`;
  expect((await call(who, path, "POST", { grade: "perfect" })).status).toBe(400);
  expect((await call(who, path, "POST", {})).status).toBe(400);
  expect((await call(other, path, "POST", { grade: "good" })).status).toBe(404);
  expect((await call(who, `/api/openduet/revision/cards/${randomUUID()}/review`, "POST", { grade: "good" })).status).toBe(404);

  const ok = await call(who, path, "POST", { grade: "good" });
  expect(ok.status).toBe(200);
  expect((await json(ok)).card).toMatchObject({ box: 2, reviewCount: 1, lastGrade: "good" });

  const results = await Promise.all([call(who, path, "POST", { grade: "good" }), call(who, path, "POST", { grade: "good" })]);
  const statuses = results.map((r) => r.status).sort();
  expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
  for (const r of results) if (r.status === 409) expect((await json(r)).code).toBe("review_conflict");

  expect((await call(other, `/api/openduet/revision/cards/${id}/archive`, "POST")).status).toBe(404);
  expect((await call(who, `/api/openduet/revision/cards/${id}/archive`, "POST")).status).toBe(200);
  expect((await call(who, `/api/openduet/revision/cards/${id}/archive`, "POST")).status).toBe(200);
  const archived = await call(who, path, "POST", { grade: "good" });
  expect(archived.status).toBe(409);
  expect((await json(archived)).code).toBe("archived");
});

test("offer hook: 404 other owner, 409 no_master, cards returned then reused, regenerate, 503 on model failure", async () => {
  const who = await person();
  const other = await person();
  const id = await offerOf(who);
  const path = `/api/openduet/offers/${id}/revision`;
  expect((await call(other, path, "POST")).status).toBe(404);
  const none = await call(who, path, "POST");
  expect(none.status).toBe(409);
  expect((await json(none)).code).toBe("no_master");

  await cvStore.putMaster(who, cvMasterFixture);
  calls = 0;
  const first = await json(await call(who, path, "POST"));
  expect(first.cards.length).toBe(3);
  expect(first.cards[0].offerId).toBe(id);
  expect(calls).toBe(1);
  expect((await json(await call(who, path, "POST"))).cards.length).toBe(3);
  expect(calls).toBe(1);
  expect((await call(who, `${path}?regenerate=1`, "POST")).status).toBe(200);
  expect(calls).toBe(2);

  const fresh = await offerOf(who);
  failOffer = true;
  try {
    expect((await call(who, `/api/openduet/offers/${fresh}/revision`, "POST")).status).toBe(503);
  } finally {
    failOffer = false;
  }
});

test("loadBriefRevision: null when empty, counts, focus company and three skills", async () => {
  clock = new Date();
  const who = await person();
  const deps = { revision: store, items, offers };
  expect(await loadBriefRevision(deps, who, clock)).toBeNull();
  await card(who);
  expect(await loadBriefRevision(deps, who, clock)).toEqual({ dueToday: 0, newCount: 1 });
  await offerWithInterview(who, 1, "Soonco");
  expect(await loadBriefRevision(deps, who, clock)).toEqual({
    dueToday: 0,
    newCount: 1,
    focus: { company: "Soonco", skills: ["TypeScript", "Kafka"] },
  });
});
