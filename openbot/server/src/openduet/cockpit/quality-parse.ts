/*
 * Quality scan, the pure part: what a `gh api` answer, an npm report, git output or a file's text becomes.
 * No I/O here. The shapes are zod schemas so the saved scans are checked the same way on load.
 */
import { z } from "zod";

/** Python's round(): halves go to the even neighbour (the score port must match quality.py exactly). */
export function pyRound(x: number, digits = 0): number {
  const m = 10 ** digits;
  const v = x * m;
  const floor = Math.floor(v);
  const r = v - floor === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(v);
  return (r === 0 ? 0 : r) / m;
}

export type QualityConfig = {
  enabled: boolean;
  scanHours: number;
  lookbackDays: number;
  bigFileLines: number;
  staleBranchDays: number;
  npm: boolean;
};

// ---------- shapes ----------
const num = z.number();
const unavailable = z.object({ available: z.literal(false), why: z.string() });
const runRef = z.object({ conclusion: z.string().nullable(), url: z.string(), at: z.string(), branch: z.string() }).nullable();
const ciSchema = z.union([
  unavailable,
  z.object({
    available: z.literal(true),
    days: num,
    runs: num,
    passRate: num.nullable(),
    avgSeconds: num,
    flaky: z.array(z.object({ workflow: z.string(), sha: z.string(), url: z.string(), id: num, attempt1: z.boolean(), jobs: z.array(z.string()) })),
    workflows: z.array(z.object({ name: z.string(), runs: num, passRate: num.nullable(), avgSeconds: num.nullable(), last: runRef, lastBase: runRef })),
    coverage: z.object({ enforced: num.nullable(), measured: num.nullable(), source: z.string().nullable() }),
  }),
]);
const npmAuditSchema = z.union([z.object({ critical: num, high: num, moderate: num, low: num }), z.object({ error: z.string() })]);
const npmOutdatedSchema = z.union([z.object({ total: num, major: num, majorNames: z.array(z.string()) }), z.object({ error: z.string() })]);
const depsSchema = z.object({
  dependabot: z.union([
    unavailable,
    z.object({
      available: z.literal(true),
      total: num,
      bySeverity: z.record(z.string(), num),
      top: z.array(z.object({ package: z.string().nullable(), severity: z.string().nullable(), summary: z.string(), url: z.string().nullable() })),
    }),
  ]).nullable(),
  npm: z.object({ audit: npmAuditSchema.nullable(), outdated: npmOutdatedSchema.nullable() }).nullable(),
  python: z.object({ skipped: z.string() }).nullable(),
  gradle: z.boolean(),
});
const secretHit = z.object({ file: z.string(), line: num, type: z.string(), severity: z.string() });
const securitySchema = z.object({
  codeScanning: z.union([unavailable, z.object({ available: z.literal(true), total: num, bySeverity: z.record(z.string(), num) })]).nullable(),
  secretScanning: z.union([unavailable, z.object({ available: z.literal(true), total: num })]).nullable(),
  local: z.array(secretHit),
  gitignore: z.array(z.object({ file: z.string(), why: z.string() })),
});
const healthSchema = z.object({
  loc: z.record(z.string(), num),
  totalLoc: num,
  srcLoc: num,
  testLoc: num,
  testRatio: num.nullable(),
  hasTests: z.boolean(),
  largest: z.array(z.object({ file: z.string(), lines: num, flag: z.boolean() })),
  todo: z.record(z.string(), num),
  churn: z.array(z.object({ file: z.string(), changes: num, lines: num.nullable() })),
});
const hygieneSchema = z.object({
  readme: z.boolean(),
  claudeMd: z.boolean(),
  claudeWords: num,
  notes: z.boolean(),
  notesAgeDays: num.nullable(),
  notesLagDays: num.nullable(),
  ci: z.boolean(),
  branchProtection: z.union([z.object({ protected: z.boolean() }), unavailable]).nullable(),
  autoMerge: z.boolean().nullable(),
  staleBranches: z.array(z.object({ branch: z.string(), days: num })),
  worktrees: num,
});
const suggestionSchema = z.object({
  id: z.string(), key: z.string(), priority: z.enum(["high", "medium", "low"]), title: z.string(), evidence: z.string(), category: z.string(),
});

export const qualityResultSchema = z.object({
  project: z.string(),
  path: z.string(),
  repo: z.string().nullable(),
  default: z.string(),
  scannedAt: num,
  files: num,
  ci: ciSchema,
  deps: depsSchema,
  security: securitySchema,
  health: healthSchema,
  hygiene: hygieneSchema,
  score: num,
  grade: z.string(),
  categories: z.record(z.string(), num.nullable()),
  why: z.record(z.string(), z.array(z.string())),
  suggestions: z.array(suggestionSchema),
  highFindings: z.array(z.object({ key: z.string(), text: z.string(), severity: z.literal("high") })),
});

export type QualityResult = z.infer<typeof qualityResultSchema>;
export type QualitySections = Omit<QualityResult, "score" | "grade" | "categories" | "why" | "suggestions" | "highFindings">;
export type Suggestion = z.infer<typeof suggestionSchema>;
export type CiSection = QualityResult["ci"];
export type DepsSection = QualityResult["deps"];
export type SecretHit = z.infer<typeof secretHit>;
export type HealthSection = QualityResult["health"];

const UNREADABLE = { available: false, why: "unreadable answer" } as const;
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Why a `gh api` call gave nothing, from its HTTP status. */
export function ghWhy(status: number | null): string {
  if (status === 403) return "not available on this plan";
  if (status === 404) return "not set up";
  return status === null ? "gh error" : `gh error ${status}`;
}

// ---------- CI ----------
const FAILED = ["failure", "timed_out", "startup_failure"];

function runSeconds(r: Record<string, unknown>): number {
  const end = Date.parse(str(r.updated_at) ?? "");
  const start = Date.parse(str(r.run_started_at) ?? "");
  return Number.isNaN(end) || Number.isNaN(start) ? 0 : Math.round((end - start) / 1000);
}

/** Workflow pass rates, durations, last runs and flaky runs from `actions/runs`. Coverage is filled in by the caller. */
export function parseCiRuns(json: unknown, opts: { base: string; days: number }): CiSection {
  const list = obj(json)?.workflow_runs;
  if (!Array.isArray(list)) return { ...UNREADABLE };
  const runs = list.map(obj).filter((r): r is Record<string, unknown> => r !== null && r.event !== "dynamic" && r.status === "completed");
  type Wf = { name: string; runs: number; pass: number; fail: number; secs: number[]; last: z.infer<typeof runRef>; lastBase: z.infer<typeof runRef> };
  const byWf = new Map<unknown, Wf>();
  const seen = new Map<string, Array<Record<string, unknown>>>();
  const sorted = [...runs].sort((a, b) => ((str(a.updated_at) ?? "") < (str(b.updated_at) ?? "") ? -1 : (str(a.updated_at) ?? "") > (str(b.updated_at) ?? "") ? 1 : 0));
  for (const r of sorted) {
    let w = byWf.get(r.workflow_id);
    if (!w) byWf.set(r.workflow_id, (w = { name: str(r.name) ?? "", runs: 0, pass: 0, fail: 0, secs: [], last: null, lastBase: null }));
    w.runs++;
    if (r.conclusion === "success") {
      w.pass++;
      w.secs.push(runSeconds(r));
    } else if (FAILED.includes(String(r.conclusion))) w.fail++;
    w.last = { conclusion: str(r.conclusion), url: str(r.html_url) ?? "", at: str(r.updated_at) ?? "", branch: str(r.head_branch) ?? "" };
    if (r.head_branch === opts.base) w.lastBase = w.last;
    const key = `${String(r.workflow_id)}|${String(r.head_sha)}`;
    seen.set(key, [...(seen.get(key) ?? []), r]);
  }
  const flaky: Array<{ workflow: string; sha: string; url: string; id: number; attempt1: boolean; jobs: string[] }> = [];
  for (const rs of seen.values()) {
    const failed = rs.filter((x) => x.conclusion === "failure" || x.conclusion === "timed_out");
    const ok = rs.filter((x) => x.conclusion === "success");
    const reran = ok.filter((x) => typeof x.run_attempt === "number" && x.run_attempt > 1);
    if ((failed.length > 0 && ok.length > 0) || reran.length > 0) {
      const first = (failed.length > 0 ? failed : reran)[0]!;
      flaky.push({
        workflow: str(rs[0]!.name) ?? "", sha: String(rs[0]!.head_sha ?? "").slice(0, 7), url: str(first.html_url) ?? "",
        id: Number(first.id) || 0, attempt1: reran.length > 0 && failed.length === 0, jobs: [],
      });
    }
  }
  const all = [...byWf.values()];
  const workflows = all
    .map((w) => {
      const done = w.pass + w.fail;
      return {
        name: w.name, runs: w.runs, passRate: done ? pyRound((w.pass / done) * 100) : null,
        avgSeconds: w.secs.length ? pyRound(w.secs.reduce((a, b) => a + b, 0) / w.secs.length) : null, last: w.last, lastBase: w.lastBase,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pass = all.reduce((n, w) => n + w.pass, 0);
  const fail = all.reduce((n, w) => n + w.fail, 0);
  const secs = all.flatMap((w) => w.secs);
  return {
    available: true, days: opts.days, runs: runs.length, passRate: pass + fail ? pyRound((pass / (pass + fail)) * 100) : null,
    avgSeconds: pyRound(secs.reduce((a, b) => a + b, 0) / Math.max(1, secs.length)), flaky: flaky.slice(0, 10), workflows,
    coverage: { enforced: null, measured: null, source: null },
  };
}

/** Names of the jobs that failed in a run's job list: sorted, at most 4. */
export function flakyJobNames(json: unknown): string[] {
  const jobs = obj(json)?.jobs;
  if (!Array.isArray(jobs)) return [];
  const names = new Set<string>();
  for (const j of jobs) {
    const job = obj(j);
    if (job?.conclusion === "failure" && typeof job.name === "string") names.add(job.name);
  }
  return [...names].sort().slice(0, 4);
}

// ---------- coverage ----------
/** The enforced floor: `--cov-fail-under` in the workflows, else `fail_under` in pyproject.toml. */
export function enforcedFloor(workflowTexts: string[], pyproject: string): number | null {
  const m = /--cov-fail-under[= ](\d+)/.exec(workflowTexts.join("")) ?? /fail_under\s*=\s*(\d+)/.exec(pyproject);
  return m ? Number(m[1]) : null;
}

/** The measured line coverage in a report on disk, as a percentage; null when it is not there. */
export function coverageFromReport(kind: "xml" | "json", raw: string): number | null {
  if (kind === "xml") {
    const m = /line-rate="([0-9.]+)"/.exec(raw);
    return m ? pyRound(Number(m[1]) * 100, 1) : null;
  }
  try {
    const pct = (obj(obj(obj(JSON.parse(raw))?.total)?.lines)?.pct) as unknown;
    return typeof pct === "number" ? pct : null;
  } catch {
    return null;
  }
}

// ---------- alerts and npm ----------
const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function parseDependabot(json: unknown): DepsSection["dependabot"] & object {
  if (!Array.isArray(json)) return { ...UNREADABLE };
  const bySeverity: Record<string, number> = {};
  const rows = json.map((a) => {
    const alert = obj(a) ?? {};
    const adv = obj(alert.security_advisory) ?? {};
    return {
      package: str(obj(obj(alert.dependency)?.package)?.name), severity: str(adv.severity),
      summary: (str(adv.summary) ?? "").slice(0, 100), url: str(alert.html_url),
    };
  });
  for (const r of rows) bySeverity[r.severity ?? "low"] = (bySeverity[r.severity ?? "low"] ?? 0) + 1;
  const top = [...rows].sort((a, b) => (SEV_ORDER[a.severity ?? ""] ?? 9) - (SEV_ORDER[b.severity ?? ""] ?? 9)).slice(0, 6);
  return { available: true, total: json.length, bySeverity, top };
}

export function parseCodeScanning(json: unknown): NonNullable<QualityResult["security"]["codeScanning"]> {
  if (!Array.isArray(json)) return { ...UNREADABLE };
  const bySeverity: Record<string, number> = {};
  for (const a of json) {
    const rule = obj(obj(a)?.rule) ?? {};
    const sev = str(rule.security_severity_level) || str(rule.severity) || "low";
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }
  return { available: true, total: json.length, bySeverity };
}

/** Secret-scanning alerts as a count only: the alert objects (which may carry the secret) are dropped here. */
export function parseSecretScanning(json: unknown): NonNullable<QualityResult["security"]["secretScanning"]> {
  return Array.isArray(json) ? { available: true, total: json.length } : { ...UNREADABLE };
}

const NPM_AUDIT_FAILED = { error: "npm audit gave no result (offline?)" };

export function parseNpmAudit(raw: string | null): z.infer<typeof npmAuditSchema> {
  try {
    const v = obj(obj(obj(JSON.parse(raw ?? ""))?.metadata)?.vulnerabilities);
    if (!v) return NPM_AUDIT_FAILED;
    const n = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : 0);
    return { critical: n("critical"), high: n("high"), moderate: n("moderate"), low: n("low") };
  } catch {
    return NPM_AUDIT_FAILED;
  }
}

export function parseNpmOutdated(raw: string | null): z.infer<typeof npmOutdatedSchema> {
  const failed = { error: "npm outdated gave no result" };
  if (raw === null) return failed;
  try {
    const o = obj(JSON.parse(raw.trim() === "" ? "{}" : raw));
    if (!o) return failed;
    const major = Object.entries(o)
      .filter(([, v]) => {
        const p = obj(v);
        return p !== null && typeof p.current === "string" && p.current !== "" && typeof p.latest === "string" && p.latest !== "" && p.current.split(".")[0] !== p.latest.split(".")[0];
      })
      .map(([k]) => k);
    return { total: Object.keys(o).length, major: major.length, majorNames: major.sort().slice(0, 8) };
  } catch {
    return failed;
  }
}

// ---------- git output ----------
export const parseLsFiles = (out: string): string[] => out.split("\0").filter(Boolean);

const CODE_EXT: Record<string, string> = {
  ".py": "Python", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript", ".kt": "Kotlin",
  ".kts": "Kotlin", ".java": "Java", ".swift": "Swift", ".html": "HTML", ".css": "CSS", ".scss": "CSS", ".sql": "SQL", ".sh": "Shell", ".go": "Go",
  ".rs": "Rust", ".c": "C", ".cpp": "C++", ".h": "C/C++", ".gradle": "Gradle", ".bat": "Batch", ".ino": "Arduino",
};
const SKIP_PARTS = ["node_modules/", "dist/", "build/", ".gradle/", "vendor/", "Pods/"];
const TEST_NAME = /(^test_.*\.py$|_test\.\w+$|\.(test|spec)\.\w+$|Tests?\.(kt|swift|java)$)/;
const TEST_DIRS = new Set(["tests", "test", "__tests__", "androidTest", "jvmTest", "commonTest", "iosTest", "e2e"]);

const extOf = (rel: string) => {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
};
const skipped = (rel: string) => SKIP_PARTS.some((s) => `${rel}/`.includes(s));

/** Commit counts per code file from `git log --name-only` (vendor folders and non-code files left out). */
export function parseChurn(out: string): Record<string, number> {
  const churn: Record<string, number> = {};
  for (const line of out.split("\n")) {
    if (line && CODE_EXT[extOf(line)] !== undefined && !skipped(line)) churn[line] = (churn[line] ?? 0) + 1;
  }
  return churn;
}

/** Local branches (not the default or the current one) untouched for more than `staleDays`, oldest first. */
export function parseStaleBranches(out: string, base: string, current: string, nowSec: number, staleDays: number): Array<{ branch: string; days: number }> {
  const stale: Array<{ branch: string; days: number }> = [];
  for (const line of out.split("\n")) {
    const [branch, t] = line.split("\t");
    if (!branch) continue;
    const age = (nowSec - (Number(t) || 0)) / 86400;
    if (branch !== base && branch !== current && age > staleDays) stale.push({ branch, days: pyRound(age) });
  }
  return stale.sort((a, b) => b.days - a.days).slice(0, 8);
}

/** Extra worktrees: every `worktree` line but the first (the main checkout). */
export const parseWorktreeCount = (out: string): number => Math.max(0, out.split("\n").filter((l) => l.startsWith("worktree ")).length - 1);

// ---------- code health ----------
export type FileStat = { rel: string; lang: string; lines: number; test: boolean; todo: Record<string, number> };

export const isTestFile = (rel: string) => {
  const parts = rel.split("/");
  return TEST_NAME.test(parts[parts.length - 1]!) || parts.slice(0, -1).some((p) => TEST_DIRS.has(p));
};

/** Size, language, test-ness and TODO markers of one file's text; null for files that are not source code. */
export function codeStats(rel: string, text: string): FileStat | null {
  const lang = CODE_EXT[extOf(rel)];
  if (lang === undefined || skipped(rel) || rel.endsWith(".min.js") || rel.endsWith(".d.ts")) return null;
  const todo: Record<string, number> = {};
  for (const m of text.matchAll(/\b(TODO|FIXME|HACK)\b/g)) todo[m[1]!] = (todo[m[1]!] ?? 0) + 1;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return { rel, lang, lines, test: isTestFile(rel), todo };
}

export function buildHealth(stats: FileStat[], churn: Record<string, number>, bigLimit: number): HealthSection {
  const loc: Record<string, number> = {};
  const todo: Record<string, number> = {};
  let srcLoc = 0;
  let testLoc = 0;
  for (const s of stats) {
    loc[s.lang] = (loc[s.lang] ?? 0) + s.lines;
    if (s.test) testLoc += s.lines;
    else srcLoc += s.lines;
    for (const [tag, n] of Object.entries(s.todo)) todo[tag] = (todo[tag] ?? 0) + n;
  }
  const sizeOf = new Map(stats.map((s) => [s.rel, s.lines]));
  const sortedLoc = Object.fromEntries(Object.entries(loc).sort((a, b) => b[1] - a[1]));
  return {
    loc: sortedLoc, totalLoc: Object.values(loc).reduce((a, b) => a + b, 0), srcLoc, testLoc,
    testRatio: srcLoc ? pyRound(testLoc / srcLoc, 2) : null, hasTests: testLoc > 0,
    largest: [...stats].sort((a, b) => b.lines - a.lines).slice(0, 8).map((s) => ({ file: s.rel, lines: s.lines, flag: s.lines > bigLimit })),
    todo,
    churn: Object.entries(churn).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([file, changes]) => ({ file, changes, lines: sizeOf.get(file) ?? null })),
  };
}

// ---------- security extras ----------
const SENSITIVE_FILES = [".env", ".env.*", "*.pem", "*.p12", "*.pfx", "*.jks", "*.keystore", "local.properties", "service-account*.json", "id_rsa", "id_ed25519"];
const SENSITIVE_RE = SENSITIVE_FILES.map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`));
/** `.env.example` and friends: templates, not secrets. */
export const SAFE_ENV = /\.(example|sample|template|dist)$|^\.env\.(example|sample|template)$/;

/** Sensitive files that exist, are neither tracked nor ignored; and a missing `.env` rule in .gitignore. */
export function gitignoreGaps(untracked: string[], gitignoreText: string | null): Array<{ file: string; why: string }> {
  const gaps: Array<{ file: string; why: string }> = [];
  for (const rel of untracked) {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (SENSITIVE_RE.some((re) => re.test(name)) && !SAFE_ENV.test(name)) gaps.push({ file: rel, why: "sensitive file exists and is neither ignored nor tracked" });
  }
  if (!/^\s*\/?\.env/m.test(gitignoreText ?? "")) gaps.push({ file: ".gitignore", why: "no rule for .env files" });
  return gaps.slice(0, 20);
}

export const claudeWords = (text: string): number => text.split(/\s+/).filter(Boolean).length;
