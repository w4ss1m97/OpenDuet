import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import { MISSION_UPDATE_TOOL, missionTools } from "../src/openduet/missions/tool";
import { createMissionStore } from "../src/openduet/missions/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** The Bot records "I applied to Acme" in chat: nothing, one, or several missions can match. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-missions-tool-${randomUUID()}`;
const owner = `${prefix}-owner`;
const store = createMissionStore(database);
const [tool] = missionTools({ actorId: owner, initiator: { kind: "person" }, store });
const run = async (args: Record<string, unknown>) => JSON.parse((await tool?.execute(args)) as string);
const tag = () => randomUUID().replace(/-/g, "").slice(0, 8);

beforeAll(async () => {
  await database.insert(users).values({ id: owner, email: `${owner}@example.test` });
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner]));
});

test("is named mission_update and tells the model to ask when several missions match", () => {
  expect(tool?.name).toBe(MISSION_UPDATE_TOOL);
  expect(tool?.ref).toBe("openduet/mission_update");
  expect(tool?.description).toMatch(/ambiguous/i);
  expect(tool?.description).toMatch(/ask/i);
});

test("no match creates an active mission at the stage given", async () => {
  const company = `Acme${tag()}`;
  const result = await run({ company, role: "Dev Rust", stage: "applied" });
  expect(result).toMatchObject({ created: true, mission: { stage: "applied" } });
  const [mission] = await store.list(owner, { stage: ["applied"] });
  expect(mission).toMatchObject({ review: "active" });
});

test("one match moves it forward, by chat", async () => {
  const company = `Beta${tag()}`;
  await run({ company, stage: "applied" });
  const result = await run({ company, stage: "interview" });
  expect(result).toMatchObject({ created: false, moved: true, mission: { stage: "interview" } });
});

test("several matches return the candidates and change nothing", async () => {
  const company = `Gamma${tag()}`;
  const a = await run({ company, role: "Dev Rust", stage: "applied" });
  const b = await run({ company, role: "Dev Go", stage: "applied" });
  const result = await run({ company, stage: "talking" });
  expect(result.ambiguous).toHaveLength(2);
  expect(result.ambiguous.map((m: { id: string }) => m.id).sort()).toEqual([a.mission.id, b.mission.id].sort());
  expect(result.ambiguous[0]).toHaveProperty("role");
  expect(result.ambiguous[0]).toHaveProperty("stage");
  expect((await store.get(owner, a.mission.id)).stage).toBe("applied");
});

test("a missionId picks the one to move", async () => {
  const company = `Delta${tag()}`;
  const a = await run({ company, role: "Dev Rust", stage: "applied" });
  await run({ company, role: "Dev Go", stage: "applied" });
  const result = await run({ missionId: a.mission.id, company, stage: "talking" });
  expect(result).toMatchObject({ moved: true, mission: { id: a.mission.id, stage: "talking" } });
});

test("a move backwards is refused in words, not thrown", async () => {
  const company = `Eps${tag()}`;
  await run({ company, stage: "interview" });
  const text = (await tool?.execute({ company, stage: "applied" })) as string;
  expect(text).toStartWith("Refused.");
});

test("an unknown stage or extra argument is refused", async () => {
  expect(await tool?.execute({ company: "X", stage: "dreaming" })).toStartWith("Refused.");
  expect(await tool?.execute({ company: "X", stage: "applied", extra: 1 })).toStartWith("Refused.");
});
