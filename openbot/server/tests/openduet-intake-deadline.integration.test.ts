import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import type { CallTool } from "../src/openduet/brief";
import { runIntake } from "../src/openduet/items/intake";
import type { HostRunner } from "../src/openduet/items/notes-scanner";
import { createItemStore } from "../src/openduet/items/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/** No source can hold the intake: one that never answers fails at its deadline, the rest still run. */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const owner = `openduet-intake-deadline-${randomUUID()}`;
const store = createItemStore(database);

beforeAll(async () => {
  await database.insert(users).values({ id: owner, email: `${owner}@example.test` });
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner]));
});

test("a project read that never answers fails at the deadline and the run still ends", async () => {
  const call: CallTool = async ({ ref }) => ({
    text: JSON.stringify(ref.endsWith("calendar_list_events") ? { events: [] } : { messages: [] }),
    isError: false,
  });
  const hangs: HostRunner = () => new Promise(() => {});
  const started = Date.now();
  const report = await runIntake(
    {
      store,
      callTool: call,
      host: hangs,
      projects: [{ id: "p", name: "P", path: "~/Documents/p" }],
      now: () => new Date(),
      scannerTimeoutMs: 100,
    },
    owner,
    "bot",
  );
  expect(Date.now() - started).toBeLessThan(2000);
  expect(report.failed.map((f) => f.scanner)).toEqual(["notes", "projects"]);
  expect(report.failed[1]?.error).toBe("Source illisible : pas de réponse à temps.");
  expect((await store.getCursor(owner, "mail")).lastSuccessAt).not.toBeNull();
});
