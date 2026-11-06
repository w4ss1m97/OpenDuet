import { describe, expect, test } from "bun:test";
import {
  buildHealth, claudeWords, codeStats, coverageFromReport, enforcedFloor, ghWhy, gitignoreGaps, parseChurn, parseCiRuns,
  parseCodeScanning, parseDependabot, parseLsFiles, parseNpmAudit, parseNpmOutdated, parseStaleBranches, parseWorktreeCount,
  flakyJobNames, pyRound,
} from "../src/openduet/cockpit/quality-parse";

const run = (o: Record<string, unknown>) => ({
  id: 1, workflow_id: 7, name: "CI", status: "completed", conclusion: "success", event: "push", head_branch: "main", head_sha: "abcdef1234567",
  html_url: "https://x/1", updated_at: "2026-10-02T10:10:00Z", run_started_at: "2026-10-02T10:00:00Z", run_attempt: 1, ...o,
});

describe("pyRound", () => {
  test("rounds half to even like Python", () => {
    expect([0.5, 1.5, 2.5, 3.5, 4.4].map((x) => pyRound(x))).toEqual([0, 2, 2, 4, 4]);
    expect(pyRound(0.125, 2)).toBe(0.12);
    expect(pyRound(33.34, 1)).toBe(33.3);
  });
});

describe("ci runs", () => {
  test("pass rate, average seconds, last and lastBase per workflow", () => {
    const d = { workflow_runs: [
      run({ id: 1, updated_at: "2026-10-02T10:10:00Z" }),
      run({ id: 2, conclusion: "failure", head_branch: "feat", head_sha: "b".repeat(40), updated_at: "2026-10-03T10:10:00Z", run_started_at: "2026-10-03T10:00:00Z" }),
      run({ id: 3, status: "in_progress", conclusion: null }),
    ] };
    const r = parseCiRuns(d, { base: "main", days: 30 });
    if (!r.available) throw new Error("unavailable");
    expect(r.runs).toBe(2);
    expect(r.passRate).toBe(50);
    expect(r.avgSeconds).toBe(600);
    expect(r.workflows[0]!.last!.conclusion).toBe("failure");
    expect(r.workflows[0]!.lastBase!.conclusion).toBe("success");
  });

  test("flaky: fail then success on the same sha; attempt 2 success without a failed run", () => {
    const d = { workflow_runs: [
      run({ id: 10, conclusion: "failure", updated_at: "2026-10-02T10:00:00Z" }),
      run({ id: 11, updated_at: "2026-10-02T11:00:00Z" }),
      run({ id: 20, workflow_id: 8, name: "Lint", head_sha: "c".repeat(40), run_attempt: 2 }),
      run({ id: 30, head_sha: "d".repeat(40) }),
    ] };
    const r = parseCiRuns(d, { base: "main", days: 30 });
    if (!r.available) throw new Error("unavailable");
    expect(r.flaky).toHaveLength(2);
    const a = r.flaky.find((f) => f.workflow === "CI")!;
    expect(a).toMatchObject({ id: 10, attempt1: false, sha: "abcdef1" });
    const b = r.flaky.find((f) => f.workflow === "Lint")!;
    expect(b).toMatchObject({ id: 20, attempt1: true });
  });

  test("dynamic runs ignored; bad shape unavailable", () => {
    const r = parseCiRuns({ workflow_runs: [run({ event: "dynamic" })] }, { base: "main", days: 30 });
    expect(r.available && r.runs).toBe(0);
    expect(parseCiRuns("nope", { base: "main", days: 30 })).toEqual({ available: false, why: "unreadable answer" });
  });

  test("failed job names, sorted, at most 4", () => {
    const jobs = ["e", "d", "c", "b", "a", "a"].map((name) => ({ name, conclusion: "failure" })).concat([{ name: "ok", conclusion: "success" }]);
    expect(flakyJobNames({ jobs })).toEqual(["a", "b", "c", "d"]);
    expect(flakyJobNames(null)).toEqual([]);
  });
});

describe("alerts and npm", () => {
  test("dependabot counts, top 6 by severity, summary cut to 100", () => {
    const alert = (severity: string, pkg: string) => ({ security_advisory: { severity, summary: "s".repeat(150) }, dependency: { package: { name: pkg } }, html_url: `u/${pkg}` });
    const r = parseDependabot([alert("low", "a"), alert("critical", "b"), alert("high", "c")]);
    expect(r).toMatchObject({ available: true, total: 3, bySeverity: { low: 1, critical: 1, high: 1 } });
    if (!r.available) throw new Error();
    expect(r.top.map((t) => t.package)).toEqual(["b", "c", "a"]);
    expect(r.top[0]!.summary).toHaveLength(100);
    expect(parseDependabot({})).toEqual({ available: false, why: "unreadable answer" });
  });

  test("code scanning severities", () => {
    expect(parseCodeScanning([{ rule: { security_severity_level: "high" } }, { rule: { severity: "warning" } }, {}])).toEqual({
      available: true, total: 3, bySeverity: { high: 1, warning: 1, low: 1 },
    });
  });

  test("npm audit counts; no result is an error", () => {
    expect(parseNpmAudit('{"metadata":{"vulnerabilities":{"high":2,"low":1,"info":5}}}')).toEqual({ critical: 0, high: 2, moderate: 0, low: 1 });
    expect(parseNpmAudit("garbage")).toEqual({ error: "npm audit gave no result (offline?)" });
    expect(parseNpmAudit(null)).toEqual({ error: "npm audit gave no result (offline?)" });
    expect(parseNpmAudit('{"error":{"code":"ENOTFOUND"}}')).toEqual({ error: "npm audit gave no result (offline?)" });
  });

  test("npm outdated majors", () => {
    const raw = JSON.stringify({ a: { current: "1.2.0", latest: "2.0.0" }, b: { current: "1.0.0", latest: "1.5.0" }, c: { latest: "3.0.0" } });
    expect(parseNpmOutdated(raw)).toEqual({ total: 3, major: 1, majorNames: ["a"] });
    expect(parseNpmOutdated("")).toEqual({ total: 0, major: 0, majorNames: [] });
    expect(parseNpmOutdated("<oops")).toEqual({ error: "npm outdated gave no result" });
  });

  test("gh why", () => {
    expect(ghWhy(403)).toBe("not available on this plan");
    expect(ghWhy(404)).toBe("not set up");
    expect(ghWhy(500)).toBe("gh error 500");
    expect(ghWhy(null)).toBe("gh error");
  });
});

describe("coverage", () => {
  test("enforced floor from workflows or pyproject", () => {
    expect(enforcedFloor(["run: pytest --cov-fail-under=85"], "")).toBe(85);
    expect(enforcedFloor(["run: pytest --cov-fail-under 70"], "")).toBe(70);
    expect(enforcedFloor([], "[tool.coverage.report]\nfail_under = 60")).toBe(60);
    expect(enforcedFloor(["nothing"], "")).toBeNull();
  });
  test("measured from a report", () => {
    expect(coverageFromReport("json", '{"total":{"lines":{"pct":81.5}}}')).toBe(81.5);
    expect(coverageFromReport("xml", '<coverage line-rate="0.8766" x="1">')).toBe(87.7);
    expect(coverageFromReport("json", "{}")).toBeNull();
    expect(coverageFromReport("xml", "<x/>")).toBeNull();
  });
});

describe("git output", () => {
  test("ls-files, churn, stale branches, worktrees", () => {
    expect(parseLsFiles("a\0b/c\0\0")).toEqual(["a", "b/c"]);
    const churn = parseChurn("src/a.ts\nsrc/a.ts\nREADME.md\nnode_modules/x.js\ndist/y.js\nsrc/b.py\n");
    expect(churn).toEqual({ "src/a.ts": 2, "src/b.py": 1 });
    const now = 100 * 86400;
    const out = `main\t${now}\nold\t${now - 40 * 86400}\ncur\t${now - 50 * 86400}\nmid\t${now - 31 * 86400}\n`;
    expect(parseStaleBranches(out, "main", "cur", now, 30)).toEqual([{ branch: "old", days: 40 }, { branch: "mid", days: 31 }]);
    expect(parseWorktreeCount("worktree /a\nHEAD x\n\nworktree /b\nHEAD y\n")).toBe(1);
    expect(parseWorktreeCount("")).toBe(0);
  });
});

describe("health and gitignore", () => {
  test("code stats skip non-code, vendor and minified files", () => {
    expect(codeStats("README.md", "x")).toBeNull();
    expect(codeStats("node_modules/a.js", "x")).toBeNull();
    expect(codeStats("a.min.js", "x")).toBeNull();
    expect(codeStats("a.d.ts", "x")).toBeNull();
    expect(codeStats("src/a.ts", "a\nb // TODO x\nFIXME\n")).toEqual({ rel: "src/a.ts", lang: "TypeScript", lines: 4, test: false, todo: { TODO: 1, FIXME: 1 } });
    expect(codeStats("tests/a.test.ts", "x")!.test).toBe(true);
    expect(codeStats("test_a.py", "x")!.test).toBe(true);
  });

  test("buildHealth", () => {
    const stats = [
      codeStats("src/a.ts", "x\n".repeat(899))!, // 900 lines
      codeStats("src/b.ts", "y\n".repeat(99))!, // 100 lines
      codeStats("tests/a.test.ts", "z\n".repeat(49))!, // 50 lines
    ];
    const h = buildHealth(stats, { "src/a.ts": 7, "gone.ts": 9 }, 800);
    expect(h).toMatchObject({ totalLoc: 1050, srcLoc: 1000, testLoc: 50, testRatio: 0.05, hasTests: true, loc: { TypeScript: 1050 } });
    expect(h.largest[0]).toEqual({ file: "src/a.ts", lines: 900, flag: true });
    expect(h.churn[0]).toEqual({ file: "gone.ts", changes: 9, lines: null });
    expect(buildHealth([], {}, 800)).toMatchObject({ totalLoc: 0, testRatio: null, hasTests: false });
  });

  test("gitignore gaps", () => {
    const gaps = gitignoreGaps([".env", ".env.example", "keys/id_rsa", "a.pem", "ok.txt"], "node_modules\n");
    expect(gaps.map((g) => g.file)).toEqual([".env", "keys/id_rsa", "a.pem", ".gitignore"]);
    expect(gitignoreGaps([], "  /.env\n")).toEqual([]);
    expect(gitignoreGaps([], ".env*\n")).toEqual([]);
  });

  test("CLAUDE.md words", () => {
    expect(claudeWords("a b\nc  d")).toBe(4);
  });
});
