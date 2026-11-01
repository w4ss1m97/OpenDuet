import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetItems } from "../src/db/schema/openduet-items";
import { openduetOfferSources, openduetOffers } from "../src/db/schema/openduet-job-offers";
import { openduetMissions } from "../src/db/schema/openduet-missions";
import type { CallTool } from "../src/openduet/brief";
import { runIntake } from "../src/openduet/items/intake";
import { createItemStore } from "../src/openduet/items/store";
import { createOfferStore } from "../src/openduet/job-offers/store";
import type { ProfileSource } from "../src/openduet/job-offers/profile";
import { createMissionStore } from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The offers sweep of the intake, against a fake Gmail and a fake model. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const items = createItemStore(database);
const missions = createMissionStore(database);
const offers = createOfferStore(database);
const people: string[] = [];

async function person(): Promise<string> {
  const id = `openduet-intake-offers-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  people.push(id);
  return id;
}
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, people));
});

const tag = () => randomUUID().replace(/-/g, "").slice(0, 8);
const PROFILE: ProfileSource = { text: async () => "Freelance DevOps AWS, Kubernetes, Terraform." };
const NO_PROFILE: ProfileSource = { text: async () => null };

type Alert = { id: string; subject: string; body: string; from?: string };
function alertMail(t: string, over: Partial<Alert> = {}): Alert {
  return { id: `a${tag()}`, subject: `Nouvelles offres pour vous ${t}`, body: "<p>Mission DevOps chez Acme, 700 €/jour</p>", ...over };
}

function fakeGmail(alerts: Alert[], opts: { searchFails?: boolean } = {}) {
  const calls = { read: 0, search: 0 };
  const callTool: CallTool = async ({ ref, args }) => {
    if (ref.endsWith("gmail_search_messages")) {
      calls.search += 1;
      if (opts.searchFails) return { text: "token expired", isError: true };
      return {
        text: JSON.stringify({
          messages: alerts.map((a) => ({
            id: a.id,
            threadId: `th-${a.id}`,
            from: a.from ?? "Malt <notifications@malt.fr>",
            subject: a.subject,
            date: new Date().toISOString(),
            snippet: "Découvrez vos nouvelles offres.",
          })),
        }),
        isError: false,
      };
    }
    if (ref.endsWith("gmail_read_message")) {
      calls.read += 1;
      const found = alerts.find((a) => a.id === args.id);
      return { text: JSON.stringify({ subject: found?.subject, body: found?.body }), isError: false };
    }
    return { text: JSON.stringify({ events: [], messages: [] }), isError: false };
  };
  return { callTool, calls };
}

const extractAnswer = (titles: string[]) =>
  JSON.stringify({
    offers: titles.map((title) => ({
      title,
      company: `Client ${title}`,
      tjmMin: 650,
      tjmMax: 750,
      rateUnit: "day",
      contract: "freelance",
      remote: "full",
      skills: ["AWS"],
      description: "Une mission.",
    })),
  });

/** A model that extracts `titles` from any alert, and scores an offer 80 when its title says HIGH, else 60. */
function fakeModel(titles: string[], opts: { failExtract?: boolean; failScore?: boolean } = {}) {
  const calls = { extract: 0, score: 0 };
  const complete = async (prompt: string): Promise<string> => {
    if (prompt.includes("Note de 0 à 100")) {
      calls.score += 1;
      if (opts.failScore) throw new Error("boom");
      return JSON.stringify({ score: prompt.includes("HIGH") ? 80 : 60, reasons: ["Stack proche"], missingSkills: [] });
    }
    calls.extract += 1;
    if (opts.failExtract) throw new Error("boom");
    return extractAnswer(titles);
  };
  return { complete, calls };
}

const depsFor = (
  callTool: CallTool,
  model: { complete: (prompt: string) => Promise<string> },
  profile: ProfileSource = PROFILE,
) => ({
  store: items,
  callTool,
  host: null,
  projects: [],
  now: () => new Date(),
  missions,
  offers: { store: offers, profile, complete: model.complete },
});
const sourcesOf = (me: string) => database.select().from(openduetOfferSources).where(eq(openduetOfferSources.ownerUserId, me));
const offersOf = (me: string) => database.select().from(openduetOffers).where(eq(openduetOffers.ownerUserId, me));

test("an alert makes a source and its offers, never an item or a piste", async () => {
  const me = await person();
  const t = tag();
  const gmail = fakeGmail([alertMail(t)]);
  const model = fakeModel([`HIGH Dev ${t}`, `Ops ${t}`]);
  const report = await runIntake(depsFor(gmail.callTool, model), me, "bot");
  expect(report.failed.map((f) => f.scanner)).not.toContain("mail");
  const [source] = await sourcesOf(me);
  expect(source).toMatchObject({ status: "done", platform: "malt", offersFound: 2 });
  expect(await offersOf(me)).toHaveLength(2);
  expect(await database.select().from(openduetItems).where(eq(openduetItems.ownerUserId, me))).toHaveLength(0);
  expect(await database.select().from(openduetMissions).where(eq(openduetMissions.ownerUserId, me))).toHaveLength(0);
});

test("a second run neither reads the mail nor calls the model again", async () => {
  const me = await person();
  const t = tag();
  const gmail = fakeGmail([alertMail(t)]);
  const model = fakeModel([`Dev ${t}`]);
  await runIntake(depsFor(gmail.callTool, model), me, "bot");
  const before = { read: gmail.calls.read, ...model.calls };
  await runIntake(depsFor(gmail.callTool, model), me, "bot");
  expect({ read: gmail.calls.read, ...model.calls }).toEqual(before);
  expect(await sourcesOf(me)).toHaveLength(1);
  expect(await offersOf(me)).toHaveLength(1);
});

test("a model that throws never fails the intake; the source is retried and left after 3 attempts", async () => {
  const me = await person();
  const gmail = fakeGmail([alertMail(tag())]);
  const model = fakeModel([], { failExtract: true });
  for (let run = 0; run < 3; run += 1) {
    const report = await runIntake(depsFor(gmail.callTool, model), me, "bot");
    expect(report.failed.map((f) => f.scanner)).not.toContain("mail");
  }
  const [source] = await sourcesOf(me);
  expect(source).toMatchObject({ status: "failed", attempts: 3, lastError: "Error" });
  expect(model.calls.extract).toBe(3);
  await runIntake(depsFor(gmail.callTool, model), me, "bot");
  expect(model.calls.extract).toBe(3);
  expect(gmail.calls.read).toBe(3);
});

test("an empty body is skipped without a model call", async () => {
  const me = await person();
  const gmail = fakeGmail([alertMail(tag(), { body: "  <p> </p> " })]);
  const model = fakeModel(["x"]);
  await runIntake(depsFor(gmail.callTool, model), me, "bot");
  expect((await sourcesOf(me))[0]?.status).toBe("skipped");
  expect(model.calls.extract).toBe(0);
});

test("at most 5 sources are read a run", async () => {
  const me = await person();
  const t = tag();
  const gmail = fakeGmail(Array.from({ length: 7 }, () => alertMail(t)));
  const model = fakeModel([`Dev ${t}`]);
  await runIntake(depsFor(gmail.callTool, model, NO_PROFILE), me, "bot");
  expect(gmail.calls.read).toBe(5);
  expect(model.calls.extract).toBe(5);
  const statuses = (await sourcesOf(me)).map((s) => s.status);
  expect(statuses.filter((s) => s === "done")).toHaveLength(5);
  expect(statuses.filter((s) => s === "pending")).toHaveLength(2);
});

test("at most 10 offers are scored a run", async () => {
  const me = await person();
  const t = tag();
  const gmail = fakeGmail([alertMail(t)]);
  const model = fakeModel(Array.from({ length: 12 }, (_, i) => `Dev${i} ${t}`));
  await runIntake(depsFor(gmail.callTool, model), me, "bot");
  expect(model.calls.score).toBe(10);
  const rows = await offersOf(me);
  expect(rows.filter((o) => o.status === "new")).toHaveLength(2);
});

test("without a profile nothing is scored and no attempt is spent", async () => {
  const me = await person();
  const t = tag();
  const gmail = fakeGmail([alertMail(t)]);
  const model = fakeModel([`Dev ${t}`]);
  await runIntake(depsFor(gmail.callTool, model, NO_PROFILE), me, "bot");
  expect(model.calls.score).toBe(0);
  const [offer] = await offersOf(me);
  expect(offer).toMatchObject({ status: "new", score: null, scoreAttempts: 0 });
});

test("a score of 80 is shown, a score of 60 is only scored", async () => {
  const me = await person();
  const t = tag();
  const gmail = fakeGmail([alertMail(t)]);
  const model = fakeModel([`HIGH Dev ${t}`, `Low Dev ${t}`]);
  await runIntake(depsFor(gmail.callTool, model), me, "bot");
  const rows = await offersOf(me);
  expect(rows.find((o) => o.title.startsWith("HIGH"))).toMatchObject({ status: "shown", score: 80 });
  expect(rows.find((o) => o.title.startsWith("Low"))).toMatchObject({ status: "scored", score: 60 });
  expect(rows[0]?.profileHash).toBeTruthy();
});

test("a failing score leaves the offer new and retried; it stops at 3", async () => {
  const me = await person();
  const t = tag();
  const gmail = fakeGmail([alertMail(t)]);
  const model = fakeModel([`Dev ${t}`], { failScore: true });
  for (let run = 0; run < 4; run += 1) await runIntake(depsFor(gmail.callTool, model), me, "bot");
  expect(model.calls.score).toBe(3);
  expect((await offersOf(me))[0]).toMatchObject({ status: "new", score: null, scoreAttempts: 3 });
});

test("the sweep runs even when the mail scanner failed", async () => {
  const me = await person();
  const t = tag();
  await offers.ensureSource(me, `gmail:pre${tag()}`, "malt", new Date());
  const alerts = fakeGmail([alertMail(t)]);
  // The pre-existing source has an id the fake Gmail does not know: it reads an empty body and is skipped.
  const failing = fakeGmail([], { searchFails: true });
  const model = fakeModel([`Dev ${t}`]);
  const report = await runIntake(depsFor(failing.callTool, model), me, "bot");
  expect(report.failed.map((f) => f.scanner)).toContain("mail");
  expect(failing.calls.read).toBe(1);
  expect((await sourcesOf(me))[0]?.status).toBe("skipped");
  expect(alerts.calls.read).toBe(0);
});

test("an offer mail is left alone when the offers are not wired", async () => {
  const me = await person();
  const gmail = fakeGmail([alertMail(tag())]);
  const { offers: _off, ...bare } = depsFor(gmail.callTool, fakeModel([]));
  await runIntake(bare, me, "bot");
  expect(await sourcesOf(me)).toHaveLength(0);
  expect(await database.select().from(openduetMissions).where(eq(openduetMissions.ownerUserId, me))).toHaveLength(0);
});
