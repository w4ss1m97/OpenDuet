import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { openduetInterviewDebriefs } from "../src/db/schema/openduet-interview-debriefs";
import { openduetMissionEvents, openduetMissionRelances, openduetMissions } from "../src/db/schema/openduet-missions";
import type { CallTool } from "../src/openduet/brief";
import { runIntake } from "../src/openduet/items/intake";
import { createItemStore } from "../src/openduet/items/store";
import type { AnarlogMeeting, AnarlogSource } from "../src/openduet/missions/anarlog";
import { createDebriefStore } from "../src/openduet/missions/debrief-store";
import { createMissionStore } from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The debrief sweep of the intake, against a fake Anarlog and a fake model. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const store = createItemStore(database);
const missions = createMissionStore(database);
const debriefs = createDebriefStore(database);
const people: string[] = [];
const HOUR = 3600_000;

async function person(): Promise<string> {
  const id = `openduet-intake-debrief-${randomUUID()}`;
  await database.insert(users).values({ id, email: `${id}@example.test` });
  people.push(id);
  return id;
}
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, people));
});

const tag = () => randomUUID().replace(/-/g, "").slice(0, 8);
const empty: CallTool = async () => ({ text: JSON.stringify({ messages: [], events: [] }), isError: false });
const debriefJson = JSON.stringify({
  summary: "Bon échange.",
  positives: ["Équipe solide"],
  concerns: ["Budget"],
  nextSteps: ["Test technique"],
  followUpBody: "Bonjour, merci pour l'entretien.",
});

type FakeMeeting = AnarlogMeeting & { transcriptText: string };
function meetingAt(start: Date, contact: string, over: Partial<FakeMeeting> = {}): FakeMeeting {
  return {
    id: `m${tag()}`,
    title: "Entretien",
    startedAt: start,
    endedAt: new Date(start.getTime() + HOUR),
    participantEmails: [contact],
    transcriptReady: true,
    transcriptText: `SECRET-TRANSCRIPT-${tag()}`,
    ...over,
  };
}
function fakeSource(meetings: FakeMeeting[]) {
  const calls = { list: 0, get: 0, transcript: 0 };
  const source: AnarlogSource = {
    async listMeetings() {
      calls.list += 1;
      return meetings.map(({ id, title, startedAt, endedAt }) => ({ id, title, startedAt, endedAt }));
    },
    async getMeeting(id) {
      calls.get += 1;
      const found = meetings.find((m) => m.id === id);
      if (!found) throw new Error("no meeting");
      return found;
    },
    async transcript(id) {
      calls.transcript += 1;
      return { text: meetings.find((m) => m.id === id)?.transcriptText ?? "", cut: false };
    },
  };
  return { source, calls };
}
const depsFor = (debrief: { source: AnarlogSource; complete: (prompt: string) => Promise<string> } | null, now = () => new Date()) => ({
  store,
  callTool: empty,
  host: null,
  projects: [],
  now,
  missions,
  ...(debrief ? { debrief: { store: debriefs, ...debrief } } : {}),
});

async function interviewScenario(me: string, startedAgoMs = 3 * HOUR, over: { sameMission?: string } = {}) {
  const contact = `rh${tag()}@debrief-contact.test`;
  const mission = over.sameMission
    ? await missions.get(me, over.sameMission)
    : (await missions.createPiste(me, { company: `Co${tag()}`, review: "active", stage: "interview", contactEmail: contact })).mission;
  const email = mission.contactEmails[0] ?? contact;
  const start = new Date(Date.now() - startedAgoMs);
  const item = await store.insertIfNew(
    me,
    { kind: "interview", title: "Entretien", dueAt: start, sourceApp: "gcal", sourceHash: `gcal:${randomUUID()}`, dateExplicit: true },
    "active",
    [],
  );
  await store.setMission(me, item?.id ?? "", mission.id);
  return { mission, email, start, itemId: item?.id ?? "" };
}
const rowsOf = (me: string) => database.select().from(openduetInterviewDebriefs).where(eq(openduetInterviewDebriefs.ownerUserId, me));
const eventsOf = (missionId: string) =>
  database
    .select()
    .from(openduetMissionEvents)
    .where(and(eq(openduetMissionEvents.missionId, missionId), eq(openduetMissionEvents.type, "debrief")));

test("no interview due: Anarlog is never called", async () => {
  const me = await person();
  await interviewScenario(me, -5 * HOUR); // starts in five hours
  await interviewScenario(me, 10 * 24 * HOUR); // too old
  const { source, calls } = fakeSource([]);
  const report = await runIntake(depsFor({ source, complete: async () => debriefJson }), me, "bot");
  expect(report.failed.map((f) => f.scanner)).not.toContain("mail");
  expect(calls).toEqual({ list: 0, get: 0, transcript: 0 });
  expect(await rowsOf(me)).toHaveLength(0);
});

test("no matching meeting writes no row", async () => {
  const me = await person();
  const s = await interviewScenario(me);
  const stranger = meetingAt(s.start, "someone@else.test");
  const farOff = meetingAt(new Date(s.start.getTime() - 5 * HOUR), s.email);
  const { source, calls } = fakeSource([stranger, farOff]);
  let llm = 0;
  await runIntake(depsFor({ source, complete: async () => (llm += 1, debriefJson) }), me, "bot");
  expect(calls.list).toBe(1);
  expect(llm).toBe(0);
  expect(await rowsOf(me)).toHaveLength(0);
});

test("a transcript still processing writes no row and spends no attempt", async () => {
  const me = await person();
  const s = await interviewScenario(me);
  const meeting = meetingAt(s.start, s.email, { transcriptReady: false });
  const { source, calls } = fakeSource([meeting]);
  await runIntake(depsFor({ source, complete: async () => debriefJson }), me, "bot");
  expect(calls.transcript).toBe(0);
  expect(await rowsOf(me)).toHaveLength(0);
  meeting.transcriptReady = true;
  await runIntake(depsFor({ source, complete: async () => debriefJson }), me, "bot");
  expect(await rowsOf(me)).toMatchObject([{ status: "ready", attempts: 1 }]);
});

test("a match writes the debrief and one event at the meeting end; the transcript is not kept", async () => {
  const me = await person();
  const s = await interviewScenario(me);
  const meeting = meetingAt(s.start, s.email.toUpperCase());
  const { source } = fakeSource([meeting]);
  const prompts: string[] = [];
  const deps = depsFor({ source, complete: async (p) => (prompts.push(p), debriefJson) });
  await runIntake(deps, me, "bot");
  await runIntake(deps, me, "bot");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(meeting.transcriptText);
  const rows = await rowsOf(me);
  expect(rows).toMatchObject([{ status: "ready", missionId: s.mission.id, anarlogMeetingId: meeting.id }]);
  expect(JSON.stringify(rows)).not.toContain(meeting.transcriptText);
  const events = await eventsOf(s.mission.id);
  expect(events).toHaveLength(1);
  expect(events[0]?.at.getTime()).toBe(meeting.endedAt.getTime());
});

test("a model that throws fails the debrief, not the intake; retried, then left after three attempts", async () => {
  const me = await person();
  const s = await interviewScenario(me);
  const { source } = fakeSource([meetingAt(s.start, s.email)]);
  let calls = 0;
  const deps = depsFor({
    source,
    complete: async () => {
      calls += 1;
      throw new TypeError("secret transcript words");
    },
  });
  const report = await runIntake(deps, me, "bot");
  expect(report.failed.map((f) => f.scanner)).not.toContain("calendar");
  expect(await rowsOf(me)).toMatchObject([{ status: "failed", attempts: 1, lastError: "TypeError" }]);
  for (let i = 0; i < 4; i += 1) await runIntake(deps, me, "bot");
  expect(calls).toBe(3);
  expect(await rowsOf(me)).toMatchObject([{ status: "failed", attempts: 3 }]);
  expect(await eventsOf(s.mission.id)).toHaveLength(0);
});

test("a source that throws does not fail the intake", async () => {
  const me = await person();
  await interviewScenario(me);
  const source: AnarlogSource = {
    listMeetings: async () => {
      throw new Error("cli down");
    },
    getMeeting: async () => {
      throw new Error("cli down");
    },
    transcript: async () => {
      throw new Error("cli down");
    },
  };
  const report = await runIntake(depsFor({ source, complete: async () => debriefJson }), me, "bot");
  expect(report.failed.map((f) => f.scanner)).not.toContain("mail");
  expect(await rowsOf(me)).toHaveLength(0);
});

test("at most two debriefs are generated per run", async () => {
  const me = await person();
  const meetings: FakeMeeting[] = [];
  for (let i = 0; i < 3; i += 1) {
    const s = await interviewScenario(me, (3 + i * 6) * HOUR);
    meetings.push(meetingAt(s.start, s.email));
  }
  const { source } = fakeSource(meetings);
  let calls = 0;
  const deps = depsFor({ source, complete: async () => (calls += 1, debriefJson) });
  await runIntake(deps, me, "bot");
  expect(calls).toBe(2);
  await runIntake(deps, me, "bot");
  expect(calls).toBe(3);
  expect(await rowsOf(me)).toHaveLength(3);
});

test("two items for one interview give one debrief", async () => {
  const me = await person();
  const first = await interviewScenario(me);
  await interviewScenario(me, 3 * HOUR, { sameMission: first.mission.id });
  const { source } = fakeSource([meetingAt(first.start, first.email)]);
  let calls = 0;
  const deps = depsFor({ source, complete: async () => (calls += 1, debriefJson) });
  await runIntake(deps, me, "bot");
  await runIntake(deps, me, "bot");
  expect(calls).toBe(1);
  expect(await rowsOf(me)).toHaveLength(1);
  expect(await eventsOf(first.mission.id)).toHaveLength(1);
});

test("without the debrief dependency nothing is written", async () => {
  const me = await person();
  await interviewScenario(me);
  await runIntake(depsFor(null), me, "bot");
  expect(await rowsOf(me)).toHaveLength(0);
});

test("the debrief runs before the relances: a relance created in the same run carries the follow-up", async () => {
  const me = await person();
  const contact = `rh${tag()}@debrief-contact.test`;
  const { mission } = await missions.createPiste(me, { company: `Rel${tag()}`, review: "active", stage: "interview", contactEmail: contact });
  await database.update(openduetMissions).set({ stageEnteredAt: new Date("2026-09-01T10:00:00Z") }).where(eq(openduetMissions.id, mission.id));
  // Monday 9 November 2026, noon in Paris; the interview started just under seven days before.
  const now = new Date("2026-11-09T11:00:00Z");
  const start = new Date("2026-11-02T11:30:00Z");
  const item = await store.insertIfNew(
    me,
    { kind: "interview", title: "Entretien", dueAt: start, sourceApp: "gcal", sourceHash: `gcal:${randomUUID()}`, dateExplicit: true },
    "active",
    [],
  );
  await store.setMission(me, item?.id ?? "", mission.id);
  const { source } = fakeSource([meetingAt(start, contact)]);
  await runIntake(depsFor({ source, complete: async () => debriefJson }, () => now), me, "bot");
  const relances = await database.select().from(openduetMissionRelances).where(eq(openduetMissionRelances.missionId, mission.id));
  expect(relances).toHaveLength(1);
  expect(relances[0]?.body).toContain("merci pour l'entretien");
});
