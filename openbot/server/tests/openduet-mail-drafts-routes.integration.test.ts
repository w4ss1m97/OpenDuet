import { afterAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { HeadlessToolSuspension } from "@openbot/toolkit/headless-tools";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetMissionRelances } from "../src/db/schema/openduet-missions";
import { createCvStore } from "../src/openduet/job-offers/cv-store";
import { createOfferStore } from "../src/openduet/job-offers/store";
import { createMailDraftRoutes } from "../src/openduet/mail-drafts/routes";
import { createMailDraftStore } from "../src/openduet/mail-drafts/store";
import { createMissionStore } from "../src/openduet/missions/store";
import { cvMasterFixture } from "./fixtures/cv-master";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The mail-draft routes: relance and application drafts, edits, one push to Gmail through the gate, owner scoping. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-mail-drafts-routes-${randomUUID()}`;
const created: string[] = [];
const store = createMailDraftStore(database);
const missions = createMissionStore(database);
const offers = createOfferStore(database);
const cvStore = createCvStore(database);

const asActor: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
  const actor = context.req.header("x-test-actor");
  if (!actor) return context.json({ error: "Sign in." }, 401);
  context.set("actor", { id: actor } as AppVariables["actor"]);
  await next();
};

const COVER_BODY = "Bonjour, je candidate à cette mission. ".repeat(8);
let completeCalls = 0;
let completeAnswer = () => JSON.stringify({ subject: "Candidature — Dev TS", body: COVER_BODY });
let renderCalls = 0;
type ToolCall = { ref: string; args: Record<string, any>; botId: string; actorId: string; initiator: { kind: string } };
let toolCalls: ToolCall[] = [];
let toolImpl: (input: ToolCall) => Promise<{ text: string; isError: boolean }> = async () => ({
  text: JSON.stringify({ draft: true, id: "gd-1", messageId: "m-1", threadId: "t-1" }),
  isError: false,
});

function build(over: { render?: boolean; complete?: boolean; callTool?: boolean } = {}) {
  return new Hono().route(
    "/api/openduet/mail-drafts",
    createMailDraftRoutes(
      {
        store,
        missions,
        offers,
        cv: cvStore,
        profile: { text: async () => "Profil : dix ans de TypeScript." },
        ...(over.render === false ? {} : { render: async () => { renderCalls += 1; return new TextEncoder().encode("%PDF-1.4 stub"); } }),
        ...(over.complete === false ? {} : { complete: async () => { completeCalls += 1; return completeAnswer(); } }),
        ...(over.callTool === false
          ? {}
          : {
              callTool: async (input: ToolCall) => { toolCalls.push(input); return toolImpl(input); },
              botFor: async () => "bot-duet",
            }),
      },
      asActor,
    ),
  );
}
const app = build();
const BASE = "/api/openduet/mail-drafts";
function call(actor: string | null, path: string, method = "GET", body?: unknown, server = app) {
  return server.request(path, {
    method,
    headers: { ...(actor ? { "x-test-actor": actor } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
const json = async (res: Response) => (await res.json()) as any;

beforeEach(() => {
  completeCalls = 0;
  renderCalls = 0;
  toolCalls = [];
  completeAnswer = () => JSON.stringify({ subject: "Candidature — Dev TS", body: COVER_BODY });
  toolImpl = async () => ({ text: JSON.stringify({ draft: true, id: "gd-1", messageId: "m-1", threadId: "t-1" }), isError: false });
});
afterAll(async () => {
  if (created.length) await database.delete(users).where(inArray(users.id, created));
});

async function person() {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  created.push(id);
  return id;
}
async function missionWithRelance(who: string, opts: { threadIds?: string[]; contacts?: string[]; status?: "draft" | "sent" } = {}) {
  const { mission } = await missions.createPiste(who, { company: `Acme ${randomUUID().slice(0, 6)}`, role: "Lead dev", review: "active", contactEmail: opts.contacts?.[0], threadId: opts.threadIds?.[0] });
  const relanceId = randomUUID();
  await database.insert(openduetMissionRelances).values({ id: relanceId, missionId: mission.id, ownerUserId: who, windowStart: new Date(), body: "Bonjour, une relance.", status: opts.status ?? "draft" });
  return { mission, relanceId };
}
async function offerOf(who: string, ready: boolean) {
  const [row] = await offers.insertOffers(who, null, [{ dedupKey: `c:${randomUUID()}`, platform: "malt", title: "Dev TS", company: "Acme & Fils", skills: ["TypeScript"], description: "Détails https://acme.example/42", status: "new" }]);
  if (ready) {
    await cvStore.ensureVersion(who, row.id);
    const claim = await cvStore.claimVersion(who, row.id, { regenerate: false });
    await cvStore.completeVersion(who, row.id, claim!.claimedAt!, { ...cvMasterFixture, highlight: ["typescript"] } as never, { covered: [], missing: [] }, "h");
  }
  return row.id;
}
async function relanceDraft(who: string) {
  const { mission, relanceId } = await missionWithRelance(who, { threadIds: ["thread-1"], contacts: ["ana@acme.example"] });
  const res = await call(who, BASE, "POST", { kind: "relance", missionId: mission.id, relanceId });
  return { res, mission, relanceId, draft: await json(res) };
}

test("needs a signed-in person", async () => {
  expect((await call(null, BASE)).status).toBe(401);
});

test("a relance draft: subject, contacts, the mission's thread; 201 then 200 for the same relance", async () => {
  const who = await person();
  const { res, mission, relanceId, draft } = await relanceDraft(who);
  expect(res.status).toBe(201);
  expect(draft).toMatchObject({ kind: "relance", status: "draft", body: "Bonjour, une relance.", to: ["ana@acme.example"], threadId: "thread-1", hasAttachment: false });
  expect(draft.subject).toBe(`Relance — Lead dev chez ${mission.company}`);
  expect(draft.attachmentPdf).toBeUndefined();
  const again = await call(who, BASE, "POST", { kind: "relance", missionId: mission.id, relanceId });
  expect(again.status).toBe(200);
  expect((await json(again)).id).toBe(draft.id);
  expect((await json(await call(who, `${BASE}?status=draft`))).drafts.map((d: any) => d.id)).toContain(draft.id);
});

test("a relance of another mission, a sent relance and a bad body", async () => {
  const who = await person();
  const a = await missionWithRelance(who);
  const b = await missionWithRelance(who);
  expect((await call(who, BASE, "POST", { kind: "relance", missionId: a.mission.id, relanceId: b.relanceId })).status).toBe(404);
  const sent = await missionWithRelance(who, { status: "sent" });
  expect((await call(who, BASE, "POST", { kind: "relance", missionId: sent.mission.id, relanceId: sent.relanceId })).status).toBe(409);
  expect((await call(who, BASE, "POST", { kind: "nope" })).status).toBe(400);
  expect((await call(who, BASE, "POST", "{bad")).status).toBe(400);
});

test("an application draft needs a ready CV, then stores the cover and the PDF once", async () => {
  const who = await person();
  const cold = await offerOf(who, false);
  const refused = await call(who, BASE, "POST", { kind: "application", offerId: cold });
  expect(refused.status).toBe(409);
  expect((await json(refused)).code).toBe("cv_not_ready");

  const offerId = await offerOf(who, true);
  const res = await call(who, BASE, "POST", { kind: "application", offerId });
  expect(res.status).toBe(201);
  const draft = await json(res);
  expect(draft).toMatchObject({ kind: "application", to: [], hasAttachment: true, attachmentName: "CV-wassim-suilah-acme-fils.pdf", subject: "Candidature — Dev TS" });
  const pdf = await call(who, `${BASE}/${draft.id}/attachment`);
  expect(pdf.status).toBe(200);
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect(pdf.headers.get("cache-control")).toBe("no-store");
  expect(await pdf.text()).toBe("%PDF-1.4 stub");

  const again = await call(who, BASE, "POST", { kind: "application", offerId });
  expect(again.status).toBe(200);
  expect(completeCalls).toBe(1);
  expect(renderCalls).toBe(1);
});

test("a bad cover answer is 503 cover_failed and leaves no row; a missing renderer or model is 503", async () => {
  const who = await person();
  const offerId = await offerOf(who, true);
  completeAnswer = () => JSON.stringify({ subject: "s", body: "trop court" });
  const res = await call(who, BASE, "POST", { kind: "application", offerId });
  expect(res.status).toBe(503);
  expect((await json(res)).code).toBe("cover_failed");
  expect(await store.listDrafts(who)).toEqual([]);

  const noRender = await call(who, BASE, "POST", { kind: "application", offerId }, build({ render: false }));
  expect(noRender.status).toBe(503);
  const noModel = await call(who, BASE, "POST", { kind: "application", offerId }, build({ complete: false }));
  expect(noModel.status).toBe(503);
  expect(await store.listDrafts(who)).toEqual([]);
});

test("PATCH edits a draft; bad input is 400, a header break too; not a draft is 409", async () => {
  const who = await person();
  const { draft } = await relanceDraft(who);
  const ok = await call(who, `${BASE}/${draft.id}`, "PATCH", { subject: "Nouveau", to: ["b@x.com"], body: "Salut" });
  expect(ok.status).toBe(200);
  expect(await json(ok)).toMatchObject({ subject: "Nouveau", to: ["b@x.com"], body: "Salut" });
  for (const body of [{ to: ["pas-un-mail"] }, { subject: "a\r\nBcc: z@y.com" }, { to: ["a@x.com\nBcc: z@y.com"] }, { subject: "x".repeat(201) }, { body: "x".repeat(20_001) }, { body: "  " }, { surprise: 1 }]) {
    expect((await call(who, `${BASE}/${draft.id}`, "PATCH", body)).status).toBe(400);
  }
  await call(who, `${BASE}/${draft.id}/dismiss`, "POST");
  expect((await call(who, `${BASE}/${draft.id}`, "PATCH", { subject: "x" })).status).toBe(409);
});

test("push creates the Gmail draft as the owner, once; a second push is 409 already_pushed", async () => {
  const who = await person();
  const { draft } = await relanceDraft(who);
  const res = await call(who, `${BASE}/${draft.id}/push`, "POST");
  expect(res.status).toBe(200);
  expect(await json(res)).toMatchObject({ status: "pushed", gmailDraftId: "gd-1" });
  expect(toolCalls).toHaveLength(1);
  const sent = toolCalls[0];
  expect(sent.ref).toBe("google-workspace/gmail_create_draft");
  expect(sent.botId).toBe("bot-duet");
  expect(sent.actorId).toBe(who);
  expect(sent.initiator).toEqual({ kind: "person" });
  expect(sent.args).toEqual({ to: ["ana@acme.example"], cc: [], subject: draft.subject, body: "Bonjour, une relance.", threadId: "thread-1" });

  const again = await call(who, `${BASE}/${draft.id}/push`, "POST");
  expect(again.status).toBe(409);
  expect((await json(again)).code).toBe("already_pushed");
  expect(toolCalls).toHaveLength(1);
});

test("an application push carries the stored PDF as a base64 attachment", async () => {
  const who = await person();
  const draft = await json(await call(who, BASE, "POST", { kind: "application", offerId: await offerOf(who, true) }));
  expect((await call(who, `${BASE}/${draft.id}/push`, "POST")).status).toBe(200);
  expect(toolCalls[0].args.attachment).toEqual({ filename: "CV-wassim-suilah-acme-fils.pdf", mimeType: "application/pdf", contentBase64: Buffer.from("%PDF-1.4 stub").toString("base64") });
  expect(toolCalls[0].args.threadId).toBeUndefined();
});

test("concurrent pushes: one calls the tool, the other is 409 push_in_progress", async () => {
  const who = await person();
  const { draft } = await relanceDraft(who);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  toolImpl = async () => { await gate; return { text: JSON.stringify({ draft: true, id: "gd-2", messageId: "m", threadId: "t" }), isError: false }; };
  const first = call(who, `${BASE}/${draft.id}/push`, "POST");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await call(who, `${BASE}/${draft.id}/push`, "POST");
  expect(second.status).toBe(409);
  expect((await json(second)).code).toBe("push_in_progress");
  release();
  expect((await first).status).toBe(200);
  expect(toolCalls).toHaveLength(1);
});

test("the approval gate: 202 approval_pending releases the claim, and the retry carries identical args", async () => {
  const who = await person();
  const { draft } = await relanceDraft(who);
  toolImpl = async () => { throw new HeadlessToolSuspension("waiting", { kind: "approval", approvalId: "ap-1", requestId: "ap-1" }); };
  const pending = await call(who, `${BASE}/${draft.id}/push`, "POST");
  expect(pending.status).toBe(202);
  expect(await json(pending)).toEqual({ status: "approval_pending", approvalId: "ap-1" });
  expect(await store.getDraft(who, draft.id)).toMatchObject({ status: "draft", claimedAt: null });

  toolImpl = async () => ({ text: JSON.stringify({ draft: true, id: "gd-3", messageId: "m", threadId: "t" }), isError: false });
  expect((await call(who, `${BASE}/${draft.id}/push`, "POST")).status).toBe(200);
  expect(toolCalls).toHaveLength(2);
  expect(JSON.stringify(toolCalls[1].args)).toBe(JSON.stringify(toolCalls[0].args));
});

test("a tool error or a refusal is 502, releases the claim with the error, and can be retried", async () => {
  const who = await person();
  const { draft } = await relanceDraft(who);
  toolImpl = async () => ({ text: "Gmail said no", isError: true });
  const failed = await call(who, `${BASE}/${draft.id}/push`, "POST");
  expect(failed.status).toBe(502);
  expect(await store.getDraft(who, draft.id)).toMatchObject({ status: "draft", claimedAt: null, lastError: "Gmail said no" });
  toolImpl = async () => { throw new Error("declined"); };
  expect((await call(who, `${BASE}/${draft.id}/push`, "POST")).status).toBe(502);
  expect((await json(await call(who, `${BASE}/${draft.id}`))).lastError).toBe("declined");
});

test("push without a tool wired is 503 and claims nothing", async () => {
  const who = await person();
  const { draft } = await relanceDraft(who);
  expect((await call(who, `${BASE}/${draft.id}/push`, "POST", undefined, build({ callTool: false }))).status).toBe(503);
  expect(await store.getDraft(who, draft.id)).toMatchObject({ claimedAt: null });
});

test("another owner gets 404 everywhere", async () => {
  const who = await person();
  const stranger = await person();
  const { draft, mission, relanceId } = await relanceDraft(who);
  const offerId = await offerOf(who, true);
  for (const [method, path, body] of [
    ["GET", `${BASE}/${draft.id}`, undefined],
    ["GET", `${BASE}/${draft.id}/attachment`, undefined],
    ["PATCH", `${BASE}/${draft.id}`, { subject: "x" }],
    ["POST", `${BASE}/${draft.id}/dismiss`, undefined],
    ["POST", `${BASE}/${draft.id}/push`, undefined],
    ["POST", BASE, { kind: "relance", missionId: mission.id, relanceId }],
    ["POST", BASE, { kind: "application", offerId }],
  ] as const) {
    expect((await call(stranger, path, method, body)).status).toBe(404);
  }
  expect((await json(await call(stranger, BASE))).drafts).toEqual([]);
  expect(toolCalls).toHaveLength(0);
});

test("dismiss ends a draft; a pushed one cannot be dismissed", async () => {
  const who = await person();
  const { draft } = await relanceDraft(who);
  const res = await call(who, `${BASE}/${draft.id}/dismiss`, "POST");
  expect(res.status).toBe(200);
  expect((await json(res)).status).toBe("dismissed");
  const other = await relanceDraft(who);
  await call(who, `${BASE}/${other.draft.id}/push`, "POST");
  expect((await call(who, `${BASE}/${other.draft.id}/dismiss`, "POST")).status).toBe(409);
});
