import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTtlCache } from "../src/openduet/cockpit/cache";
import {
  checkStatus,
  collectProject,
  loadSessions,
  matchSessions,
  parseDirty,
  parseNotes,
  parseOrigin,
  parseWorktrees,
} from "../src/openduet/cockpit/collect";

describe("parseNotes", () => {
  const text = [
    "# Demo notes",
    "Updated: 2026-11-01",
    "## State",
    "All good",
    "## Decisions",
    "- one",
    "## Exact next step",
    "Run the thing.",
    "Then stop.",
  ].join("\n");

  test("title, updated, sections and the exact next step", () => {
    const n = parseNotes(text, 100);
    expect(n.title).toBe("Demo notes");
    expect(n.updated).toBe("2026-11-01");
    expect(n.mtime).toBe(100);
    expect(n.sections.map((s) => s.title)).toEqual(["State", "Decisions", "Exact next step"]);
    expect(n.nextStep).toBe("Run the thing.\nThen stop.");
    expect(n.blocked).toBe(false);
    expect(n.waiting).toBe(false);
  });

  test("blocked and waiting flags", () => {
    expect(parseNotes("## State\nBLOCKED on x", 0).blocked).toBe(true);
    expect(parseNotes("## State\nWaiting on the owner", 0).waiting).toBe(true);
    expect(parseNotes("## State\nblocked lowercase is fine", 0).blocked).toBe(false);
  });

  test("a section is cut to 4000 characters and no next step gives null", () => {
    const n = parseNotes(`## State\n${"x".repeat(5000)}`, 0);
    expect(n.sections[0]!.text).toHaveLength(4000);
    expect(n.nextStep).toBeNull();
  });
});

describe("small parsers", () => {
  test("parseOrigin takes github slugs from https and ssh urls", () => {
    expect(parseOrigin("https://github.com/o/r.git")).toBe("o/r");
    expect(parseOrigin("git@github.com:o/r.x")).toBe("o/r.x");
    expect(parseOrigin("https://github.com/o/r/")).toBe("o/r");
    expect(parseOrigin("https://gitlab.com/o/r")).toBeNull();
    expect(parseOrigin("")).toBeNull();
  });

  test("checkStatus", () => {
    expect(checkStatus(null)).toBe("none");
    expect(checkStatus([])).toBe("none");
    expect(checkStatus([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("success");
    expect(checkStatus([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");
    expect(checkStatus([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("failure");
    expect(checkStatus([{ __typename: "StatusContext", state: "SUCCESS" }])).toBe("success");
    expect(checkStatus([{ __typename: "StatusContext", state: "PENDING" }])).toBe("pending");
    expect(checkStatus([{ __typename: "StatusContext", state: "ERROR" }])).toBe("failure");
  });

  test("parseDirty reads porcelain -z entries", () => {
    const out = " M a.ts\0?? b.ts\0A  c.ts\0";
    expect(parseDirty(out).map((e) => e)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(parseDirty("")).toEqual([]);
  });

  test("parseWorktrees skips the main checkout, prunable and detached ones, and odd branch names", () => {
    const out = [
      "worktree /h/demo\nHEAD aaa\nbranch refs/heads/main",
      "worktree /h/demo/.claude/worktrees/x\nHEAD bbb\nbranch refs/heads/feat/x",
      "worktree /h/gone\nHEAD ccc\nbranch refs/heads/feat/gone\nprunable gitdir missing",
      "worktree /h/det\nHEAD ddd\ndetached",
      "worktree /h/evil\nHEAD eee\nbranch refs/heads/--upload-pack=x",
    ].join("\n\n");
    expect(parseWorktrees(out)).toEqual([{ path: "/h/demo/.claude/worktrees/x", branch: "feat/x" }]);
  });

  test("matchSessions matches the project and its worktrees by cwd prefix on a path boundary", () => {
    const s = (cwd: string) => ({ pid: 1, sessionId: cwd, cwd, name: "n", status: "idle", updatedAt: 1 });
    const all = [s("/h/demo"), s("/h/demo/sub"), s("/h/demo-other"), s("/h/wt"), s("/h/x")];
    expect(matchSessions(all, ["/h/demo", "/h/wt"]).map((x) => x.cwd)).toEqual(["/h/demo", "/h/demo/sub", "/h/wt"]);
  });
});

describe("loadSessions", () => {
  let dir: string;
  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-sessions-")));
    const ok = { pid: 11, sessionId: "s1", cwd: "/h/demo", name: "chat", status: "busy", updatedAt: 5, secret: "no", messagingSocketPath: "/tmp/x" };
    writeFileSync(join(dir, "11.json"), JSON.stringify(ok));
    writeFileSync(join(dir, "12.json"), JSON.stringify({ ...ok, pid: 12, sessionId: "dead" }));
    writeFileSync(join(dir, "13.json"), "not json");
    writeFileSync(join(dir, "14.json"), JSON.stringify({ pid: "x", sessionId: "bad" }));
    writeFileSync(join(dir, "11.abc.key"), JSON.stringify({ ...ok, pid: 11, sessionId: "fromkey" }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("keeps only the allowed fields of live sessions from *.json", async () => {
    const list = await loadSessions(dir, (pid) => pid === 11);
    expect(list).toEqual([{ pid: 11, sessionId: "s1", cwd: "/h/demo", name: "chat", status: "busy", updatedAt: 5 }]);
  });
});

describe("collectProject", () => {
  const HOME = "/h";
  type Script = Record<string, string | null>;
  /** A fake git that answers by its arguments (after -C path); anything not listed is a failure. */
  const gitOf = (script: Script, seen: string[] = []) => async (path: string, args: string[]) => {
    const key = args.join(" ");
    seen.push(`${path} :: ${key}`);
    return key in script ? script[key]! : null;
  };
  const base: Script = {
    "rev-parse --git-dir": ".git",
    "remote get-url origin": "git@github.com:o/r.git\n",
    "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main\n",
    "rev-parse --abbrev-ref HEAD": "feat/x\n",
    "rev-parse --abbrev-ref @{u}": "origin/feat/x\n",
    "rev-list --count HEAD..@{u}": "1\n",
    "rev-list --count HEAD --not --remotes": "2\n",
    "log -15 --format=%H%x1f%ct%x1f%an%x1f%s": "abcdef1234567\x1f1700000100\x1fAda\x1fFirst\n1111111222222\x1f1700000000\x1fBob\x1fSecond\n",
    "log -8 --format=%ct%x1f%h%x1f%s -- .claude/session-notes.md": "1700000050\x1fabc1234\x1fnotes\n",
    "status --porcelain=v1 -z --untracked-files=normal": " M a.ts\0?? gone.ts\0",
    "worktree list --porcelain": "worktree /h/demo\nHEAD a\nbranch refs/heads/feat/x\n\nworktree /h/demo/wt\nHEAD b\nbranch refs/heads/feat/w\n\nworktree /h/elsewhere\nHEAD c\nbranch refs/heads/feat/e\n",
    "rev-parse --verify -q refs/remotes/origin/main": "abc\n",
    "rev-list --count origin/main..feat/w": "3\n",
  };
  const prJson = JSON.stringify([
    { number: 4, title: "T", headRefName: "feat/x", url: "https://github.com/o/r/pull/4", isDraft: false, mergeStateStatus: "CLEAN", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], updatedAt: "2026-11-01T00:00:00Z" },
  ]);
  const mergedJson = JSON.stringify([{ headRefName: "feat/w" }]);
  const runsJson = JSON.stringify({ workflow_runs: [{ id: 9, workflow_id: 3, event: "push", name: "CI", head_branch: "main", status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/actions/runs/9", updated_at: "2026-11-01T00:00:00Z" }] });
  const ghOf = (calls: string[][] = []) => async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api") return runsJson;
    return args.includes("merged") ? mergedJson : prJson;
  };
  const notesText = "# T\n## State\nok\n## Exact next step\ndo it\n";
  const deps = (script: Script, extra: Record<string, unknown> = {}) => ({
    git: gitOf(script),
    gh: ghOf(),
    cache: createTtlCache(() => 0),
    home: HOME,
    readNotes: () => ({ text: notesText, mtime: 1700000200 }),
    mtimeOf: (p: string) => (p.endsWith("a.ts") ? 1700000300 : null),
    realUnderHome: (p: string) => (p.startsWith("/h/demo") ? p : null),
    sessions: [] as Array<{ pid: number; sessionId: string; cwd: string; name: string; status: string; updatedAt: number }>,
    ...extra,
  });
  const project = { name: "Demo", path: "/h/demo" };

  test("builds the card from git and gh", async () => {
    const d = deps(base, { sessions: [{ pid: 1, sessionId: "s", cwd: "/h/demo/wt/sub", name: "chat", status: "idle", updatedAt: 9 }, { pid: 2, sessionId: "t", cwd: "/h/other", name: "x", status: "idle", updatedAt: 9 }] });
    const p = await collectProject(project, d);
    expect(p.error).toBeNull();
    expect(p.path).toBe("~/demo");
    expect(p).toMatchObject({
      repo: "o/r", repoUrl: "https://github.com/o/r", default: "main", branch: "feat/x",
      upstream: "origin/feat/x", behind: 1, ahead: 2, hasRemote: true, newestCommit: 1700000100,
    });
    expect(p.commits![0]).toEqual({ sha: "abcdef1", t: 1700000100, author: "Ada", subject: "First", url: "https://github.com/o/r/commit/abcdef1234567" });
    expect(p.notesLog).toEqual([{ t: 1700000050, sha: "abc1234", subject: "notes" }]);
    expect(p.dirty).toEqual({ count: 2, oldest: 1700000300, files: ["a.ts", "gone.ts"] });
    expect(p.notes?.nextStep).toBe("do it");
    expect(p.prs).toEqual([{ number: 4, title: "T", branch: "feat/x", url: "https://github.com/o/r/pull/4", draft: false, mergeState: "CLEAN", checks: "success", updated: "2026-11-01T00:00:00Z" }]);
    expect(p.runs![0]).toMatchObject({ id: 9, wid: 3, dynamic: false, workflow: "CI", branch: "main", conclusion: "failure", t: Date.parse("2026-11-01T00:00:00Z") / 1000 });
    // The fake git answers every path alike, hence dirty 2. /h/elsewhere is outside the project's home subtree per realUnderHome: dropped; /h/demo/wt kept.
    expect(p.worktrees).toEqual([{ path: "/h/demo/wt", branch: "feat/w", ahead: 3, dirty: 2, prMerged: true }]);
    expect(p.sessions!.map((s) => s.sessionId)).toEqual(["s"]);
  });

  test("a failing git call degrades one field, not the card", async () => {
    const { "log -15 --format=%H%x1f%ct%x1f%an%x1f%s": _drop, ...rest } = base;
    const p = await collectProject(project, deps(rest));
    expect(p.error).toBeNull();
    expect(p.commits).toEqual([]);
    expect(p.newestCommit).toBeNull();
    expect(p.branch).toBe("feat/x");
  });

  test("not a git repository gives an error card", async () => {
    const p = await collectProject(project, deps({}));
    expect(p).toMatchObject({ name: "Demo", error: "not a git repository" });
  });

  test("no GitHub origin means no gh calls and null prs/runs", async () => {
    const calls: string[][] = [];
    const p = await collectProject(project, deps({ ...base, "remote get-url origin": "" }, { gh: ghOf(calls) }));
    expect(calls).toHaveLength(0);
    expect(p.prs).toBeNull();
    expect(p.runs).toBeNull();
    expect(p.repo).toBeNull();
  });

  test("gh calls use only the allowed shapes and are cached across collects", async () => {
    const calls: string[][] = [];
    const d = deps(base, { gh: ghOf(calls) });
    await collectProject(project, d);
    await collectProject(project, d);
    expect(calls.map((c) => c.slice(0, 2).join(" ")).sort()).toEqual(["api repos/o/r/actions/runs?per_page=30", "pr list", "pr list"]);
    expect(calls.find((c) => c[0] === "api")).toEqual(["api", "repos/o/r/actions/runs?per_page=30"]);
    expect(calls.filter((c) => c[0] === "pr").every((c) => c[2] === "--repo" && c[3] === "o/r")).toBe(true);
  });

  test("garbage from gh gives null, not a throw", async () => {
    const p = await collectProject(project, deps(base, { gh: async () => "not json" }));
    expect(p.prs).toBeNull();
    expect(p.runs).toBeNull();
  });

  test("a worktree path that fails the home check is never passed to git", async () => {
    const seen: string[] = [];
    await collectProject(project, { ...deps(base), git: gitOf(base, seen) });
    expect(seen.some((s) => s.startsWith("/h/elsewhere"))).toBe(false);
  });
});
