import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { createCvRoutes } from "../src/openduet/job-offers/cv-routes";
import { PdfBusy, PdfUnavailable } from "../src/openduet/job-offers/cv-render";
import { createCvStore } from "../src/openduet/job-offers/cv-store";
import { createOfferRoutes } from "../src/openduet/job-offers/routes";
import { createOfferStore } from "../src/openduet/job-offers/store";
import { createMissionStore } from "../src/openduet/missions/store";
import { cvMasterFixture } from "./fixtures/cv-master";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The master CV routes and the tailored CV of an offer, with a fake model and a stub renderer. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-cv-routes-${randomUUID()}`;
const created: string[] = [];
const offers = createOfferStore(database);
const cvStore = createCvStore(database);

const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
  const actor = context.req.header("x-test-actor");
  if (!actor) return context.json({ error: "Sign in." }, 401);
  context.set("actor", { id: actor } as AppVariables["actor"]);
  await next();
};

let calls = 0;
let answer = () =>
  JSON.stringify({ titleIndex: 1, profileIndex: 1, experiences: [], skillGroupOrder: [], highlightSkills: ["typescript"] });
let renderError: Error | null = null;
const render = async (html: string) => {
  if (renderError) throw renderError;
  return new TextEncoder().encode(`%PDF-stub ${html.length}`);
};
const complete = async () => {
  calls += 1;
  return answer();
};
const app = new Hono()
  .route(
    "/api/openduet/offers",
    createOfferRoutes(
      { store: offers, missions: createMissionStore(database), profile: { text: async () => null }, complete, cv: { store: cvStore, render, complete } },
      asActor,
    ),
  )
  .route("/api/openduet/cv", createCvRoutes({ store: cvStore, render }, asActor));

function call(actor: string | null, path: string, method = "GET", body?: string) {
  return app.request(path, {
    method,
    headers: { ...(actor ? { "x-test-actor": actor } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body }),
  });
}
async function person() {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  created.push(id);
  return id;
}
async function offerOf(who: string, over: { company?: string | null; skills?: string[] } = {}) {
  const [row] = await offers.insertOffers(who, null, [
    { dedupKey: `c:${randomUUID()}`, platform: "malt", title: "Dev TS", company: "Acme & Fils", skills: ["TypeScript", "Go"], status: "new", ...over },
  ]);
  return row.id;
}
const put = (who: string, master: unknown = cvMasterFixture) => call(who, "/api/openduet/cv", "PUT", JSON.stringify(master));
const json = async (res: Response) => (await res.json()) as any;

afterAll(async () => {
  if (created.length) await database.delete(users).where(inArray(users.id, created));
});

test("needs a signed-in person", async () => {
  expect((await call(null, "/api/openduet/cv")).status).toBe(401);
  expect((await call(null, "/api/openduet/offers/x/cv")).status).toBe(401);
});

test("master: 404 until put, 400 names the first bad path, 413 when too big, then GET and PDF work", async () => {
  const who = await person();
  expect((await call(who, "/api/openduet/cv")).status).toBe(404);
  expect((await call(who, "/api/openduet/cv/pdf")).status).toBe(404);

  const bad = await put(who, { ...cvMasterFixture, header: { ...cvMasterFixture.header, email: "pas-un-mail" } });
  expect(bad.status).toBe(400);
  expect((await json(bad)).path).toBe("header.email");
  expect((await call(who, "/api/openduet/cv", "PUT", "{nope")).status).toBe(400);
  expect((await put(who, { ...cvMasterFixture, titles: ["x".repeat(70_000)] })).status).toBe(413);

  expect((await put(who)).status).toBe(200);
  const got = await json(await call(who, "/api/openduet/cv"));
  expect(got.master.header.name).toBe(cvMasterFixture.header.name);
  const pdf = await call(who, "/api/openduet/cv/pdf");
  expect(pdf.status).toBe(200);
  expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="CV-wassim-suilah.pdf"');
});

test("POST without a master is 409 no_master", async () => {
  const who = await person();
  const id = await offerOf(who);
  const res = await call(who, `/api/openduet/offers/${id}/cv`, "POST");
  expect(res.status).toBe(409);
  expect((await json(res)).code).toBe("no_master");
});

test("POST generates once, returns the ready CV after, regenerates on ?regenerate=1; GET reports stale", async () => {
  const who = await person();
  await put(who);
  const id = await offerOf(who);
  calls = 0;
  const first = await json(await call(who, `/api/openduet/offers/${id}/cv`, "POST"));
  expect(first.version.status).toBe("ready");
  expect(first.version.content.titles).toEqual([cvMasterFixture.titles[1]]);
  expect(first.match.covered).toContain("TypeScript");
  expect(first.match.missing).toContain("Go");
  expect(first.stale).toBe(false);
  expect(calls).toBe(1);

  await call(who, `/api/openduet/offers/${id}/cv`, "POST");
  expect(calls).toBe(1);
  await call(who, `/api/openduet/offers/${id}/cv?regenerate=1`, "POST");
  expect(calls).toBe(2);

  expect((await json(await call(who, `/api/openduet/offers/${id}/cv`))).stale).toBe(false);
  await put(who, { ...cvMasterFixture, titles: ["Nouveau titre", "Autre"] });
  expect((await json(await call(who, `/api/openduet/offers/${id}/cv`))).stale).toBe(true);
});

test("GET before any generation has no version", async () => {
  const who = await person();
  const id = await offerOf(who);
  const res = await json(await call(who, `/api/openduet/offers/${id}/cv`));
  expect(res).toEqual({ version: null, match: null, stale: false });
});

test("a bad model answer is 503, the version fails, and a retry can succeed", async () => {
  const who = await person();
  await put(who);
  const id = await offerOf(who);
  const good = answer;
  answer = () => "pas du json";
  const res = await call(who, `/api/openduet/offers/${id}/cv`, "POST");
  answer = good;
  expect(res.status).toBe(503);
  expect((await cvStore.getVersion(who, id))?.status).toBe("failed");
  expect((await json(await call(who, `/api/openduet/offers/${id}/cv`, "POST"))).version.status).toBe("ready");
});

test("a claimed version is 409 cv_in_progress", async () => {
  const who = await person();
  await put(who);
  const id = await offerOf(who);
  await cvStore.ensureVersion(who, id);
  expect(await cvStore.claimVersion(who, id, { regenerate: false })).not.toBeNull();
  const res = await call(who, `/api/openduet/offers/${id}/cv`, "POST");
  expect(res.status).toBe(409);
  expect((await json(res)).code).toBe("cv_in_progress");
});

test("PDF: ready only, attachment name from name and company, no-store; renderer failures are 503", async () => {
  const who = await person();
  await put(who);
  const id = await offerOf(who);
  expect((await call(who, `/api/openduet/offers/${id}/cv/pdf`)).status).toBe(404);
  await call(who, `/api/openduet/offers/${id}/cv`, "POST");
  const res = await call(who, `/api/openduet/offers/${id}/cv/pdf`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  expect(res.headers.get("content-disposition")).toBe('attachment; filename="CV-wassim-suilah-acme-fils.pdf"');
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(new TextDecoder().decode(await res.arrayBuffer()).startsWith("%PDF-")).toBe(true);

  renderError = new PdfUnavailable("no chrome");
  const unavailable = await call(who, `/api/openduet/offers/${id}/cv/pdf`);
  renderError = new PdfBusy("busy");
  const busy = await call(who, `/api/openduet/offers/${id}/cv/pdf`);
  renderError = null;
  expect(unavailable.status).toBe(503);
  expect((await json(unavailable)).code).toBe("pdf_unavailable");
  expect(busy.status).toBe(503);
  expect((await json(busy)).code).toBe("pdf_busy");

  const noCompany = await offerOf(who, { company: null });
  await call(who, `/api/openduet/offers/${noCompany}/cv`, "POST");
  const named = await call(who, `/api/openduet/offers/${noCompany}/cv/pdf`);
  expect(named.headers.get("content-disposition")).toBe('attachment; filename="CV-wassim-suilah-malt.pdf"');
});

test("another person's offer is a 404 on every CV route", async () => {
  const mine = await person();
  const theirs = await person();
  await put(theirs);
  const id = await offerOf(mine);
  for (const [path, method] of [["", "POST"], ["", "GET"], ["/pdf", "GET"]] as const) {
    expect((await call(theirs, `/api/openduet/offers/${id}/cv${path}`, method)).status).toBe(404);
  }
  expect(await cvStore.getVersion(theirs, id)).toBeNull();
  await database.delete(users).where(eq(users.id, theirs));
});
