import { describe, expect, test } from "bun:test";
import {
  DEFAULT_THRESHOLDS,
  ago,
  attentionFor,
  buildAttention,
  clampThresholds,
} from "../src/openduet/cockpit/attention";
import type { ProjectData } from "../src/openduet/cockpit/types";

const NOW = 1_800_000_000; // seconds

function project(overrides: Partial<ProjectData> = {}): ProjectData {
  return {
    name: "Demo",
    path: "~/demo",
    error: null,
    repo: "o/r",
    repoUrl: "https://github.com/o/r",
    default: "main",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    hasRemote: true,
    dirty: { count: 0, oldest: null, files: [] },
    commits: [],
    notesLog: [],
    notes: { title: "", updated: null, mtime: NOW, blocked: false, waiting: false, nextStep: null, sections: [] },
    worktrees: [],
    prs: [],
    runs: [],
    sessions: [],
    newestCommit: NOW,
    ...overrides,
  };
}

const run = (o: Record<string, unknown> = {}) => ({
  id: 1, wid: 7, dynamic: false, workflow: "CI", branch: "main", status: "completed",
  conclusion: "failure", url: "https://github.com/o/r/actions/runs/1", updated: "", t: NOW - 7200, ...o,
});
const pr = (o: Record<string, unknown> = {}) => ({
  number: 4, title: "Add x", branch: "feat/x", url: "https://github.com/o/r/pull/4", draft: false,
  mergeState: "CLEAN", checks: "success" as const, updated: "", ...o,
});
const th = DEFAULT_THRESHOLDS;
const run1 = (p: ProjectData) => attentionFor(p, th, NOW);

describe("cockpit attention", () => {
  test("a clean project has nothing", () => {
    expect(run1(project())).toEqual([]);
  });

  test("an error gives one low item", () => {
    const items = run1({ name: "Demo", path: "~/demo", error: "not a git repository" });
    expect(items).toEqual([{ project: "Demo", severity: "low", message: "not a git repository", link: null }]);
  });

  test("failed CI on the default branch is high, with the run's link", () => {
    const [item] = run1(project({ runs: [run()] }));
    expect(item).toMatchObject({ severity: "high", link: "https://github.com/o/r/actions/runs/1" });
    expect(item!.message).toContain("«CI» failed on main (2h ago)");
  });

  test("only the latest run per workflow counts; Dependabot and other branches do not", () => {
    const runs = [
      run({ t: NOW - 7200 }),
      run({ id: 2, conclusion: "success", t: NOW - 3600 }),
      run({ id: 3, wid: 8, workflow: "Dep", dynamic: true }),
      run({ id: 4, wid: 9, workflow: "Other", branch: "feat/x" }),
      run({ id: 5, wid: 10, workflow: "Running", status: "in_progress", conclusion: null }),
    ];
    expect(run1(project({ runs }))).toEqual([]);
  });

  test("a green ready PR is medium; draft, red, DIRTY and BEHIND are not", () => {
    const prs = [pr(), pr({ number: 5, draft: true }), pr({ number: 6, checks: "failure" }), pr({ number: 7, mergeState: "DIRTY" }), pr({ number: 8, mergeState: "BEHIND" })];
    const items = run1(project({ prs }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: "medium", link: "https://github.com/o/r/pull/4" });
    expect(items[0]!.message).toContain("PR #4 is green");
  });

  test("uncommitted files older than dirtyHours are medium", () => {
    const old = project({ dirty: { count: 3, oldest: NOW - 25 * 3600, files: [] } });
    expect(run1(old)[0]).toMatchObject({ severity: "medium" });
    expect(run1(old)[0]!.message).toContain("3 uncommitted file(s), oldest 25h old");
    expect(run1(project({ dirty: { count: 3, oldest: NOW - 23 * 3600, files: [] } }))).toEqual([]);
  });

  test("unpushed commits are medium", () => {
    const items = run1(project({ ahead: 2, branch: "feat/x" }));
    expect(items[0]).toMatchObject({ severity: "medium", message: "2 commit(s) not pushed on feat/x" });
  });

  test("notes saying BLOCKED or waiting are medium", () => {
    const base = project().notes!;
    expect(run1(project({ notes: { ...base, blocked: true } }))[0]!.message).toBe("Session notes say BLOCKED");
    expect(run1(project({ notes: { ...base, waiting: true } }))[0]!.message).toBe("Session notes say waiting on the owner");
  });

  test("notes older than the newest commit by notesLagDays are low", () => {
    const base = project().notes!;
    const items = run1(project({ notes: { ...base, mtime: NOW - 3 * 86400 } }));
    expect(items[0]).toMatchObject({ severity: "low" });
    expect(items[0]!.message).toBe("Session notes are 3d older than the newest commit");
    expect(run1(project({ notes: { ...base, mtime: NOW - 86400 } }))).toEqual([]);
  });

  test("missing notes are low", () => {
    expect(run1(project({ notes: null }))[0]).toMatchObject({ severity: "low", message: "No .claude/session-notes.md" });
  });

  test("a worktree ahead of the default branch without a merged PR is medium", () => {
    const wt = { path: "/h/demo/.claude/worktrees/x", branch: "feat/x", ahead: 3, dirty: 0, prMerged: false };
    expect(run1(project({ worktrees: [wt] }))[0]!.message).toBe("Worktree x (feat/x) has 3 commit(s) not in main");
    expect(run1(project({ worktrees: [{ ...wt, prMerged: true }] }))).toEqual([]);
    expect(run1(project({ worktrees: [{ ...wt, ahead: 0 }] }))).toEqual([]);
  });

  test("idle sessions (not busy, older than sessionIdleHours) are low, busy and fresh are not", () => {
    const s = (o: Record<string, unknown>) => ({ pid: 1, sessionId: "a", cwd: "/h/demo", name: "chat", status: "idle", updatedAt: (NOW - 7 * 3600) * 1000, ...o });
    const items = run1(project({ sessions: [s({}), s({ name: "busy", status: "busy" }), s({ name: "fresh", updatedAt: (NOW - 3600) * 1000 })] }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: "low" });
    expect(items[0]!.message).toBe("1 Claude session(s) idle for more than 6h (longest 7h): «chat»");
  });

  test("buildAttention sorts high, medium, low and keeps project order inside a level", () => {
    const a = project({ name: "A", notes: null });
    const b = project({ name: "B", runs: [run()] });
    const c = project({ name: "C", ahead: 1 });
    const d = project({ name: "D", ahead: 1 });
    expect(buildAttention([a, b, c, d], th, NOW).map((i) => `${i.severity}:${i.project}`)).toEqual([
      "high:B", "medium:C", "medium:D", "low:A",
    ]);
  });

  test("thresholds are clamped to sane ranges", () => {
    expect(clampThresholds({})).toEqual({ dirtyHours: 24, notesLagDays: 2, sessionIdleHours: 6 });
    expect(clampThresholds({ dirtyHours: 0, notesLagDays: 0, sessionIdleHours: 0 })).toEqual({ dirtyHours: 1, notesLagDays: 0.5, sessionIdleHours: 1 });
    expect(clampThresholds({ dirtyHours: 1e9, notesLagDays: 1e9, sessionIdleHours: 1e9 })).toEqual({ dirtyHours: 720, notesLagDays: 90, sessionIdleHours: 720 });
    expect(clampThresholds({ dirtyHours: Number.NaN })).toMatchObject({ dirtyHours: 24 });
  });

  test("ago", () => {
    expect(ago(90)).toBe("1min");
    expect(ago(3600)).toBe("1h");
    expect(ago(172800)).toBe("2d");
    expect(ago(-5)).toBe("0min");
  });
});
