/*
 * The quality score, grade, suggestions and high findings: an exact port of Cockpit's quality.py
 * (weights 30/20/25/15/10, renormalised over the categories that apply; long-function checks were cut).
 */
import { createHash } from "node:crypto";
import { type QualityConfig, type QualityResult, type QualitySections, type Suggestion, pyRound } from "./quality-parse";

export const WEIGHTS: Record<string, number> = { tests: 30, deps: 20, security: 25, health: 15, hygiene: 10 };
const FAILED = ["failure", "timed_out", "startup_failure"];
const SEV = ["critical", "high", "moderate", "low"] as const;
const PTS: Record<string, number> = { critical: 40, high: 25, medium: 8, moderate: 8, low: 2 };

export const grade = (score: number): string => (score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F");

/** The id of a suggestion across projects: sha256(project + id), first 16 hex characters. */
export const suggestionKey = (project: string, id: string): string => createHash("sha256").update(project + id).digest("hex").slice(0, 16);

const auditOf = (deps: QualitySections["deps"]) => {
  const a = deps.npm?.audit;
  return a && !("error" in a) ? a : null;
};
const outdatedMajors = (deps: QualitySections["deps"]) => {
  const o = deps.npm?.outdated;
  return o && !("error" in o) ? o : null;
};
const depBySeverity = (deps: QualitySections["deps"]) => {
  const d = deps.dependabot;
  return d && d.available ? d.bySeverity : {};
};

export function score(res: QualitySections, cfg: Pick<QualityConfig, "bigFileLines">): Pick<QualityResult, "score" | "grade" | "categories" | "why"> {
  const cats: Record<string, number | null> = {};
  const why: Record<string, string[]> = { tests: [], deps: [], security: [], health: [], hygiene: [] };
  const hit = (cat: string, pts: number, text: string) => {
    cats[cat] = (cats[cat] ?? 100) - pts;
    why[cat]!.push(`−${pyRound(pts)}: ${text}`);
  };
  const { ci, deps, security: sec, health: h, hygiene: hy } = res;

  // tests and CI
  cats.tests = ci.available || h.hasTests ? 100 : null;
  if (ci.available) {
    for (const w of ci.workflows) {
      if (FAILED.includes((w.lastBase ?? w.last)?.conclusion ?? "")) hit("tests", 30, `last run of «${w.name}» failed`);
    }
    if (ci.passRate !== null && ci.passRate < 90) hit("tests", Math.min(25, (90 - ci.passRate) * 0.8), `pass rate ${ci.passRate}% over ${ci.days} days`);
    if (ci.flaky.length > 0) hit("tests", Math.min(15, 5 * ci.flaky.length), `${ci.flaky.length} flaky run(s)`);
  } else if (!hy.ci) {
    hit("tests", 40, "no CI configured");
  }
  if (!h.hasTests && h.srcLoc) hit("tests", 25, "no test files found");
  const cov = ci.available ? ci.coverage : null;
  if (cov && cov.measured !== null && cov.enforced && cov.measured < cov.enforced) {
    hit("tests", 10, `coverage ${cov.measured}% under the enforced ${cov.enforced}%`);
  }

  // dependencies
  cats.deps = (deps.dependabot?.available ?? false) || deps.npm ? 100 : null;
  for (const [sev, n] of Object.entries(depBySeverity(deps))) hit("deps", Math.min(60, (PTS[sev] ?? 2) * n), `${n} ${sev} Dependabot alert(s)`);
  const audit = auditOf(deps);
  if (audit) for (const sev of SEV) if (audit[sev]) hit("deps", Math.min(60, PTS[sev]! * audit[sev]), `npm audit: ${audit[sev]} ${sev}`);
  const majors = outdatedMajors(deps)?.major ?? 0;
  if (majors) hit("deps", Math.min(15, 3 * majors), `${majors} major upgrade(s) pending`);

  // security
  cats.security = 100;
  const localHigh = sec.local.filter((x) => x.severity === "high");
  if (localHigh.length > 0) hit("security", Math.min(80, 40 * localHigh.length), `${localHigh.length} secret-pattern hit(s) in tracked files`);
  if (sec.local.some((x) => x.severity === "medium")) hit("security", 10, "medium secret-pattern hit(s) (API keys that may be public client keys)");
  for (const [s, label] of [[sec.codeScanning, "code-scanning"], [sec.secretScanning, "secret-scanning"]] as const) {
    if (s && s.available && s.total) hit("security", Math.min(60, 15 * s.total), `${s.total} open ${label} alert(s)`);
  }
  if (sec.gitignore.length > 0) hit("security", Math.min(15, 5 * sec.gitignore.length), `${sec.gitignore.length} .gitignore gap(s)`);

  // code health
  cats.health = h.totalLoc ? 100 : null;
  const big = h.largest.filter((f) => f.flag);
  if (big.length > 0) hit("health", Math.min(24, 6 * big.length), `${big.length} file(s) over ${cfg.bigFileLines} lines`);
  if (h.testRatio !== null && h.testRatio < 0.1 && h.srcLoc > 500) hit("health", 10, `tests are ${pyRound(h.testRatio * 100)}% of the source size`);
  const todos = Object.values(h.todo).reduce((a, b) => a + b, 0);
  if (todos > 30) hit("health", 5, `${todos} TODO/FIXME/HACK markers`);

  // hygiene
  cats.hygiene = 100;
  if (!hy.readme) hit("hygiene", 20, "no README");
  if (!hy.claudeMd) hit("hygiene", 10, "no CLAUDE.md");
  else if (hy.claudeWords > 1500) hit("hygiene", 10, `CLAUDE.md is ${hy.claudeWords} words (limit 1,500)`);
  if (!hy.notes) hit("hygiene", 15, "no session notes");
  else if (hy.notesLagDays !== null && hy.notesLagDays > 2) hit("hygiene", 10, `session notes ${hy.notesLagDays} days behind the newest commit`);
  if (!hy.ci) hit("hygiene", 20, "no CI");
  if (hy.staleBranches.length > 5) hit("hygiene", 10, `${hy.staleBranches.length} stale branches`);

  const categories: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(cats)) categories[k] = v === null ? null : Math.max(0, pyRound(v));
  const live = Object.entries(categories).filter((e): e is [string, number] => e[1] !== null);
  const weight = live.reduce((n, [k]) => n + WEIGHTS[k]!, 0);
  const total = live.length > 0 ? live.reduce((n, [k, v]) => n + v * WEIGHTS[k]!, 0) / weight : 0;
  return { score: pyRound(total), grade: grade(total), categories, why };
}

export function suggestions(project: string, res: QualitySections, base: string, cfg: Pick<QualityConfig, "bigFileLines" | "staleBranchDays">): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (id: string, priority: Suggestion["priority"], title: string, evidence: string, category: string) =>
    out.push({ id, key: suggestionKey(project, id), priority, title, evidence, category });
  const { ci, deps, security: sec, health: h, hygiene: hy } = res;

  if (!hy.ci) add("no-ci", "high", "Add a CI workflow", "No .github/workflows folder.", "tests");
  if (ci.available) {
    for (const w of ci.workflows) {
      if (w.lastBase && FAILED.includes(w.lastBase.conclusion ?? "")) add(`ci-red:${w.name}`, "high", `Fix the red «${w.name}» on ${base}`, `Last run failed: ${w.lastBase.url}`, "tests");
    }
    if (ci.flaky.length > 0) {
      const jobs = [...new Set(ci.flaky.flatMap((f) => f.jobs))].sort().slice(0, 4);
      add("flaky", "medium", "Stabilise flaky runs", `${ci.flaky.length} run(s) failed then passed; jobs: ${(jobs.length > 0 ? jobs : ["unknown"]).join(", ")}`, "tests");
    }
    const cov = ci.coverage;
    if (cov.measured !== null && cov.enforced && cov.measured - cov.enforced < 2) {
      add("coverage-edge", "low", "Coverage is close to the enforced floor", `${cov.measured}% against ${cov.enforced}% enforced.`, "tests");
    }
  }
  if (!h.hasTests && h.srcLoc > 200) add("no-tests", "high", "Add tests", `No test files among ${h.srcLoc} source lines.`, "tests");
  else if (h.testRatio !== null && h.testRatio < 0.1 && h.srcLoc > 500) {
    add("few-tests", "medium", "Raise test coverage of the source", `Test code is ${pyRound(h.testRatio * 100)}% of source code (${h.testLoc} vs ${h.srcLoc} lines).`, "tests");
  }
  const db = depBySeverity(deps);
  for (const sev of ["critical", "high"] as const) {
    const n = db[sev];
    if (n) {
      const top = deps.dependabot && deps.dependabot.available ? deps.dependabot.top : [];
      add(`dependabot-${sev}`, "high", `Fix ${n} ${sev} Dependabot alert(s)`, top.filter((t) => t.severity === sev).map((t) => String(t.package)).join(", ").slice(0, 120), "deps");
    }
  }
  const audit = auditOf(deps);
  for (const sev of ["critical", "high"] as const) {
    const n = audit?.[sev];
    if (n) add(`npm-${sev}`, "high", `npm audit: ${n} ${sev} vulnerabilit${n === 1 ? "y" : "ies"}`, "Run npm audit to see the packages.", "deps");
  }
  const outdated = outdatedMajors(deps);
  const majors = outdated?.major ?? 0;
  if (majors >= 3) add("majors", "medium", `${majors} major dependency upgrades pending`, (outdated?.majorNames ?? []).slice(0, 5).join(", "), "deps");
  for (const x of sec.local) {
    if (x.severity === "high") {
      add(`secret:${x.file}:${x.line}`, "high", `Possible secret in a tracked file: ${x.type}`, `${x.file}:${x.line}. Rotate it if real, then remove it from history.`, "security");
    }
  }
  for (const g of sec.gitignore) add(`ignore:${g.file}`, "medium", "Fix .gitignore", `${g.file}: ${g.why}`, "security");
  for (const [s, label] of [[sec.codeScanning, "code-scanning"], [sec.secretScanning, "secret-scanning"]] as const) {
    if (s && s.available && s.total) add(label, "high", `Open ${label} alerts`, `${s.total} open.`, "security");
  }
  for (const f of h.largest) {
    const changes = h.churn.find((c) => c.file === f.file)?.changes ?? 0;
    if (f.flag && changes >= 6) add(`split:${f.file}`, "medium", `Split ${f.file}`, `${f.lines} lines and changed ${changes} times in 30 days.`, "health");
    else if (f.flag) add(`big:${f.file}`, "low", `${f.file} is ${f.lines} lines`, `Over the ${cfg.bigFileLines}-line flag.`, "health");
  }
  if (hy.claudeWords > 1500) add("claude-long", "low", "Shorten CLAUDE.md", `${hy.claudeWords} words; the limit is 1,500 (it is read at every session start).`, "hygiene");
  if (hy.notesLagDays !== null && hy.notesLagDays > 2) add("notes-stale", "low", "Update the session notes", `${hy.notesLagDays} days behind the newest commit.`, "hygiene");
  if (hy.staleBranches.length > 5) add("stale-branches", "low", "Delete stale branches", `${hy.staleBranches.length} branches untouched for over ${cfg.staleBranchDays} days.`, "hygiene");
  const bp = hy.branchProtection;
  if (bp && "protected" in bp && bp.protected === false && ci.available) add("no-protection", "low", `Protect ${base}`, "No branch protection; PRs can be bypassed.", "hygiene");
  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

export function highFindings(res: QualitySections): QualityResult["highFindings"] {
  const found: QualityResult["highFindings"] = [];
  const { deps, security: sec } = res;
  const audit = auditOf(deps);
  for (const sev of ["critical", "high"] as const) {
    const n = (depBySeverity(deps)[sev] ?? 0) + (audit?.[sev] ?? 0);
    if (n) found.push({ key: `dep-${sev}`, text: `${n} ${sev} dependency vulnerabilit${n === 1 ? "y" : "ies"}`, severity: "high" });
  }
  const secrets = sec.local.filter((x) => x.severity === "high").length;
  if (secrets > 0) found.push({ key: "secrets", text: `${secrets} possible secret(s) in tracked files`, severity: "high" });
  const cs = sec.codeScanning;
  if (cs && cs.available && cs.total && Object.keys(cs.bySeverity).some((v) => v === "critical" || v === "high")) {
    found.push({ key: "codeScanning", text: "open code-scanning alert(s)", severity: "high" });
  }
  const ss = sec.secretScanning;
  if (ss && ss.available && ss.total) found.push({ key: "secretScanning", text: "open secret-scanning alert(s)", severity: "high" });
  return found;
}
