import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetOfferSources, openduetOffers } from "../src/db/schema/openduet-job-offers";
import { createOfferRoutes } from "../src/openduet/job-offers/routes";
import { type NewOffer, createOfferStore } from "../src/openduet/job-offers/store";
import { createMissionStore } from "../src/openduet/missions/store";
import { loadBriefOffers } from "../src/openduet/wiring";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The offers the app lists, dismisses, applies to and pastes; only ever the caller's own. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-job-offers-routes-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const store = createOfferStore(database);
const missions = createMissionStore(database);

const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
  const actor = context.req.header("x-test-actor");
  if (!actor) return context.json({ error: "Sign in." }, 401);
  context.set("actor", { id: actor } as AppVariables["actor"]);
  await next();
};

let calls: string[] = [];
let answer = (prompt: string): string =>
  prompt.includes("Tu lis un")
    ? JSON.stringify({
        offers: [
          { title: "DevOps AWS", company: "Acme", tjmMin: 650, tjmMax: 750, rateUnit: "day", contract: "freelance", remote: "hybrid", location: "Paris", skills: ["AWS"], description: "Mission" },
        ],
      })
    : JSON.stringify({ score: 82, reasons: ["Stack AWS"], missingSkills: [] });
const complete = async (prompt: string) => {
  calls.push(prompt.includes("Tu lis un") ? "extract" : "score");
  return answer(prompt);
};
let hasProfile = true;
const app = new Hono().route(
  "/api/openduet/offers",
  createOfferRoutes(
    { store, missions, profile: { text: async () => (hasProfile ? "Freelance DevOps AWS" : null) }, complete, overallMs: 500 },
    asActor,
  ),
);

function request(actor: string | null, path: string, method = "GET", body?: unknown) {
  return app.request(`/api/openduet/offers${path}`, {
    method,
    headers: { ...(actor ? { "x-test-actor": actor } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const tag = () => randomUUID().replace(/-/g, "").slice(0, 8);
async function make(who: string, over: Partial<NewOffer> = {}, score?: number, scoredAt?: Date) {
  const [row] = await store.insertOffers(who, null, [
    { dedupKey: `c:${randomUUID()}`, platform: "malt", title: `Dev ${tag()}`, company: `Acme${tag()}`, status: "new", ...over },
  ]);
  if (score !== undefined) {
    const claim = (await store.claimScore(who, row.id))!;
    await store.completeScore(who, row.id, claim.claimedAt!, { score, reasons: ["r"], missingSkills: [], profileHash: "h" });
    if (scoredAt) await database.update(openduetOffers).set({ scoredAt }).where(eq(openduetOffers.id, row.id));
  }
  return row.id;
}

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

test("GET lists the caller's live offers by score desc, unscored last, and filters by status", async () => {
  const who = `${prefix}-list`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const unscored = await make(who);
    const low = await make(who, {}, 60);
    const high = await make(who, {}, 90);
    const filtered = await make(who, { status: "filtered", filterReason: "low_tjm" });
    await make(other, {}, 99);
    const res = await request(who, "");
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { offers: { id: string }[] }).offers.map((o) => o.id);
    expect(ids).toEqual([high, low, unscored]);
    const f = (await (await request(who, "?status=filtered")).json()) as { offers: { id: string }[] };
    expect(f.offers.map((o) => o.id)).toEqual([filtered]);
    expect(((await (await request(who, "?limit=1")).json()) as { offers: unknown[] }).offers).toHaveLength(1);
    expect((await request(who, "?status=nope")).status).toBe(400);
    expect((await request(who, "?limit=101")).status).toBe(400);
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});

test("another person's offer is a 404 on every route", async () => {
  const id = await make(other, {}, 80);
  expect((await request(owner, `/${id}`)).status).toBe(404);
  expect((await request(owner, `/${id}/dismiss`, "POST")).status).toBe(404);
  expect((await request(owner, `/${id}/apply`, "POST")).status).toBe(404);
  expect((await request(owner, `/${randomUUID()}`)).status).toBe(404);
  expect((await request(other, `/${id}`)).status).toBe(200);
});

test("dismiss moves the offer out of the default list; dismissing twice is fine", async () => {
  const id = await make(owner, {}, 80);
  expect((await request(owner, `/${id}/dismiss`, "POST")).status).toBe(200);
  expect((await request(owner, `/${id}/dismiss`, "POST")).status).toBe(200);
  const body = (await (await request(owner, "")).json()) as { offers: { id: string }[] };
  expect(body.offers.map((o) => o.id)).not.toContain(id);
});

test("apply creates one active piste, links it, and is idempotent; dismissing an applied offer is a 409", async () => {
  const id = await make(owner, { company: "Globex", title: "SRE" }, 80);
  const first = await request(owner, `/${id}/apply`, "POST");
  expect(first.status).toBe(200);
  const a = (await first.json()) as { offer: { status: string; missionId: string }; mission: { id: string; company: string; role: string; stage: string; review: string } };
  expect(a.offer.status).toBe("applied");
  expect(a.mission).toMatchObject({ company: "Globex", role: "SRE", stage: "piste", review: "active" });
  expect(a.offer.missionId).toBe(a.mission.id);
  const second = (await (await request(owner, `/${id}/apply`, "POST")).json()) as { mission: { id: string } };
  expect(second.mission.id).toBe(a.mission.id);
  expect((await missions.list(owner, {})).filter((m) => m.company === "Globex")).toHaveLength(1);
  expect((await request(owner, `/${id}/dismiss`, "POST")).status).toBe(409);
});

test("apply without a company uses the platform's name", async () => {
  const id = await make(owner, { company: null, title: "Archi", platform: "free-work" });
  const res = (await (await request(owner, `/${id}/apply`, "POST")).json()) as { mission: { company: string } };
  expect(res.mission.company).toBe("Free-Work");
});

test("paste validates the text and the url", async () => {
  expect((await request(owner, "/paste", "POST", { text: "trop court" })).status).toBe(400);
  expect((await request(owner, "/paste", "POST", { text: "x".repeat(20_001) })).status).toBe(400);
  expect((await request(owner, "/paste", "POST", { text: "x".repeat(60), url: "pas une url" })).status).toBe(400);
  expect((await request(owner, "/paste", "POST", {})).status).toBe(400);
});

test("paste reads, stores and scores the offers inline; the same text returns the same offers without a model call", async () => {
  const text = `Mission DevOps AWS chez Acme ${tag()}, 700 euros par jour, Paris, hybride, démarrage rapide.`;
  calls = [];
  const first = await request(owner, "/paste", "POST", { text, url: "https://example.com/offre" });
  expect(first.status).toBe(200);
  const a = (await first.json()) as { offers: { id: string; status: string; score: number }[] };
  expect(a.offers).toHaveLength(1);
  expect(a.offers[0]).toMatchObject({ status: "shown", score: 82 });
  expect(calls).toEqual(["extract", "score"]);

  const second = (await (await request(owner, "/paste", "POST", { text, url: "https://example.com/offre" })).json()) as { offers: { id: string }[] };
  expect(second.offers.map((o) => o.id)).toEqual(a.offers.map((o) => o.id));
  expect(calls).toEqual(["extract", "score"]);

  const [src] = await database.select().from(openduetOfferSources).where(eq(openduetOfferSources.id, (await store.get(owner, a.offers[0].id))!.sourceId!));
  expect(src).toMatchObject({ status: "done", platform: "paste", offersFound: 1, pasteText: null });
});

test("paste keeps at most three offers and leaves them unscored without a profile", async () => {
  const text = `Trois missions dans ce texte ${tag()} `.repeat(5);
  const saved = answer;
  answer = (p) =>
    p.includes("Tu lis un")
      ? JSON.stringify({ offers: Array.from({ length: 5 }, (_, i) => ({ title: `Mission ${tag()} ${i}`, company: `Co${tag()}`, contract: "freelance", tjmMax: 700, rateUnit: "day", location: "Paris" })) })
      : saved(p);
  hasProfile = false;
  calls = [];
  try {
    const res = (await (await request(owner, "/paste", "POST", { text })).json()) as { offers: { status: string }[] };
    expect(res.offers).toHaveLength(3);
    expect(res.offers.every((o) => o.status === "new")).toBe(true);
    expect(calls).toEqual(["extract"]);
  } finally {
    answer = saved;
    hasProfile = true;
  }
});

test("paste whose model fails answers 503, leaves the source failed with no text kept, and can be retried", async () => {
  const text = `Annonce qui fait échouer le modèle ${tag()} `.repeat(3);
  const saved = answer;
  answer = () => {
    throw new Error("boom");
  };
  try {
    const res = await request(owner, "/paste", "POST", { text });
    expect(res.status).toBe(503);
  } finally {
    answer = saved;
  }
  const [src] = await database
    .select()
    .from(openduetOfferSources)
    .where(eq(openduetOfferSources.status, "failed"))
    .then((rows) => rows.filter((r) => r.ownerUserId === owner && r.platform === "paste"));
  expect(src).toMatchObject({ lastError: "Error", claimedAt: null });
  expect((await request(owner, "/paste", "POST", { text })).status).toBe(200);
});

test("loadBriefOffers: shown, scored in the last 24 hours, best five", async () => {
  const who = `${prefix}-brief`;
  await database.insert(users).values({ id: who, email: `${who}@example.test` });
  try {
    const now = new Date();
    const hours = (h: number) => new Date(now.getTime() - h * 3600_000);
    const ids: string[] = [];
    for (const s of [76, 80, 85, 90, 95, 99]) ids.push(await make(who, {}, s, hours(1)));
    await make(who, {}, 100, hours(30));
    await make(who, {}, 50, hours(1));
    const rows = await loadBriefOffers(store, who, now);
    expect(rows.map((r) => r.score)).toEqual([99, 95, 90, 85, 80]);
    expect(rows[0]).toEqual({
      id: ids[5],
      title: expect.any(String),
      company: expect.any(String),
      platform: "malt",
      score: 99,
      reasons: ["r"],
      tjmMax: null,
      remote: "unknown",
    });
  } finally {
    await database.delete(users).where(eq(users.id, who));
  }
});
