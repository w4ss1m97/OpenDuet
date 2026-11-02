import { describe, expect, test } from "bun:test";
import { buildHealth, codeStats } from "../src/openduet/cockpit/quality-parse";
import type { QualitySections } from "../src/openduet/cockpit/quality-parse";
import { grade, highFindings, score, suggestionKey, suggestions } from "../src/openduet/cockpit/quality-score";
import { CFG, healthy } from "./quality-fixtures.helper";

const cat = (s: QualitySections, name: string) => score(s, CFG).categories[name];
const red = { conclusion: "failure", url: "https://x/red", at: "2026-10-01T00:00:00Z", branch: "main" };
const bigHealth = (n: number) =>
  buildHealth([codeStats("tests/a.test.ts", "t\n".repeat(299))!, ...Array.from({ length: n }, (_, i) => codeStats(`src/f${i}.ts`, "x\n".repeat(899))!)], {}, 800);

describe("grade and score", () => {
  test("grade bounds", () => {
    expect([100, 90, 89.9, 80, 79.9, 70, 69.9, 60, 59.9, 0].map(grade)).toEqual(["A", "A", "B", "B", "C", "C", "D", "D", "F", "F"]);
  });

  test("a clean project is 100 / A", () => {
    expect(score(healthy(), CFG)).toMatchObject({ score: 100, grade: "A", categories: { tests: 100, deps: 100, security: 100, health: 100, hygiene: 100 } });
  });

  test("renormalised over live categories", () => {
    const s = healthy();
    s.ci = { available: false, why: "no GitHub remote" };
    s.health = buildHealth([], {}, 800);
    s.deps = { dependabot: { available: false, why: "x" }, npm: null, python: null, gradle: false };
    s.hygiene.readme = false; // hygiene 80
    s.security.gitignore = [{ file: ".gitignore", why: "w" }]; // security 95
    const r = score(s, CFG);
    expect(r.categories).toMatchObject({ tests: null, deps: null, health: null, security: 95, hygiene: 80 });
    expect(r.score).toBe(Math.round((95 * 25 + 80 * 10) / 35)); // 90
    expect(r.grade).toBe("A");
  });

  test("tests deductions", () => {
    let s = healthy();
    s.ci.available && (s.ci.workflows[0]!.lastBase = red);
    expect(cat(s, "tests")).toBe(70);
    s = healthy();
    if (s.ci.available) { s.ci.passRate = 50; s.ci.days = 30; }
    expect(cat(s, "tests")).toBe(75); // min(25, 32)
    s = healthy();
    if (s.ci.available) s.ci.passRate = 80;
    expect(cat(s, "tests")).toBe(92); // 8 -> 100-8
    s = healthy();
    if (s.ci.available) s.ci.flaky = [1, 2].map((id) => ({ workflow: "CI", sha: "a", url: "u", id, attempt1: false, jobs: [] }));
    expect(cat(s, "tests")).toBe(90);
    if (s.ci.available) s.ci.flaky = [1, 2, 3, 4].map((id) => ({ workflow: "CI", sha: "a", url: "u", id, attempt1: false, jobs: [] }));
    expect(cat(s, "tests")).toBe(85);
    s = healthy();
    if (s.ci.available) s.ci.coverage = { enforced: 80, measured: 70, source: "x" };
    expect(cat(s, "tests")).toBe(90);
    s = healthy();
    s.ci = { available: false, why: "x" };
    s.hygiene.ci = false;
    expect(cat(s, "tests")).toBe(60); // tests exist locally (live at 100), then no CI configured: -40
  });

  test("no CI and no tests", () => {
    const s = healthy();
    s.ci = { available: false, why: "x" };
    s.hygiene.ci = false;
    s.health = buildHealth([codeStats("src/a.ts", "x\n".repeat(99))!], {}, 800);
    // tests null -> 40 off 100 -> 60, then no tests with source lines: -25 -> 35
    expect(cat(s, "tests")).toBe(35);
  });

  test("deps deductions", () => {
    let s = healthy();
    s.deps.dependabot = { available: true, total: 3, bySeverity: { critical: 2, low: 1 }, top: [] };
    expect(cat(s, "deps")).toBe(38); // 60 + 2
    s = healthy();
    s.deps.npm = { audit: { critical: 0, high: 1, moderate: 2, low: 0 }, outdated: { total: 9, major: 3, majorNames: [] } };
    expect(cat(s, "deps")).toBe(100 - 25 - 16 - 9);
    s = healthy();
    s.deps.dependabot = null;
    s.deps.npm = { audit: { error: "x" }, outdated: { error: "y" } };
    expect(cat(s, "deps")).toBe(100);
    s.deps.npm = { audit: null, outdated: { total: 9, major: 9, majorNames: [] } };
    expect(cat(s, "deps")).toBe(85);
  });

  test("security deductions", () => {
    const hit = (severity: string) => ({ file: "a", line: 1, type: "t", severity });
    let s = healthy();
    s.security.local = [hit("high")];
    expect(cat(s, "security")).toBe(60);
    s.security.local = [hit("high"), hit("high"), hit("high")];
    expect(cat(s, "security")).toBe(20);
    s.security.local = [hit("medium")];
    expect(cat(s, "security")).toBe(90);
    s = healthy();
    s.security.codeScanning = { available: true, total: 2, bySeverity: {} };
    s.security.secretScanning = { available: true, total: 9 };
    expect(cat(s, "security")).toBe(100 - 30 - 60);
    s = healthy();
    s.security.gitignore = [1, 2, 3, 4].map((i) => ({ file: `f${i}`, why: "w" }));
    expect(cat(s, "security")).toBe(85);
  });

  test("health deductions", () => {
    let s = healthy();
    s.health = bigHealth(2);
    expect(cat(s, "health")).toBe(88);
    s.health = bigHealth(5);
    expect(cat(s, "health")).toBe(66); // 24 cap + 10 for tests at 6% of source
    s = healthy();
    s.health = buildHealth([codeStats("src/a.ts", "x\n".repeat(599))!, codeStats("tests/a.test.ts", "y\n".repeat(9))!], {}, 800);
    expect(cat(s, "health")).toBe(90); // 10 / 600 under 10%
    s = healthy();
    s.health.todo = { TODO: 31 };
    expect(cat(s, "health")).toBe(95);
  });

  test("hygiene deductions", () => {
    const h = (f: (s: QualitySections) => void) => { const s = healthy(); f(s); return cat(s, "hygiene"); };
    expect(h((s) => { s.hygiene.readme = false; })).toBe(80);
    expect(h((s) => { s.hygiene.claudeMd = false; })).toBe(90);
    expect(h((s) => { s.hygiene.claudeWords = 1600; })).toBe(90);
    expect(h((s) => { s.hygiene.notes = false; s.hygiene.notesLagDays = null; })).toBe(85);
    expect(h((s) => { s.hygiene.notesLagDays = 3; })).toBe(90);
    expect(h((s) => { s.hygiene.ci = false; })).toBe(80);
    expect(h((s) => { s.hygiene.staleBranches = Array.from({ length: 6 }, (_, i) => ({ branch: `b${i}`, days: 40 })); })).toBe(90);
  });

  test("reasons are listed per category", () => {
    const s = healthy();
    s.hygiene.readme = false;
    expect(score(s, CFG).why.hygiene).toEqual(["−20: no README"]);
  });
});

describe("suggestions", () => {
  test("keys are stable sha256(project+id)[0:16] and differ per project", () => {
    expect(suggestionKey("p", "no-ci")).toMatch(/^[0-9a-f]{16}$/);
    expect(suggestionKey("p", "no-ci")).toBe(suggestionKey("p", "no-ci"));
    expect(suggestionKey("p", "no-ci")).not.toBe(suggestionKey("q", "no-ci"));
    expect(suggestionKey("p", "no-ci")).toBe(new Bun.CryptoHasher("sha256").update("pno-ci").digest("hex").slice(0, 16));
  });

  test("a clean project has none", () => {
    expect(suggestions("p", healthy(), "main", CFG)).toEqual([]);
  });

  test("each rule, ordered high then medium then low (stable)", () => {
    const s = healthy();
    s.hygiene.ci = false;
    s.hygiene.claudeWords = 1600;
    s.hygiene.notesLagDays = 5;
    s.hygiene.staleBranches = Array.from({ length: 6 }, (_, i) => ({ branch: `b${i}`, days: 40 }));
    s.hygiene.branchProtection = { protected: false };
    if (s.ci.available) {
      s.ci.workflows[0]!.lastBase = red;
      s.ci.flaky = [{ workflow: "CI", sha: "a", url: "u", id: 1, attempt1: false, jobs: ["build", "lint"] }];
      s.ci.coverage = { enforced: 80, measured: 81, source: "x" };
    }
    s.deps.dependabot = { available: true, total: 1, bySeverity: { high: 1 }, top: [{ package: "left-pad", severity: "high", summary: "s", url: "u" }] };
    s.deps.npm = { audit: { critical: 1, high: 0, moderate: 0, low: 0 }, outdated: { total: 3, major: 3, majorNames: ["a", "b", "c"] } };
    s.security.local = [{ file: "src/k.ts", line: 3, type: "AWS access key id", severity: "high" }];
    s.security.gitignore = [{ file: ".gitignore", why: "no rule for .env files" }];
    s.security.secretScanning = { available: true, total: 2 };
    s.health = buildHealth([codeStats("src/big.ts", "x\n".repeat(899))!, codeStats("src/big2.ts", "x\n".repeat(899))!, codeStats("tests/t.test.ts", "y\n".repeat(599))!], { "src/big.ts": 6 }, 800);
    const out = suggestions("p", s, "main", CFG);
    const ids = out.map((x) => x.id);
    expect(ids).toEqual([
      "no-ci", "ci-red:CI", "dependabot-high", "npm-critical", "secret:src/k.ts:3", "secret-scanning",
      "flaky", "majors", "ignore:.gitignore", "split:src/big.ts",
      "coverage-edge", "big:src/big2.ts", "claude-long", "notes-stale", "stale-branches", "no-protection",
    ].map((x) => x));
    const prios = out.map((x) => x.priority);
    expect(prios).toEqual([...prios].sort((a, b) => ["high", "medium", "low"].indexOf(a) - ["high", "medium", "low"].indexOf(b)));
    const flaky = out.find((x) => x.id === "flaky")!;
    expect(flaky.evidence).toBe("1 run(s) failed then passed; jobs: build, lint");
    expect(out[0]!.key).toBe(suggestionKey("p", "no-ci"));
    expect(out.find((x) => x.id === "npm-critical")!.title).toBe("npm audit: 1 critical vulnerability");
  });

  test("no tests / few tests", () => {
    const s = healthy();
    s.health = buildHealth([codeStats("src/a.ts", "x\n".repeat(299))!], {}, 800);
    expect(suggestions("p", s, "main", CFG).map((x) => x.id)).toContain("no-tests");
    s.health = buildHealth([codeStats("src/a.ts", "x\n".repeat(599))!, codeStats("tests/a.test.ts", "y\n".repeat(9))!], {}, 800);
    expect(suggestions("p", s, "main", CFG).map((x) => x.id)).toContain("few-tests");
  });
});

describe("high findings", () => {
  test("rules", () => {
    expect(highFindings(healthy())).toEqual([]);
    const s = healthy();
    s.deps.dependabot = { available: true, total: 2, bySeverity: { critical: 1, high: 1 }, top: [] };
    s.deps.npm = { audit: { critical: 1, high: 0, moderate: 0, low: 0 }, outdated: null };
    s.security.local = [{ file: "a", line: 1, type: "t", severity: "high" }, { file: "b", line: 1, type: "t", severity: "medium" }];
    s.security.codeScanning = { available: true, total: 1, bySeverity: { warning: 1 } };
    s.security.secretScanning = { available: true, total: 1 };
    expect(highFindings(s)).toEqual([
      { key: "dep-critical", text: "2 critical dependency vulnerabilities", severity: "high" },
      { key: "dep-high", text: "1 high dependency vulnerability", severity: "high" },
      { key: "secrets", text: "1 possible secret(s) in tracked files", severity: "high" },
      { key: "secretScanning", text: "open secret-scanning alert(s)", severity: "high" },
    ]);
    s.security.codeScanning = { available: true, total: 1, bySeverity: { high: 1 } };
    expect(highFindings(s).map((f) => f.key)).toContain("codeScanning");
  });
});
