import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageIngest } from "../src/openduet/cockpit/usage-ingest";
import { emptyStore, loadStore, saveStore } from "../src/openduet/cockpit/usage-store";
import type { UsageRow } from "../src/openduet/cockpit/usage-types";

let root: string;
let projects: string;
let storePath: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "usage-ingest-"));
  projects = join(root, "projects");
  storePath = join(root, "config", "cockpit", "usage-store.json");
  await mkdir(join(projects, "-Users-me-proj"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const DIR = "-Users-me-proj";
const main = (sid = "s1") => join(projects, DIR, `${sid}.jsonl`);
const msg = (id: string, output: number, over: { input?: number; ts?: string; model?: string } = {}) =>
  `${JSON.stringify({
    type: "assistant",
    timestamp: over.ts ?? "2026-10-24T10:00:00.000Z",
    cwd: "/Users/me/proj",
    message: { id, model: over.model ?? "claude-opus-4-5-20251101", usage: { input_tokens: over.input ?? 100, output_tokens: output, cache_read_input_tokens: 1000 } },
  })}\n`;
const make = (extra: Record<string, unknown> = {}) => createUsageIngest({ projectsDir: projects, storePath, tz: "Europe/Paris", ...extra });
const totals = (rows: Record<string, UsageRow>) => {
  const all = Object.values(rows);
  return { requests: all.reduce((n, r) => n + r.requests, 0), output: all.reduce((n, r) => n + r.output, 0), input: all.reduce((n, r) => n + r.input, 0) };
};

describe("usage store", () => {
  test("round-trips, with a private file in a private folder and no temp left", async () => {
    const store = emptyStore();
    store.sessions.a = { id: "a", name: "A", dir: "d", cwd: "/x", first: 1, last: 2 };
    await saveStore(storePath, store);
    expect((await loadStore(storePath)).store).toEqual(store);
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "config", "cockpit"))).mode & 0o777).toBe(0o700);
    expect([...new Bun.Glob("*").scanSync(join(root, "config", "cockpit"))]).toEqual(["usage-store.json"]);
  });

  test("a missing file is an empty store; a corrupt one is empty with an error", async () => {
    expect(await loadStore(storePath)).toEqual({ store: emptyStore(), error: null });
    await mkdir(join(root, "config", "cockpit"), { recursive: true });
    await writeFile(storePath, "{broken");
    const loaded = await loadStore(storePath);
    expect(loaded.store).toEqual(emptyStore());
    expect(loaded.error).toBeTruthy();
  });
});

describe("usage ingest", () => {
  test("counts a transcript once and only reads what was appended", async () => {
    await writeFile(main(), msg("m1", 10) + msg("m2", 20));
    const ingest = make();
    await ingest.runOnce();
    expect(totals(ingest.store().rows)).toEqual({ requests: 2, output: 30, input: 200 });
    await ingest.runOnce();
    expect(totals(ingest.store().rows)).toEqual({ requests: 2, output: 30, input: 200 });
    await appendFile(main(), msg("m3", 5));
    await ingest.runOnce();
    expect(totals(ingest.store().rows)).toEqual({ requests: 3, output: 35, input: 300 });
  });

  test("rows carry the Paris day and hour, the model without claude- and the main agent", async () => {
    await writeFile(main(), msg("m1", 10, { ts: "2026-10-24T22:30:00.000Z" }));
    const ingest = make();
    await ingest.runOnce();
    expect(Object.values(ingest.store().rows)).toEqual([
      { day: "2026-10-25", hour: 0, session: "s1", model: "opus-4-5-20251101", agent: "main", agentId: "", input: 100, cw5: 0, cw1h: 0, cr: 1000, output: 10, requests: 1 },
    ]);
    expect(ingest.store().sessions.s1).toMatchObject({ id: "s1", dir: DIR, cwd: "/Users/me/proj", name: null });
  });

  test("a repeated message id adds only the output growth and no request", async () => {
    await writeFile(main(), msg("m1", 10) + msg("m1", 25) + msg("m1", 20));
    const ingest = make();
    await ingest.runOnce();
    expect(totals(ingest.store().rows)).toEqual({ requests: 1, output: 25, input: 100 });
  });

  test("the dedupe survives a restart", async () => {
    await writeFile(main(), msg("m1", 10));
    await make().runOnce();
    await appendFile(main(), msg("m1", 30) + msg("m2", 4));
    const again = make();
    await again.runOnce();
    expect(totals(again.store().rows)).toEqual({ requests: 2, output: 34, input: 200 });
  });

  test("a partial last line waits for its newline", async () => {
    const second = msg("m2", 20);
    await writeFile(main(), msg("m1", 10) + second.slice(0, 40));
    const ingest = make();
    await ingest.runOnce();
    expect(totals(ingest.store().rows).requests).toBe(1);
    await appendFile(main(), second.slice(40));
    await ingest.runOnce();
    expect(totals(ingest.store().rows)).toEqual({ requests: 2, output: 30, input: 200 });
  });

  test("lines that cross the 1 MiB read boundary are read whole", async () => {
    const filler = "x".repeat(900);
    const lines = Array.from({ length: 2500 }, (_, i) => `${JSON.stringify({ type: "user", pad: filler })}\n${msg(`m${i}`, 1)}`);
    await writeFile(main(), lines.join(""));
    const ingest = make();
    await ingest.runOnce();
    expect(totals(ingest.store().rows)).toEqual({ requests: 2500, output: 2500, input: 250_000 });
  });

  test("a truncated file is not recounted, and what is appended after is", async () => {
    await writeFile(main(), msg("m1", 10) + msg("m2", 20));
    const ingest = make();
    await ingest.runOnce();
    await truncate(main(), 50);
    await ingest.runOnce();
    expect(totals(ingest.store().rows).requests).toBe(2);
    await appendFile(main(), "\n" + msg("m3", 5));
    await ingest.runOnce();
    expect(totals(ingest.store().rows)).toEqual({ requests: 3, output: 35, input: 300 });
  });

  test("a file replaced by a new inode is not recounted", async () => {
    await writeFile(main(), msg("m1", 10));
    const ingest = make();
    await ingest.runOnce();
    const replacement = join(projects, DIR, "tmp-new");
    await writeFile(replacement, msg("m1", 10) + msg("m9", 99) + msg("m8", 99));
    await rename(replacement, main());
    await ingest.runOnce();
    expect(totals(ingest.store().rows).requests).toBe(1);
  });

  test("a deleted transcript keeps its rows", async () => {
    await writeFile(main(), msg("m1", 10));
    const ingest = make();
    await ingest.runOnce();
    await rm(main());
    await ingest.runOnce();
    expect(totals(ingest.store().rows).requests).toBe(1);
  });

  test("an oversized line is skipped and counted, the others still count", async () => {
    const huge = `${JSON.stringify({ type: "user", pad: "y".repeat(5000) })}\n`;
    await writeFile(main(), msg("m1", 10) + huge + msg("m2", 20));
    const ingest = make({ maxLineBytes: 2000 });
    await ingest.runOnce();
    expect(totals(ingest.store().rows).requests).toBe(2);
    expect(ingest.status().skippedLines).toBe(1);
    await ingest.runOnce();
    expect(ingest.status().skippedLines).toBe(1);
  });

  test("two runOnce calls at once share one pass", async () => {
    await writeFile(main(), msg("m1", 10));
    const ingest = make();
    const a = ingest.runOnce();
    const b = ingest.runOnce();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(totals(ingest.store().rows).requests).toBe(1);
  });

  test("a symlinked transcript or folder is ignored", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "evil.jsonl"), msg("m1", 10));
    await symlink(join(outside, "evil.jsonl"), main("linked"));
    await symlink(outside, join(projects, "-linked-dir"));
    const ingest = make();
    await ingest.runOnce();
    expect(Object.keys(ingest.store().rows)).toEqual([]);
  });

  test("a subagent transcript takes its agent type from the meta file", async () => {
    const sub = join(projects, DIR, "s1", "subagents");
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "agent-a1.jsonl"), msg("m1", 10, { model: "claude-haiku-4-5" }));
    await writeFile(join(sub, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Search the repo" }));
    await writeFile(join(sub, "agent-a2.jsonl"), msg("m2", 3, { model: "claude-haiku-4-5" }));
    const ingest = make();
    await ingest.runOnce();
    const rows = Object.values(ingest.store().rows).sort((a, b) => a.agentId.localeCompare(b.agentId));
    expect(rows.map((r) => [r.session, r.agent, r.agentId])).toEqual([
      ["s1", "Explore", "agent-a1"],
      ["s1", "subagent", "agent-a2"],
    ]);
    expect(ingest.store().subagents["s1|agent-a1"]).toEqual({ session: "s1", agentId: "agent-a1", agent: "Explore", description: "Search the repo" });
  });

  test("a custom-title line names the session", async () => {
    await writeFile(main(), `${JSON.stringify({ type: "custom-title", customTitle: "Fix the poller" })}\n${msg("m1", 10)}`);
    const ingest = make();
    await ingest.runOnce();
    expect(ingest.store().sessions.s1!.name).toBe("Fix the poller");
  });

  test("backfill status counts files and ends false; the store is saved", async () => {
    for (let i = 0; i < 5; i++) await writeFile(main(`s${i}`), msg(`m${i}`, 1));
    const ingest = make();
    await ingest.runOnce();
    expect(ingest.status()).toEqual({ backfilling: false, filesDone: 5, filesTotal: 5, skippedLines: 0, lastError: null });
    expect(totals((await loadStore(storePath)).store.rows).requests).toBe(5);
  });

  test("a missing projects folder or an unreadable store never throws", async () => {
    const ingest = createUsageIngest({ projectsDir: join(root, "nope"), storePath, tz: "UTC" });
    await ingest.runOnce();
    expect(ingest.status().lastError).toBeNull();
    const bad = createUsageIngest({ projectsDir: projects, storePath: join(root, "projects", "x", "store.json"), tz: "UTC" });
    await writeFile(main(), msg("m1", 1));
    await writeFile(join(projects, "x"), "file in the way");
    await bad.runOnce();
    expect(bad.status().lastError).toBeTruthy();
  });
});
