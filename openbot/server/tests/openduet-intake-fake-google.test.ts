import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { type FakeGoogle, startFakeGoogle } from "../../scripts/fake-google/server";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetItems } from "../src/db/schema/openduet-items";
import { openduetInterviewPreps } from "../src/db/schema/openduet-interview-preps";
import { openduetMissionRelances, openduetMissions } from "../src/db/schema/openduet-missions";
import type { CallTool } from "../src/openduet/brief";
import { runIntake } from "../src/openduet/items/intake";
import { createItemStore } from "../src/openduet/items/store";
import { createPrepStore } from "../src/openduet/missions/prep-store";
import { createMissionStore } from "../src/openduet/missions/store";
import { callTool as callGoogle } from "../src/plugins/google-workspace-rest";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The whole intake against the fake Google: mail delivered there comes back as items through the real
 * REST connector, Notes and projects are named as unreadable without the Mac, and a second run adds
 * nothing.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const owner = `openduet-intake-fake-${randomUUID()}`;
const store = createItemStore(database);
let fake: FakeGoogle;
let call: CallTool;

async function signIn(base: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const consent = new URL(`${base}/o/oauth2/v2/auth`);
  consent.search = new URLSearchParams({
    client_id: "test-client",
    redirect_uri: "http://127.0.0.1:3001/api/plugins/oauth/callback",
    response_type: "code",
    state: "s",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const back = new URL(
    (await fetch(consent, { redirect: "manual" })).headers.get("location") ?? "",
  );
  const tokens = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      client_id: "test-client",
      client_secret: "test-secret",
      redirect_uri: "http://127.0.0.1:3001/api/plugins/oauth/callback",
      code_verifier: verifier,
    }),
  });
  return ((await tokens.json()) as { access_token: string }).access_token;
}

async function deliver(from: string, subject: string, body: string) {
  const response = await fetch(`${fake.url}/__fake/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, subject, body }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; threadId: string };
}

beforeAll(async () => {
  fake = startFakeGoogle({ port: 0 });
  const connection = { url: fake.url, token: await signIn(fake.url) };
  call = async ({ ref, args }) => {
    const result = await callGoogle(connection, ref.split("/")[1] ?? "", args);
    return { text: result.text, isError: result.isError };
  };
  await database.insert(users).values({ id: owner, email: `${owner}@example.test` });
  await deliver(
    "Malt <notifications@malt.fr>",
    "Nouveau message de Camille sur votre mission DevOps",
    "Bonjour, votre profil nous intéresse pour une mission Kubernetes.",
  );
  await deliver(
    "Fournisseur Énergie <facture@energie-exemple.fr>",
    "Votre facture Duet-E2E est disponible",
    "Montant : 45,00 € à payer avant le 20/12/2099 par prélèvement.",
  );
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner]));
  await fake.stop();
});

test("intake against the fake Google: bill active with 2 reminders, Malt followup proposed", async () => {
  const deps = { store, callTool: call, host: null, projects: [], now: () => new Date() };
  const report = await runIntake(deps, owner, "bot");
  expect(report.failed.map((f) => f.scanner).sort()).toEqual(["notes", "projects"]);

  const items = await store.list(owner, {});
  const bill = items.find((i) => i.title === "Votre facture Duet-E2E est disponible");
  expect(bill).toMatchObject({ kind: "bill", status: "active", amount: 45 });
  expect(bill?.remindAt).toHaveLength(2);
  const malt = items.find((i) => i.title.startsWith("Nouveau message de Camille"));
  expect(malt).toMatchObject({ kind: "followup", status: "proposed", channelId: "missions" });

  const again = await runIntake(deps, owner, "bot");
  expect(again).toMatchObject({ added: 0, proposed: 0 });
});

// ---- Missions hook -------------------------------------------------------------------------------

const missions = createMissionStore(database);
const people: string[] = [];

async function person(): Promise<string> {
  const id = `openduet-intake-missions-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  people.push(id);
  return id;
}

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, people));
});

/** The fake Gmail has no `from:(a OR b)`: with one address it reads as `from:a`. Every query is kept. */
function recording(queries: string[]): CallTool {
  return async (input) => {
    if (input.ref.endsWith("gmail_search_messages")) {
      const query = String(input.args.query);
      queries.push(query);
      input = { ...input, args: { ...input.args, query: query.replace(/from:\(([^ )]+)\)/, "from:$1") } };
    }
    return call(input);
  };
}

const tag = () => randomUUID().replace(/-/g, "").slice(0, 8);
const depsFor = (callTool: CallTool, withMissions = true) => ({
  store,
  callTool,
  host: null,
  projects: [],
  now: () => new Date(),
  ...(withMissions ? { missions } : {}),
});
const itemFor = async (owner: string, id: string) =>
  (await database.select().from(openduetItems).where(and(eq(openduetItems.ownerUserId, owner), eq(openduetItems.sourceHash, `gmail:${id}`))))[0];

test("a reply on a known thread moves the mission applied -> talking and ties the item to it", async () => {
  const me = await person();
  const t = tag();
  const mail = await deliver("Malt <notifications@malt.fr>", `Réponse ${t}`, "Bonjour, merci pour votre candidature.");
  const { mission } = await missions.createPiste(me, { company: `Acme${t}`, review: "active", stage: "applied", threadId: mail.threadId });
  await runIntake(depsFor(call), me, "bot");
  const after = await missions.get(me, mission.id);
  expect(after.stage).toBe("talking");
  expect((await itemFor(me, mail.id))?.missionId).toBe(mission.id);
  expect((await missions.list(me, {})).filter((m) => m.id !== mission.id && m.title.includes(t))).toHaveLength(0);
});

test("an unmatched Malt mail makes one proposed piste, and a second run makes no other", async () => {
  const me = await person();
  const t = tag();
  const subject = `Nouvelle mission Rust ${t}`;
  const mail = await deliver("Malt <notifications@malt.fr>", subject, "Un client cherche un dev Rust.");
  await runIntake(depsFor(call), me, "bot");
  await runIntake(depsFor(call), me, "bot");
  const mine = (await missions.list(me, {})).filter((m) => m.title.includes(t));
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ review: "proposed", stage: "piste" });
  expect(mine[0]?.threadIds).toEqual([mail.threadId]);
  expect((await itemFor(me, mail.id))?.missionId).toBe(mine[0]?.id);
});

test("a company name alone never refuses a mission: the rejection is only noted", async () => {
  const me = await person();
  const t = tag();
  const company = `Zorblax${t}`;
  const { mission } = await missions.createPiste(me, { company, review: "active", stage: "applied" });
  await deliver("Malt <notifications@malt.fr>", `Candidature ${company}`, "Malheureusement, nous ne donnons pas suite.");
  await runIntake(depsFor(call), me, "bot");
  const after = await missions.get(me, mission.id);
  expect(after.stage).toBe("applied");
  expect(after.lastInboundAt).not.toBeNull();
  expect((await missions.list(me, {})).filter((m) => m.id !== mission.id && m.title.includes(t))).toHaveLength(0);
});

test("a rejection on the mission's own thread does refuse it", async () => {
  const me = await person();
  const t = tag();
  const mail = await deliver("Malt <notifications@malt.fr>", `Suite ${t}`, "Malheureusement, nous ne donnons pas suite.");
  const { mission } = await missions.createPiste(me, { company: `Beta${t}`, review: "active", stage: "applied", threadId: mail.threadId });
  await runIntake(depsFor(call), me, "bot");
  expect((await missions.get(me, mission.id)).stage).toBe("refused");
});

test("items are written as before whether or not missions are wired", async () => {
  const [plain, wired] = [await person(), await person()];
  const t = tag();
  const mail = await deliver("Malt <notifications@malt.fr>", `Item ${t}`, "Rendez-vous le 20/12/2099 à 10h pour un entretien.");
  await runIntake(depsFor(call, false), plain, "bot");
  await runIntake(depsFor(call, true), wired, "bot");
  const [a, b] = [await itemFor(plain, mail.id), await itemFor(wired, mail.id)];
  const shape = (i: typeof a) => ({ kind: i?.kind, title: i?.title, status: i?.status, channelId: i?.channelId, dueAt: i?.dueAt, remindAt: i?.remindAt });
  expect(shape(b)).toEqual(shape(a));
  expect(a?.missionId).toBeNull();
  expect(b?.missionId).not.toBeNull();
});

test("the contact query is issued only when a mission has a contact, and a contact's mail moves it", async () => {
  const none = await person();
  const noQueries: string[] = [];
  await runIntake(depsFor(recording(noQueries)), none, "bot");
  expect(noQueries.filter((q) => q.startsWith("from:("))).toEqual([]);

  const me = await person();
  const t = tag();
  const contact = `rh${t}@acme-contact.test`;
  const { mission } = await missions.createPiste(me, { company: `Gamma${t}`, review: "active", stage: "applied", contactEmail: contact });
  await deliver(`RH <${contact}>`, `Votre candidature ${t}`, "Pouvez-vous nous donner vos disponibilités pour un entretien ?");
  const queries: string[] = [];
  await runIntake(depsFor(recording(queries)), me, "bot");
  expect(queries.filter((q) => q.startsWith("from:("))).toHaveLength(1);
  expect(queries.find((q) => q.startsWith("from:("))).toContain(`from:(${contact})`);
  expect((await missions.get(me, mission.id)).stage).toBe("interview");
});

test("a silent mission gets one relance after a good run, none when the mail scanner failed", async () => {
  const me = await person();
  const { mission } = await missions.createPiste(me, { company: `Delta${tag()}`, review: "active", stage: "applied" });
  await database
    .update(openduetMissions)
    .set({ stageEnteredAt: new Date(Date.now() - 30 * 24 * 3600_000) })
    .where(eq(openduetMissions.id, mission.id));
  const relances = async () =>
    database.select().from(openduetMissionRelances).where(eq(openduetMissionRelances.missionId, mission.id));

  const broken = { ...missions, matchMail: async () => { throw new Error("db down"); } };
  const failed = await runIntake({ ...depsFor(call), missions: broken as typeof missions }, me, "bot");
  expect(failed.failed.map((f) => f.scanner)).toContain("mail");
  expect((await store.getCursor(me, "mail")).lastSuccessAt).toBeNull();
  expect(await relances()).toHaveLength(0);

  const ok = await runIntake(depsFor(call), me, "bot");
  expect(ok.failed.map((f) => f.scanner)).not.toContain("mail");
  expect(await relances()).toHaveLength(1);
  await runIntake(depsFor(call), me, "bot");
  expect(await relances()).toHaveLength(1);
});

// ---- Interview prep ------------------------------------------------------------------------------

const preps = createPrepStore(database);
const sheet = JSON.stringify({ pitch: "Pitch.", likelyQuestions: ["Q ?"], questionsToAsk: ["A ?"] });
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

type FakeEvent = { id: string; summary: string; start: string; organizer?: string; attendees?: string[] };

/** The fake calendar cannot be fed events: this serves the given ones and an empty prep mail search. */
function withEvents(events: FakeEvent[], searches: string[] = []): CallTool {
  return async (input) => {
    if (input.ref.endsWith("calendar_list_events")) return { text: JSON.stringify({ events }), isError: false };
    if (input.ref.endsWith("gmail_search_messages") && String(input.args.query).includes(" OR to:(")) {
      searches.push(String(input.args.query));
      return { text: JSON.stringify({ messages: [] }), isError: false };
    }
    return call(input);
  };
}
const prepDeps = (callTool: CallTool, complete: (prompt: string) => Promise<string>) => ({
  ...depsFor(callTool),
  prep: { store: preps, complete },
});
const itemOf = async (who: string, event: FakeEvent) =>
  (await database.select().from(openduetItems).where(and(eq(openduetItems.ownerUserId, who), eq(openduetItems.sourceHash, `gcal:${event.id}`))))[0];
const sheetsOf = async (who: string) =>
  database.select().from(openduetInterviewPreps).where(eq(openduetInterviewPreps.ownerUserId, who));

test("an attendee who is a mission contact links the interview, moves the mission and writes the sheet", async () => {
  const me = await person();
  const t = tag();
  const contact = `rh${t}@prep-contact.test`;
  const { mission } = await missions.createPiste(me, { company: `Eps${t}`, review: "active", stage: "applied", contactEmail: contact });
  const event = { id: `ev${t}`, summary: "Entretien technique", start: inHours(24), attendees: ["me@x.fr", contact.toUpperCase()] };
  const searches: string[] = [];
  const prompts: string[] = [];
  await runIntake(prepDeps(withEvents([event], searches), async (p) => (prompts.push(p), sheet)), me, "bot");
  expect((await itemOf(me, event))?.missionId).toBe(mission.id);
  expect((await missions.get(me, mission.id)).stage).toBe("interview");
  expect(searches[0]).toContain(`from:(${contact})`);
  expect(prompts).toHaveLength(1);
  expect(await sheetsOf(me)).toMatchObject([{ status: "ready", missionId: mission.id, attempts: 1 }]);
});

test("a contact match does not move another mission than the one the interview is already tied to", async () => {
  const me = await person();
  const t = tag();
  const contact = `rh${t}@prep-contact.test`;
  const { mission: picked } = await missions.createPiste(me, { company: `Pick${t}`, review: "active", stage: "talking" });
  const { mission: other } = await missions.createPiste(me, { company: `Oth${t}`, review: "active", stage: "applied", contactEmail: contact });
  const bare = { id: `ev${t}`, summary: "Entretien technique", start: inHours(24) };
  await runIntake(prepDeps(withEvents([bare]), async () => sheet), me, "bot");
  const item = await itemOf(me, bare);
  await store.setMission(me, item!.id, picked.id);
  await runIntake(prepDeps(withEvents([{ ...bare, attendees: [contact] }]), async () => sheet), me, "bot");
  expect((await itemOf(me, bare))?.missionId).toBe(picked.id);
  expect((await missions.get(me, other.id)).stage).toBe("applied");
});

test("a company in the title links without moving the stage", async () => {
  const me = await person();
  const t = tag();
  const { mission } = await missions.createPiste(me, { company: `Zeta${t}`, review: "active", stage: "applied" });
  const event = { id: `ev${t}`, summary: `Entretien Zeta${t} - lead`, start: inHours(20) };
  await runIntake(prepDeps(withEvents([event]), async () => sheet), me, "bot");
  expect((await itemOf(me, event))?.missionId).toBe(mission.id);
  expect((await missions.get(me, mission.id)).stage).toBe("applied");
  expect(await sheetsOf(me)).toHaveLength(1);
});

test("a model that throws fails the sheet, not the intake; it is retried, then left after three attempts", async () => {
  const me = await person();
  const t = tag();
  await missions.createPiste(me, { company: `Eta${t}`, review: "active", stage: "interview" });
  const event = { id: `ev${t}`, summary: `Entretien Eta${t}`, start: inHours(20) };
  let calls = 0;
  const deps = prepDeps(withEvents([event]), async () => {
    calls += 1;
    throw new TypeError("secret mail text");
  });
  const report = await runIntake(deps, me, "bot");
  expect(report.failed.map((f) => f.scanner)).not.toContain("calendar");
  expect(await sheetsOf(me)).toMatchObject([{ status: "failed", attempts: 1, lastError: "TypeError" }]);
  for (let i = 0; i < 4; i += 1) await runIntake(deps, me, "bot");
  expect(calls).toBe(3);
  expect(await sheetsOf(me)).toMatchObject([{ status: "failed", attempts: 3 }]);
});

test("without the prep dependency nothing is written", async () => {
  const me = await person();
  const t = tag();
  await missions.createPiste(me, { company: `Theta${t}`, review: "active", stage: "interview" });
  const event = { id: `ev${t}`, summary: `Entretien Theta${t}`, start: inHours(20) };
  await runIntake(depsFor(withEvents([event])), me, "bot");
  expect((await itemOf(me, event))?.missionId).not.toBeNull();
  expect(await sheetsOf(me)).toHaveLength(0);
});

test("at most three sheets are generated per run", async () => {
  const me = await person();
  const events: FakeEvent[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t = tag();
    await missions.createPiste(me, { company: `Iota${t}`, review: "active", stage: "interview" });
    events.push({ id: `ev${t}`, summary: `Entretien Iota${t}`, start: inHours(10 + i) });
  }
  let calls = 0;
  const deps = prepDeps(withEvents(events), async () => (calls += 1, sheet));
  await runIntake(deps, me, "bot");
  expect(calls).toBe(3);
  await runIntake(deps, me, "bot");
  expect(calls).toBe(5);
});

test("a ready sheet is kept when the event moves", async () => {
  const me = await person();
  const t = tag();
  await missions.createPiste(me, { company: `Kappa${t}`, review: "active", stage: "interview" });
  const event = { id: `ev${t}`, summary: `Entretien Kappa${t}`, start: inHours(20) };
  let calls = 0;
  const complete = async () => (calls += 1, sheet);
  await runIntake(prepDeps(withEvents([event]), complete), me, "bot");
  await runIntake(prepDeps(withEvents([{ ...event, start: inHours(30) }]), complete), me, "bot");
  expect(calls).toBe(1);
  expect(await sheetsOf(me)).toMatchObject([{ status: "ready" }]);
});
