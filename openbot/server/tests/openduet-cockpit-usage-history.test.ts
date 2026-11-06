import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importHistory } from "../scripts/import-cockpit-usage";
import { loadHistory } from "../src/openduet/cockpit/usage-history";
import { createUsageService } from "../src/openduet/cockpit/usage-service";
import type { UsageIngest } from "../src/openduet/cockpit/usage-ingest";
import { HOME, PROJECTS, config, row, storeWith } from "./support/usage-fixture";

const dir = mkdtempSync(join(tmpdir(), "history-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const dbPath = join(dir, "usage.db");
const db = new Database(dbPath);
db.run("create table usage(day text, hour integer, project text, session text, model text, agent text, agent_id text, input integer, cw5 integer, cw1h integer, cr integer, output integer, requests integer)");
const ins = db.prepare("insert into usage values(?,?,?,?,?,?,?,?,?,?,?,?,?)");
ins.run("2026-08-01", 9, "Alpha", "x1", "sonnet-4-5", "main", "", 1_000_000, 0, 0, 0, 0, 3);
ins.run("2026-08-01", 10, "Alpha", "x2", "sonnet-4-5", "main", "", 500_000, 0, 0, 0, 0, 1);
ins.run("2026-10-07", 9, "Beta", "x3", "sonnet-4-5", "main", "", 7, 0, 0, 0, 0, 1);
db.close();

describe("import-cockpit-usage", () => {
  test("keeps only rows before the cut-off, with synthetic session ids", () => {
    const out = join(dir, "h1", "usage-history.json");
    const res = importHistory({ db: dbPath, out, before: "2026-10-07" });
    expect(res).toMatchObject({ rows: 2, sessions: 1, firstDay: "2026-08-01", lastDay: "2026-08-01", written: true });
    const file = JSON.parse(readFileSync(out, "utf8"));
    expect(file.rows.every((r: { session: string }) => r.session === "history-alpha")).toBe(true);
    expect(file.sessions["history-alpha"]).toMatchObject({ name: "Alpha (Cockpit history)", dir: "", cwd: null });
    expect(importHistory({ db: dbPath, out, before: "2026-10-07" }).rows).toBe(2); // idempotent
  });
  test("file 0600 and dry-run writes nothing", () => {
    const out = join(dir, "h2", "usage-history.json");
    expect(importHistory({ db: dbPath, out, before: "2026-10-07", dryRun: true })).toMatchObject({ rows: 2, written: false });
    expect(existsSync(out)).toBe(false);
    importHistory({ db: dbPath, out, before: "2026-10-07" });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "h2")).mode & 0o777).toBe(0o700);
  });
});

const NOW = Date.parse("2026-10-30T12:00:00Z");
const service = (store: ReturnType<typeof storeWith>, historyPath: string) =>
  createUsageService({
    ingest: { ready: async () => undefined, runOnce: async () => undefined, store: () => store, status: () => ({ backfilling: false, filesDone: 0, filesTotal: 0, skippedLines: 0, lastError: null }) } as UsageIngest,
    config: { get: async () => ({ config: config(), error: null }) } as never,
    listProjects: () => PROJECTS,
    now: () => NOW,
    home: HOME,
    historyPath,
  });

describe("history merge", () => {
  const live = storeWith([row({ input: 1000, requests: 1 })], [["s1", "-Users-me-alpha", "/Users/me/alpha"]]);
  const snapshot = JSON.stringify(live);

  test("adds history rows for an old range, project label used directly, store untouched", async () => {
    const out = join(dir, "h3", "usage-history.json");
    importHistory({ db: dbPath, out, before: "2026-10-07" });
    const res = await service(live, out).summary("2026-07-30", "2026-08-02");
    expect(res.ok && res.body.days.length).toBeGreaterThan(0);
    if (res.ok) {
      expect(res.body.days[0]!.project).toBe("Alpha");
      expect(res.body.sessions[0]!.id).toBe("history-alpha");
    }
    expect(JSON.stringify(live)).toBe(snapshot);
    expect(Object.keys(live.rows).some((k) => k.includes("history-"))).toBe(false);
  });
  test("corrupt history is ignored", async () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{nope");
    expect((await loadHistory(bad)).history).toBeNull();
    const res = await service(live, bad).summary("2026-07-30", "2026-08-02");
    expect(res.ok && res.body.days.length).toBe(0);
    expect((await loadHistory(join(dir, "missing.json"))).note).toBeNull();
  });
});
