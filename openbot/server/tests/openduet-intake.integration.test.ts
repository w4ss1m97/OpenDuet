import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import type { CallTool } from "../src/openduet/brief";
import { lastIntakeReport, runIntake } from "../src/openduet/items/intake";
import type { HostRunner } from "../src/openduet/items/notes-scanner";
import { createItemStore } from "../src/openduet/items/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The intake reads every source on its own: one that fails keeps its cursor and is named in the
 * report, the others still run, and a second run over the same inputs writes nothing new.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `openduet-intake-${randomUUID()}`;
const owners = [1, 2, 3, 4].map((n) => `${prefix}-owner-${n}`);
const store = createItemStore(database);
const now = () => new Date("2026-11-07T08:00:00Z");

const mail = {
  messages: [
    {
      id: `${prefix}-bill`,
      from: "Énergie <facture@energie-exemple.fr>",
      subject: "Votre facture",
      date: "2026-11-05T07:00:00.000Z",
      snippet: "Montant : 45,00 € à payer avant le 20/11/2026.",
    },
  ],
};
const calendar = {
  events: [{ id: `${prefix}-ev`, summary: "Entretien Acme", start: "2026-11-12T14:00:00+01:00" }],
};
const notes = JSON.stringify([
  { id: `${prefix}-note`, name: "Idées", modified: "2026-11-06T20:00:00.000Z", body: "Idée: podcast SRE" },
]);

function callTool(failing: string[] = []): { call: CallTool; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const call: CallTool = async ({ ref, args }) => {
    seen.push({ ref, ...args });
    if (failing.some((f) => ref.includes(f))) return { text: "token expired", isError: true };
    if (ref.endsWith("gmail_search_messages")) return { text: JSON.stringify(mail), isError: false };
    return { text: JSON.stringify(calendar), isError: false };
  };
  return { call, seen };
}

const host: HostRunner = async (command) =>
  command.startsWith("osascript")
    ? { ok: true, output: notes }
    : { ok: true, output: command.startsWith("cat") ? "## Exact next step\nShip it" : "feat: x" };

const deps = (owner: string, call: CallTool, h: HostRunner | null) => ({
  store,
  callTool: call,
  host: h,
  projects: [{ id: "openduet", name: "OpenDuet", path: "~/src/OpenDuet" }],
  now,
});

beforeAll(async () => {
  await database.insert(users).values(owners.map((id) => ({ id, email: `${id}@example.test` })));
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, owners));
});

test("adds active interview and bill, proposed idea and project status", async () => {
  const owner = owners[0] ?? "";
  const report = await runIntake(deps(owner, callTool().call, host), owner, "bot");
  expect(report.failed).toEqual([]);
  const active = await store.list(owner, { status: ["active"] });
  const proposed = await store.list(owner, { status: ["proposed"] });
  expect(active.map((i) => i.kind).sort()).toEqual(["bill", "interview"]);
  expect(proposed.map((i) => i.kind).sort()).toEqual(["idea", "project_status"]);
  expect(report).toMatchObject({ added: 2, proposed: 2 });
  expect(active.find((i) => i.kind === "interview")?.remindAt).toHaveLength(2);
  expect(lastIntakeReport(owner)).toEqual(report);
});

test("gmail failure leaves its cursor and still runs calendar", async () => {
  const owner = owners[1] ?? "";
  const report = await runIntake(deps(owner, callTool(["gmail"]).call, host), owner, "bot");
  expect(report.failed).toEqual([{ scanner: "mail", error: "token expired" }]);
  expect((await store.getCursor(owner, "mail")).lastSuccessAt).toBeNull();
  expect((await store.getCursor(owner, "calendar")).lastSuccessAt).not.toBeNull();
  expect((await store.list(owner, {})).some((i) => i.kind === "interview")).toBe(true);
});

test("host null marks notes and projects as failed", async () => {
  const owner = owners[2] ?? "";
  const report = await runIntake(deps(owner, callTool().call, null), owner, "bot");
  expect(report.failed.map((f) => f.scanner).sort()).toEqual(["notes", "projects"]);
  expect(report.failed[0]?.error).toBe("Mac bridge non connecté");
});

test("second run with same inputs adds nothing", async () => {
  const owner = owners[3] ?? "";
  await runIntake(deps(owner, callTool().call, host), owner, "bot");
  const again = await runIntake(deps(owner, callTool().call, host), owner, "bot");
  expect(again).toMatchObject({ added: 0, proposed: 0 });
});

test("calendar is read for the next 14 days and mail since the last success", async () => {
  const owner = owners[3] ?? "";
  const { call, seen } = callTool();
  await runIntake(deps(owner, call, host), owner, "bot");
  const cal = seen.find((s) => String(s.ref).endsWith("calendar_list_events"));
  expect(cal).toMatchObject({
    timeMin: "2026-11-07T08:00:00.000Z",
    timeMax: "2026-11-21T08:00:00.000Z",
  });
  const gmail = seen.filter((s) => String(s.ref).endsWith("gmail_search_messages"));
  expect(gmail.length).toBeGreaterThan(1);
  for (const g of gmail) expect(String(g.query)).toEndWith(" newer_than:1d");
});
