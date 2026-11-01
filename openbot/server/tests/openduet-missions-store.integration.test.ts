import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetItems } from "../src/db/schema/openduet-items";
import { openduetMissionEvents, openduetMissions } from "../src/db/schema/openduet-missions";
import { createDebriefStore } from "../src/openduet/missions/debrief-store";
import { parisDate } from "../src/openduet/items/paris-time";
import { createItemStore } from "../src/openduet/items/store";
import {
  IllegalTransitionError,
  MissionConflictError,
  MissionNotFoundError,
  UntrustedMatchError,
  createMissionStore,
} from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The mission store moves a mission forward once per source, whatever order or how many times the
 * signals arrive, never lets a mail alone close a mission on a company-name guess, and keeps every
 * person's missions to themselves.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-missions-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const store = createMissionStore(database);
const itemStore = createItemStore(database);

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
});

async function applied(company = `Acme ${randomUUID()}`, role: string | undefined = undefined) {
  const { mission } = await store.createPiste(owner, { company, role, review: "active", stage: "applied" });
  return mission;
}

const mailBy = (matchedBy: "thread" | "contact" | "company", sourceHash = `mail:${randomUUID()}`) => ({
  source: "mail" as const,
  matchedBy,
  sourceHash,
});

test("createPiste normalizes the company and returns the existing open mission for the same company and role", async () => {
  const company = `Société ${randomUUID()}`;
  const first = await store.createPiste(owner, { company, role: "Lead dev", review: "proposed" });
  expect(first.created).toBe(true);
  expect(first.mission.stage).toBe("piste");
  const again = await store.createPiste(owner, { company: `${company.toUpperCase()} SAS`, role: "lead dev", review: "proposed" });
  expect(again.created).toBe(false);
  expect(again.mission.id).toBe(first.mission.id);
});

test("two roles at one company are two missions", async () => {
  const company = `Duo ${randomUUID()}`;
  const a = await store.createPiste(owner, { company, role: "Dev", review: "active" });
  const b = await store.createPiste(owner, { company, role: "Data", review: "active" });
  expect(a.mission.id).not.toBe(b.mission.id);
});

test("advance moves forward, may skip a stage, and records one event", async () => {
  const m = await applied();
  const r = await store.advance(owner, m.id, { to: "interview", ...mailBy("thread", "mail:invite") });
  expect(r.moved).toBe(true);
  expect(r.mission.stage).toBe("interview");
  const events = await database.select().from(openduetMissionEvents).where(eq(openduetMissionEvents.missionId, m.id));
  expect(events.map((e) => [e.type, e.fromStage, e.toStage])).toEqual([["stage", "applied", "interview"]]);
});

test("reading the same mail twice changes nothing", async () => {
  const m = await applied();
  const hash = `mail:${randomUUID()}`;
  await store.advance(owner, m.id, { to: "talking", ...mailBy("thread", hash) });
  const second = await store.advance(owner, m.id, { to: "talking", ...mailBy("thread", hash) });
  expect(second.moved).toBe(false);
  expect(second.duplicate).toBe(true);
  const events = await database.select().from(openduetMissionEvents).where(eq(openduetMissionEvents.missionId, m.id));
  expect(events).toHaveLength(1);
});

test("a mail at or below the current stage only refreshes last_inbound_at", async () => {
  const m = await applied();
  await store.advance(owner, m.id, { to: "interview", ...mailBy("thread") });
  const at = new Date("2026-11-03T10:00:00Z");
  const r = await store.advance(owner, m.id, { to: "talking", at, ...mailBy("thread") });
  expect(r.moved).toBe(false);
  expect(r.mission.stage).toBe("interview");
  expect(r.mission.lastInboundAt).toEqual(at);
});

test("an illegal move from the app or chat throws and writes nothing", async () => {
  const m = await applied();
  await store.advance(owner, m.id, { to: "interview", source: "app" });
  await expect(store.advance(owner, m.id, { to: "talking", source: "chat", sourceHash: "chat:1" })).rejects.toBeInstanceOf(IllegalTransitionError);
  const events = await database.select().from(openduetMissionEvents).where(eq(openduetMissionEvents.missionId, m.id));
  expect(events).toHaveLength(1);
});

test("parallel advances land on the furthest stage with no error", async () => {
  const m = await applied();
  const results = await Promise.all([
    store.advance(owner, m.id, { to: "talking", ...mailBy("thread") }),
    store.advance(owner, m.id, { to: "interview", ...mailBy("thread") }),
    store.advance(owner, m.id, { to: "offer", ...mailBy("thread") }),
  ]);
  expect(results).toHaveLength(3);
  expect((await store.get(owner, m.id)).stage).toBe("offer");
});

test("parallel advance of the same mail moves once", async () => {
  const m = await applied();
  const hash = `mail:${randomUUID()}`;
  const results = await Promise.all([
    store.advance(owner, m.id, { to: "interview", ...mailBy("thread", hash) }),
    store.advance(owner, m.id, { to: "interview", ...mailBy("thread", hash) }),
  ]);
  expect(results.filter((r) => r.moved)).toHaveLength(1);
});

test("refused closes the mission and nothing leaves it", async () => {
  const m = await applied();
  const r = await store.advance(owner, m.id, { to: "refused", ...mailBy("contact") });
  expect(r.mission.closedAt).not.toBeNull();
  await expect(store.advance(owner, m.id, { to: "offer", source: "app" })).rejects.toBeInstanceOf(IllegalTransitionError);
});

test("a mail cannot refuse or make an offer on a company-name match, nor without a match kind", async () => {
  const m = await applied();
  await expect(store.advance(owner, m.id, { to: "refused", ...mailBy("company") })).rejects.toBeInstanceOf(UntrustedMatchError);
  await expect(store.advance(owner, m.id, { to: "offer", ...mailBy("company") })).rejects.toBeInstanceOf(UntrustedMatchError);
  await expect(store.advance(owner, m.id, { to: "offer", source: "mail", sourceHash: "mail:x" })).rejects.toBeInstanceOf(UntrustedMatchError);
  expect((await store.get(owner, m.id)).stage).toBe("applied");
  // A company match may still say they replied or invited.
  const r = await store.advance(owner, m.id, { to: "interview", ...mailBy("company") });
  expect(r.mission.stage).toBe("interview");
  // The person can always say it themselves.
  const done = await store.advance(owner, m.id, { to: "refused", source: "app", matchedBy: "app" });
  expect(done.mission.stage).toBe("refused");
});

test("matchMail: thread first, then contact, company only when it is the single open mission", async () => {
  const m = await applied(`Match ${randomUUID()}`);
  const threadId = `t-${randomUUID()}`;
  const email = `${randomUUID()}@match.test`;
  await store.recordInbound(owner, m.id, { at: new Date(), threadId, contactEmail: email });

  const byThread = await store.matchMail(owner, { threadId, from: "Someone <x@else.test>" });
  expect(byThread).toMatchObject({ kind: "match", matchedBy: "thread" });
  const byContact = await store.matchMail(owner, { threadId: "unknown", from: `Claire <${email.toUpperCase()}>` });
  expect(byContact).toMatchObject({ kind: "match", matchedBy: "contact" });
  const byCompany = await store.matchMail(owner, { company: m.company });
  expect(byCompany).toMatchObject({ kind: "match", matchedBy: "company" });
  expect(await store.matchMail(owner, { threadId: "nope", from: "Malt <hello@malt.fr>" })).toEqual({ kind: "none" });
  expect(await store.matchMail(other, { threadId })).toEqual({ kind: "none" });
});

test("matchMail on a company with two open roles is ambiguous", async () => {
  const company = `Twice ${randomUUID()}`;
  await store.createPiste(owner, { company, role: "A", review: "active" });
  await store.createPiste(owner, { company, role: "B", review: "active" });
  const r = await store.matchMail(owner, { company });
  expect(r.kind).toBe("ambiguous");
});

test("recordInbound adds a thread and a contact once", async () => {
  const m = await applied();
  const at = new Date();
  await store.recordInbound(owner, m.id, { at, threadId: "t1", contactEmail: "a@b.test" });
  const r = await store.recordInbound(owner, m.id, { at, threadId: "t1", contactEmail: "a@b.test" });
  expect(r.threadIds).toEqual(["t1"]);
  expect(r.contactEmails).toEqual(["a@b.test"]);
});

test("upsertFromChat creates, advances, or reports ambiguity", async () => {
  const company = `Chat ${randomUUID()}`;
  const created = await store.upsertFromChat(owner, { company, role: "Dev", stage: "applied" });
  expect(created.kind).toBe("created");
  const advanced = await store.upsertFromChat(owner, { company, stage: "interview" });
  expect(advanced).toMatchObject({ kind: "advanced" });
  await store.createPiste(owner, { company, role: "Other", review: "active" });
  const ambiguous = await store.upsertFromChat(owner, { company, stage: "offer" });
  expect(ambiguous.kind).toBe("ambiguous");
});

test("list filters by review and stage; contactsForQuery returns active open contacts, capped", async () => {
  const solo = `${prefix}-solo`;
  await database.insert(users).values({ id: solo, email: `${solo}@example.test` });
  try {
    const a = (await store.createPiste(solo, { company: "A", review: "active", stage: "applied" })).mission;
    const b = (await store.createPiste(solo, { company: "B", review: "proposed" })).mission;
    const c = (await store.createPiste(solo, { company: "C", review: "active", stage: "applied" })).mission;
    await store.recordInbound(solo, a.id, { at: new Date(), contactEmail: "a@x.test" });
    await store.recordInbound(solo, b.id, { at: new Date(), contactEmail: "b@x.test" });
    await store.recordInbound(solo, c.id, { at: new Date(), contactEmail: "c@x.test" });
    await store.advance(solo, c.id, { to: "refused", source: "app" });

    expect((await store.list(solo, { review: ["active"] })).map((m) => m.id)).toEqual(expect.arrayContaining([a.id, c.id]));
    expect((await store.list(solo, { open: true })).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(await store.contactsForQuery(solo)).toEqual(["a@x.test"]);
    expect(await store.contactsForQuery(solo, 0)).toEqual([]);
  } finally {
    await database.delete(users).where(eq(users.id, solo));
  }
});

test("patch accepts a proposal, renames, conflicts on a taken name, and merges", async () => {
  const company = `Patch ${randomUUID()}`;
  const proposed = (await store.createPiste(owner, { company, review: "proposed" })).mission;
  const accepted = await store.patch(owner, proposed.id, { review: "active" });
  expect(accepted.review).toBe("active");

  const taken = (await store.createPiste(owner, { company: `${company} other`, review: "active" })).mission;
  await expect(store.patch(owner, taken.id, { company })).rejects.toBeInstanceOf(MissionConflictError);

  await store.recordInbound(owner, taken.id, { at: new Date(), threadId: "merge-t", contactEmail: "m@x.test" });
  const [item] = await Promise.all([itemStore.insertIfNew(owner, { kind: "interview", title: "Call", sourceApp: "gmail", sourceHash: `g:${randomUUID()}`, dateExplicit: true }, "active", [])]);
  if (!item) throw new Error("not inserted");
  await database.update(openduetItems).set({ missionId: taken.id }).where(eq(openduetItems.id, item.id));

  const merged = await store.patch(owner, taken.id, { mergeInto: proposed.id });
  expect(merged.id).toBe(proposed.id);
  expect(merged.threadIds).toContain("merge-t");
  expect(merged.contactEmails).toContain("m@x.test");
  expect((await store.get(owner, taken.id)).review).toBe("dismissed");
  const [moved] = await database.select().from(openduetItems).where(eq(openduetItems.id, item.id));
  expect(moved?.missionId).toBe(proposed.id);
});

test("relances: one per silence window, none past two per stage, sent moves the window", async () => {
  const m = await applied();
  const silent = parisDate(2026, 11, 2, 9);
  await database.execute(
    sql`UPDATE openduet_missions SET stage_entered_at = ${silent.toISOString()}::timestamptz WHERE id = ${m.id}`,
  );
  const friday = parisDate(2026, 11, 6, 9);
  const monday = parisDate(2026, 11, 9, 9);
  expect(await store.ensureRelance(owner, m.id, friday)).toBeNull();

  const first = await store.ensureRelance(owner, m.id, monday);
  expect(first?.status).toBe("draft");
  expect(first?.body).toContain("Bonjour");
  const same = await store.ensureRelance(owner, m.id, parisDate(2026, 11, 10, 9));
  expect(same?.id).toBe(first?.id);

  await store.setRelanceStatus(owner, m.id, first!.id, "sent", monday);
  expect(await store.ensureRelance(owner, m.id, parisDate(2026, 11, 13, 9))).toBeNull();
  const second = await store.ensureRelance(owner, m.id, parisDate(2026, 11, 16, 9));
  expect(second?.id).not.toBe(first?.id);
  await store.setRelanceStatus(owner, m.id, second!.id, "sent", parisDate(2026, 11, 16, 9));
  expect(await store.ensureRelance(owner, m.id, parisDate(2026, 12, 7, 9))).toBeNull();
});

async function interviewMission() {
  const { mission } = await store.createPiste(owner, { company: `Acme ${randomUUID()}`, review: "active", stage: "interview" });
  await database.execute(
    sql`UPDATE openduet_missions SET stage_entered_at = ${parisDate(2026, 10, 1, 9).toISOString()}::timestamptz WHERE id = ${mission.id}`,
  );
  return mission;
}
async function linkedInterview(missionId: string, dueAt: Date, status: "active" | "done" = "active") {
  const item = await itemStore.insertIfNew(owner, { kind: "interview", title: "Entretien", dueAt, sourceApp: "gcal", sourceHash: `gcal:${randomUUID()}`, dateExplicit: true }, status, []);
  if (!item) throw new Error("not inserted");
  await database.update(openduetItems).set({ missionId }).where(eq(openduetItems.id, item.id));
  return item;
}

test("relances, interview stage: due 5 business days after the interview ended, never before or without one", async () => {
  const m = await interviewMission();
  expect(await store.ensureRelance(owner, m.id, parisDate(2026, 11, 20, 9))).toBeNull();
  await linkedInterview(m.id, parisDate(2026, 11, 2, 10));
  expect(await store.ensureRelance(owner, m.id, parisDate(2026, 11, 6, 12))).toBeNull();
  const relance = await store.ensureRelance(owner, m.id, parisDate(2026, 11, 9, 12));
  expect(relance?.status).toBe("draft");
  expect(relance?.body).toContain("Bonjour");
  expect(relance?.windowStart.getTime()).toBe(parisDate(2026, 11, 2, 11).getTime());
  expect((await store.ensureRelance(owner, m.id, parisDate(2026, 11, 10, 12)))?.id).toBe(relance?.id);
});

test("relances, interview stage: an interview marked done still counts, a done future one does not block", async () => {
  const m = await interviewMission();
  await linkedInterview(m.id, parisDate(2026, 11, 2, 10), "done");
  await linkedInterview(m.id, parisDate(2026, 11, 20, 10), "done");
  const relance = await store.ensureRelance(owner, m.id, parisDate(2026, 11, 9, 12));
  expect(relance?.windowStart.getTime()).toBe(parisDate(2026, 11, 2, 11).getTime());
});

test("relances, interview stage: none while a next round is scheduled", async () => {
  const m = await interviewMission();
  await linkedInterview(m.id, parisDate(2026, 11, 2, 10));
  await linkedInterview(m.id, parisDate(2026, 11, 20, 10));
  expect(await store.ensureRelance(owner, m.id, parisDate(2026, 11, 9, 12))).toBeNull();
});

test("relances: a ready debrief's follow-up becomes the body, and a draft body is refreshed but not a sent one", async () => {
  const m = await interviewMission();
  const item = await linkedInterview(m.id, parisDate(2026, 11, 2, 10));
  const first = await store.ensureRelance(owner, m.id, parisDate(2026, 11, 9, 12));
  expect(first?.body).toContain("Bonjour");
  const generic = first?.body;

  const debriefs = createDebriefStore(database);
  await debriefs.ensurePending(owner, item.id, m.id, `m-${randomUUID()}`);
  const claim = await debriefs.claim(owner, item.id);
  await debriefs.complete(owner, item.id, claim?.claimedAt as Date, { summary: "s", positives: [], concerns: [], nextSteps: [], followUpBody: "Merci pour l'entretien" }, parisDate(2026, 11, 2, 11));

  const refreshed = await store.ensureRelance(owner, m.id, parisDate(2026, 11, 10, 12));
  expect(refreshed?.id).toBe(first?.id);
  expect(refreshed?.body).toBe("Merci pour l'entretien");
  expect(refreshed?.body).not.toBe(generic);

  await store.setRelanceStatus(owner, m.id, refreshed!.id, "sent", parisDate(2026, 11, 10, 12));
  await database.execute(sql`UPDATE openduet_interview_debriefs SET content = jsonb_set(content, '{followUpBody}', '"Autre"') WHERE item_id = ${item.id}`);
  const after = await database.execute(sql`SELECT body, status FROM openduet_mission_relances WHERE id = ${refreshed!.id}`);
  expect(after[0]).toMatchObject({ body: "Merci pour l'entretien", status: "sent" });
  await store.ensureRelance(owner, m.id, parisDate(2026, 11, 11, 12));
  const still = await database.execute(sql`SELECT body, status FROM openduet_mission_relances WHERE id = ${refreshed!.id}`);
  expect(still[0]).toMatchObject({ body: "Merci pour l'entretien", status: "sent" });
});

test("relances: an applied mission is relanced as before, whatever interview is scheduled later", async () => {
  const m = await applied();
  await database.execute(
    sql`UPDATE openduet_missions SET stage_entered_at = ${parisDate(2026, 11, 2, 9).toISOString()}::timestamptz WHERE id = ${m.id}`,
  );
  await linkedInterview(m.id, parisDate(2026, 11, 20, 10));
  expect(await store.ensureRelance(owner, m.id, parisDate(2026, 11, 9, 9))).not.toBeNull();
});

test("a person never sees or moves another person's mission", async () => {
  const m = await applied();
  await expect(store.get(other, m.id)).rejects.toBeInstanceOf(MissionNotFoundError);
  await expect(store.advance(other, m.id, { to: "talking", source: "app" })).rejects.toBeInstanceOf(MissionNotFoundError);
  await expect(store.patch(other, m.id, { review: "dismissed" })).rejects.toBeInstanceOf(MissionNotFoundError);
  expect((await store.list(other)).map((x) => x.id)).not.toContain(m.id);
});

test("deleting a mission leaves its items, unlinked", async () => {
  const m = await applied();
  const item = await itemStore.insertIfNew(owner, { kind: "followup", title: "Relancer", sourceApp: "duet", sourceHash: `d:${randomUUID()}`, dateExplicit: false }, "active", []);
  if (!item) throw new Error("not inserted");
  await database.update(openduetItems).set({ missionId: m.id }).where(eq(openduetItems.id, item.id));
  await database.delete(openduetMissions).where(eq(openduetMissions.id, m.id));
  const [still] = await database.select().from(openduetItems).where(eq(openduetItems.id, item.id));
  expect(still?.missionId).toBeNull();
});

test("only interviews and follow-ups may point to a mission", async () => {
  const m = await applied();
  const bill = await itemStore.insertIfNew(owner, { kind: "bill", title: "Facture", sourceApp: "gmail", sourceHash: `g:${randomUUID()}`, dateExplicit: true }, "active", []);
  if (!bill) throw new Error("not inserted");
  const attach = async () => {
    await database.update(openduetItems).set({ missionId: m.id }).where(eq(openduetItems.id, bill.id));
  };
  await expect(attach()).rejects.toThrow();
});
