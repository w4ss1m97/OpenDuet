import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { score, suggestions, highFindings, suggestionKey } from "../src/openduet/cockpit/quality-score";
import { createQualityService } from "../src/openduet/cockpit/quality-service";
import { createQualityStore } from "../src/openduet/cockpit/quality-store";
import type { QualityConfig, QualityResult } from "../src/openduet/cockpit/quality-parse";
import { CFG, healthy } from "./quality-fixtures.helper";

let dir: string;
let n = 0;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "q-svc-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

const NOW = Date.parse("2026-10-10T12:00:00Z");
const projects = ["A", "B", "C"].map((name) => ({ name, path: `/p/${name}` }));

function make(over: { scan?: (p: { name: string }, cfg: QualityConfig, nowSec: number) => Promise<QualityResult>; cfg?: Partial<QualityConfig> } = {}) {
  const store = createQualityStore({ path: join(dir, `s${n++}.json`), now: () => NOW });
  const calls: string[] = [];
  const scan = over.scan ?? (async (p) => {
    calls.push(p.name);
    return mk(p.name, NOW / 1000);
  });
  const service = createQualityService({
    store, listProjects: async () => projects, scan, now: () => NOW,
    config: async () => ({ config: { ...CFG, ...over.cfg }, error: null }),
  });
  return { store, service, calls };
}
function mk(project: string, scannedAt: number): QualityResult {
  const s = { ...healthy(), project, scannedAt };
  return { ...s, ...score(s, CFG), suggestions: suggestions(project, s, "main", CFG), highFindings: highFindings(s) };
}

describe("quality service", () => {
  test("only projects older than scanHours (or never scanned) are due", async () => {
    const { store, service, calls } = make();
    await store.saveScan(mk("A", NOW / 1000 - 25 * 3600));
    await store.saveScan(mk("B", NOW / 1000 - 3600));
    await service.runDue();
    expect(calls.sort()).toEqual(["A", "C"]);
    const sum = await service.summary();
    expect(sum.projects.map((p) => p.name).sort()).toEqual(["A", "B", "C"]);
    expect(sum.status.scanning).toBeNull();
    expect(sum.status.lastRun).toBe(NOW / 1000);
  });

  test("disabled in config: nothing is scanned", async () => {
    const { service, calls } = make({ cfg: { enabled: false } });
    await service.runDue();
    expect(calls).toEqual([]);
  });

  test("single flight, one project at a time; a failing project does not stop the queue", async () => {
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const { service } = make({
      scan: async (p) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        seen.push(p.name);
        if (p.name === "A") throw new Error("boom");
        return mk(p.name, NOW / 1000);
      },
    });
    await Promise.all([service.runDue(), service.runDue(), service.runDue()]);
    expect(peak).toBe(1);
    expect(seen.sort()).toEqual(["A", "B", "C"]);
    const sum = await service.summary();
    expect(sum.projects.map((p) => p.name).sort()).toEqual(["B", "C"]);
    expect(sum.status.lastError).toContain("A");
    expect(sum.status.lastError).toContain("boom");
  });

  test("GET answers while a scan runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { service } = make({ scan: async (p) => { await gate; return mk(p.name, NOW / 1000); } });
    const accepted = await service.requestScan("A");
    expect(accepted).toEqual({ accepted: true, queued: ["A"] });
    await new Promise((r) => setTimeout(r, 10));
    const sum = await service.summary();
    expect(sum.status.scanning).toBe("A");
    expect(await service.detail("A")).toBeNull();
    release();
    await service.idle();
    expect((await service.summary()).status.scanning).toBeNull();
    expect((await service.detail("A"))!.result.project).toBe("A");
  });

  test("scan requests are deduped; unknown name refused; all queues everything", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    const { service } = make({ scan: async (p) => { calls.push(p.name); await gate; return mk(p.name, NOW / 1000); } });
    expect(await service.requestScan("nope")).toEqual({ accepted: false, error: "unknown project" });
    await service.requestScan("A");
    await service.requestScan("A");
    const all = await service.requestScan("all");
    expect(all).toMatchObject({ accepted: true });
    release();
    await service.idle();
    expect(calls).toEqual(["A", "B", "C"]);
  });

  test("detail has a trend and suggestions with dismissedUntil; dismiss by key", async () => {
    const { store, service } = make();
    const r = mk("A", NOW / 1000);
    r.suggestions = [{ id: "no-ci", key: suggestionKey("A", "no-ci"), priority: "high", title: "t", evidence: "e", category: "tests" }];
    await store.saveScan(r);
    const key = suggestionKey("A", "no-ci");
    expect((await service.detail("A"))!.suggestions[0]).toMatchObject({ id: "no-ci", dismissedUntil: 0 });
    const res = await service.dismiss("A", key);
    expect(res).toEqual({ ok: true, until: NOW / 1000 + 30 * 86400 });
    expect((await service.detail("A"))!.suggestions[0]!.dismissedUntil).toBe(NOW / 1000 + 30 * 86400);
    expect(await service.dismiss("A", "0000000000000000")).toEqual({ ok: false, error: "unknown suggestion" });
    expect((await service.detail("A"))!.trend).toHaveLength(1);
    expect(await service.detail("zzz")).toBeNull();
  });

  test("start() checks once after the first delay, and stops", async () => {
    const { service, calls } = make();
    const stop = service.start({ firstDelayMs: 5, intervalMs: 100_000 });
    await new Promise((r) => setTimeout(r, 40));
    await service.idle();
    stop();
    expect(calls.sort()).toEqual(["A", "B", "C"]);
  });
});

describe("scanProject with fake tools", () => {
  test("builds a valid result, asks gh only for allowed shapes, never keeps secret text", async () => {
    const { scanProject, realScanDeps } = await import("../src/openduet/cockpit/quality-service");
    const { qualityResultSchema } = await import("../src/openduet/cockpit/quality-parse");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const root = join(dir, "proj");
    await mkdir(join(root, "src"), { recursive: true });
    const KEY = `${"AKIA"}${"Q".repeat(16)}`;
    await writeFile(join(root, "src", "a.ts"), `// TODO\nconst k = "${KEY}";\n`);
    await writeFile(join(root, "package.json"), "{}");
    const asked: string[] = [];
    const deps = {
      ...realScanDeps,
      git: async (_p: string, args: string[]) => {
        if (args[0] === "ls-files" && args.length === 2) return "src/a.ts\0package.json\0";
        if (args[0] === "remote") return "git@github.com:o/p.git\n";
        if (args[0] === "symbolic-ref") return "origin/main\n";
        return null;
      },
      ghApi: async (path: string) => {
        asked.push(path);
        return path.includes("dependabot") ? { ok: true as const, json: [] } : { ok: false as const, status: 404 };
      },
      npm: async (_p: string, kind: string) => (kind === "audit" ? null : "{}"),
    };
    const r = await scanProject({ name: "proj", path: root }, CFG, NOW / 1000, deps);
    expect(() => qualityResultSchema.parse(r)).not.toThrow();
    expect(r.repo).toBe("o/p");
    expect(r.security.local).toEqual([{ file: "src/a.ts", line: 2, type: "AWS access key id", severity: "high" }]);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(r.ci).toEqual({ available: false, why: "not set up" });
    expect(r.deps.npm).toEqual({ audit: null, outdated: { total: 0, major: 0, majorNames: [] } });
    expect(asked.some((a) => a.includes("secret-scanning") && a.endsWith("hide_secret=true"))).toBe(true);
    expect(r.suggestions.some((s) => s.id === "secret:src/a.ts:2")).toBe(true);
  });
});
