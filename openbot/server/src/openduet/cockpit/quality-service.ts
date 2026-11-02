/*
 * The quality scan's brain: what is scanned and when (one project at a time, never in a GET), the real scan
 * of a project (git, gh, npm, the working tree), and the answers the routes give. Read-only on the projects.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseOrigin } from "./collect";
import { readSmallFile, scanWorkingTree } from "./quality-files";
import {
  type CiSection, type DepsSection, type QualityConfig, type QualityResult, type QualitySections, type Suggestion,
  buildHealth, claudeWords, coverageFromReport, enforcedFloor, flakyJobNames, ghWhy, gitignoreGaps, parseChurn, parseCiRuns, parseCodeScanning,
  parseDependabot, parseLsFiles, parseNpmAudit, parseNpmOutdated, parseSecretScanning, parseStaleBranches, parseWorktreeCount, pyRound,
} from "./quality-parse";
import { highFindings, score, suggestions } from "./quality-score";
import type { QualityStore } from "./quality-store";
import { type GhApiResult, runGhApi, runGit, runNpm } from "./run";
import type { CockpitProject } from "./types";

// ---------- the scan of one project ----------
export type ScanDeps = {
  git(path: string, args: string[]): Promise<string | null>;
  ghApi(path: string): Promise<GhApiResult>;
  npm(path: string, kind: "audit" | "outdated"): Promise<string | null>;
  readFile(root: string, rel: string, maxBytes: number): Promise<string | null>;
  tree: typeof scanWorkingTree;
  /** null when the path does not exist. */
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; mtime: number } | null>;
  listDir(path: string): Promise<string[]>;
};

export const realScanDeps: ScanDeps = {
  git: (path, args) => runGit(path, args),
  ghApi: (path) => runGhApi(path),
  npm: (path, kind) => runNpm(path, kind),
  readFile: (root, rel, maxBytes) => readSmallFile(root, rel, maxBytes),
  tree: scanWorkingTree,
  stat: async (path) => {
    try {
      const s = await stat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), mtime: s.mtimeMs / 1000 };
    } catch {
      return null;
    }
  },
  listDir: (path) => readdir(path).catch(() => []),
};

const SMALL = 256 * 1024;
const REPORT_MAX = 5 * 1024 * 1024;
const MAX_FLAKY_LOOKUPS = 4;

async function defaultBranch(path: string, deps: ScanDeps): Promise<string> {
  const ref = (await deps.git(path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  if (ref) return ref.split("/").slice(1).join("/") || "main";
  for (const b of ["main", "master"]) {
    if ((await deps.git(path, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${b}`])) || (await deps.git(path, ["rev-parse", "--verify", "-q", `refs/heads/${b}`]))) return b;
  }
  return "main";
}

async function coverageInfo(path: string, deps: ScanDeps) {
  const wfDir = join(path, ".github", "workflows");
  const texts: string[] = [];
  for (const name of (await deps.listDir(wfDir)).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const text = await deps.readFile(path, `.github/workflows/${name}`, 1024 * 1024);
    if (text !== null) texts.push(text);
  }
  const enforced = enforcedFloor(texts, (await deps.readFile(path, "pyproject.toml", SMALL)) ?? "");
  for (const [rel, kind] of [["coverage/coverage-summary.json", "json"], ["coverage.xml", "xml"]] as const) {
    const raw = await deps.readFile(path, rel, REPORT_MAX);
    const measured = raw === null ? null : coverageFromReport(kind, raw);
    if (measured !== null) return { enforced, measured, source: `${rel} on disk` };
  }
  return { enforced, measured: null, source: null };
}

async function ciSection(repo: string | null, base: string, path: string, cfg: QualityConfig, nowSec: number, deps: ScanDeps): Promise<CiSection> {
  if (!repo) return { available: false, why: "no GitHub remote" };
  const since = new Date((nowSec - cfg.lookbackDays * 86400) * 1000).toISOString().slice(0, 10);
  const got = await deps.ghApi(`repos/${repo}/actions/runs?per_page=100&created=%3E%3D${since}`);
  if (!got.ok) return { available: false, why: ghWhy(got.status) };
  const ci = parseCiRuns(got.json, { base, days: cfg.lookbackDays });
  if (!ci.available) return ci;
  for (const f of ci.flaky.slice(0, MAX_FLAKY_LOOKUPS)) {
    const jobs = await deps.ghApi(`repos/${repo}/actions/runs/${f.id}/${f.attempt1 ? "attempts/1/" : ""}jobs`);
    if (jobs.ok) f.jobs = flakyJobNames(jobs.json);
  }
  return { ...ci, coverage: await coverageInfo(path, deps) };
}

async function depsSection(repo: string | null, path: string, cfg: QualityConfig, deps: ScanDeps): Promise<DepsSection> {
  const out: DepsSection = { dependabot: null, npm: null, python: null, gradle: (await deps.stat(join(path, "gradlew"))) !== null };
  if (repo) {
    const got = await deps.ghApi(`repos/${repo}/dependabot/alerts?state=open&per_page=100`);
    out.dependabot = got.ok ? parseDependabot(got.json) : { available: false, why: ghWhy(got.status) };
  }
  if (cfg.npm && (await deps.stat(join(path, "package.json")))?.isFile) {
    const hasLock = (await deps.stat(join(path, "package-lock.json"))) !== null;
    out.npm = {
      audit: hasLock ? parseNpmAudit(await deps.npm(path, "audit")) : null,
      outdated: parseNpmOutdated(await deps.npm(path, "outdated")),
    };
  }
  if ((await deps.stat(join(path, "pyproject.toml"))) || (await deps.stat(join(path, "requirements.txt")))) {
    out.python = { skipped: "not scanned (Python: see Dependabot)" };
  }
  return out;
}

async function hygieneSection(repo: string | null, base: string, path: string, cfg: QualityConfig, nowSec: number, deps: ScanDeps): Promise<QualitySections["hygiene"]> {
  const isFile = async (rel: string) => (await deps.stat(join(path, rel)))?.isFile === true;
  const readme = (await isFile("README.md")) || (await isFile("README")) || (await isFile("readme.md"));
  const claudeText = await deps.readFile(path, "CLAUDE.md", SMALL);
  const notes = await deps.stat(join(path, ".claude", "session-notes.md"));
  const newest = Number.parseInt(((await deps.git(path, ["log", "-1", "--format=%ct"])) ?? "").trim(), 10) || 0;
  const notesFile = notes?.isFile ? notes : null;
  const current = ((await deps.git(path, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "").trim();
  let branchProtection: QualitySections["hygiene"]["branchProtection"] = null;
  let autoMerge: boolean | null = null;
  if (repo) {
    const prot = await deps.ghApi(`repos/${repo}/branches/${base}/protection`);
    if (prot.ok) branchProtection = { protected: true };
    else {
      const why = ghWhy(prot.status);
      branchProtection = why === "not set up" ? { protected: false } : { available: false, why };
    }
    const info = await deps.ghApi(`repos/${repo}`);
    const allow = info.ok && typeof info.json === "object" && info.json !== null ? (info.json as Record<string, unknown>).allow_auto_merge : undefined;
    autoMerge = info.ok ? Boolean(allow) : null;
  }
  return {
    readme, claudeMd: claudeText !== null, claudeWords: claudeText === null ? 0 : claudeWords(claudeText),
    notes: notesFile !== null, notesAgeDays: notesFile ? pyRound((nowSec - notesFile.mtime) / 86400, 1) : null,
    notesLagDays: notesFile && newest ? pyRound((newest - notesFile.mtime) / 86400, 1) : null,
    ci: (await deps.stat(join(path, ".github", "workflows")))?.isDirectory === true, branchProtection, autoMerge,
    staleBranches: parseStaleBranches((await deps.git(path, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"])) ?? "", base, current, nowSec, cfg.staleBranchDays),
    worktrees: parseWorktreeCount((await deps.git(path, ["worktree", "list", "--porcelain"])) ?? ""),
  };
}

/** One full scan of a project. Throws only on a bug; every missing tool or answer becomes an "unavailable" field. */
export async function scanProject(project: CockpitProject, cfg: QualityConfig, nowSec: number, deps: ScanDeps = realScanDeps): Promise<QualityResult> {
  const path = project.path;
  const tracked = parseLsFiles((await deps.git(path, ["ls-files", "-z"])) ?? "");
  const repo = parseOrigin(((await deps.git(path, ["remote", "get-url", "origin"])) ?? "").trim());
  const base = await defaultBranch(path, deps);

  const ci = await ciSection(repo, base, path, cfg, nowSec, deps);
  const depsOut = await depsSection(repo, path, cfg, deps);
  const tree = await deps.tree(path, tracked);
  const untracked = parseLsFiles((await deps.git(path, ["ls-files", "-z", "--others", "--exclude-standard"])) ?? "");
  const security: QualitySections["security"] = {
    codeScanning: null, secretScanning: null, local: tree.secrets,
    gitignore: gitignoreGaps(untracked, await deps.readFile(path, ".gitignore", SMALL)),
  };
  if (repo) {
    const code = await deps.ghApi(`repos/${repo}/code-scanning/alerts?state=open&per_page=100`);
    security.codeScanning = code.ok ? parseCodeScanning(code.json) : { available: false, why: ghWhy(code.status) };
    const secret = await deps.ghApi(`repos/${repo}/secret-scanning/alerts?state=open&per_page=100&hide_secret=true`);
    security.secretScanning = secret.ok ? parseSecretScanning(secret.json) : { available: false, why: ghWhy(secret.status) };
  }
  const churn = parseChurn((await deps.git(path, ["log", "--since=30.days", "--name-only", "--format=", "--no-renames", "--no-merges"])) ?? "");
  const sections: QualitySections = {
    project: project.name, path, repo, default: base, scannedAt: nowSec, files: tracked.length, ci, deps: depsOut, security,
    health: buildHealth(tree.stats, churn, cfg.bigFileLines), hygiene: await hygieneSection(repo, base, path, cfg, nowSec, deps),
  };
  return { ...sections, ...score(sections, cfg), suggestions: suggestions(project.name, sections, base, cfg), highFindings: highFindings(sections) };
}

// ---------- the service ----------
export type ScanFn = (project: CockpitProject, cfg: QualityConfig, nowSec: number) => Promise<QualityResult>;
export type QualityStatus = { scanning: string | null; queue: string[]; lastRun: number; lastError: string | null };
export type QualitySummary = {
  projects: Array<{ name: string; grade: string; score: number; scannedAt: number; high: QualityResult["highFindings"] }>;
  status: QualityStatus;
  configError: string | null;
  storeError: string | null;
};
export type QualityDetail = {
  result: QualityResult;
  trend: Array<{ day: string; score: number; grade: string }>;
  suggestions: Array<Suggestion & { dismissedUntil: number }>;
};

export type QualityService = {
  summary(): Promise<QualitySummary>;
  detail(name: string): Promise<QualityDetail | null>;
  /** Queues a scan of one project (or "all") and returns at once. */
  requestScan(target: string): Promise<{ accepted: true; queued: string[] } | { accepted: false; error: string }>;
  dismiss(project: string, key: string): Promise<{ ok: true; until: number } | { ok: false; error: string }>;
  /** Queues the projects whose last scan is older than scanHours, and waits for the queue to empty. */
  runDue(): Promise<void>;
  /** Resolves when nothing is queued or running. */
  idle(): Promise<void>;
  /** First check after `firstDelayMs`, then every `intervalMs`. Returns the stop function. */
  start(options?: { firstDelayMs?: number; intervalMs?: number }): () => void;
};

const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 15 * 60_000;
const RETRY_AFTER_FAILURE_SECONDS = 3600;
const TREND_DAYS = 30;

export function createQualityService(options: {
  store: QualityStore;
  listProjects: () => CockpitProject[] | Promise<CockpitProject[]>;
  config: () => Promise<{ config: QualityConfig; error: string | null }>;
  scan?: ScanFn;
  now?: () => number;
}): QualityService {
  const now = options.now ?? Date.now;
  const scan: ScanFn = options.scan ?? ((p, cfg, nowSec) => scanProject(p, cfg, nowSec));
  const status: QualityStatus = { scanning: null, queue: [], lastRun: 0, lastError: null };
  const lastAttempt = new Map<string, number>();
  let running: Promise<void> | null = null;

  const pump = () => {
    if (running) return;
    running = (async () => {
      while (status.queue.length > 0) {
        const name = status.queue.shift()!;
        status.scanning = name;
        try {
          const project = (await options.listProjects()).find((p) => p.name === name);
          if (project) {
            const { config } = await options.config();
            await options.store.saveScan(await scan(project, config, Math.floor(now() / 1000)));
          }
        } catch (error) {
          // one broken project must not hide the others
          status.lastError = `${name}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
        }
        lastAttempt.set(name, now() / 1000);
      }
      status.scanning = null;
      status.lastRun = now() / 1000;
      running = null;
    })();
  };

  const enqueue = (names: string[]) => {
    const added = names.filter((n) => n !== status.scanning && !status.queue.includes(n));
    status.queue.push(...added);
    if (added.length > 0) pump();
    return added;
  };

  const idle = async () => {
    while (running) await running;
  };

  const runDue = async () => {
    const { config } = await options.config();
    if (!config.enabled) return;
    const [projects, { data }] = await Promise.all([options.listProjects(), options.store.read()]);
    const nowSec = now() / 1000;
    const limit = nowSec - config.scanHours * 3600;
    const due = projects.filter((p) => (data.scans[p.name]?.scannedAt ?? 0) < limit && nowSec - (lastAttempt.get(p.name) ?? 0) >= RETRY_AFTER_FAILURE_SECONDS);
    enqueue(due.map((p) => p.name));
    await idle();
  };

  return {
    async summary() {
      const [{ config: _config, error: configError }, projects, { data, error: storeError }] = await Promise.all([options.config(), options.listProjects(), options.store.read()]);
      const names = new Set(projects.map((p) => p.name));
      return {
        projects: Object.values(data.scans)
          .filter((r) => names.has(r.project))
          .map((r) => ({ name: r.project, grade: r.grade, score: r.score, scannedAt: r.scannedAt, high: r.highFindings })),
        status: { ...status, queue: [...status.queue] },
        configError,
        storeError,
      };
    },
    async detail(name) {
      const [projects, { data }] = await Promise.all([options.listProjects(), options.store.read()]);
      const result = data.scans[name];
      if (!result || !projects.some((p) => p.name === name)) return null;
      return {
        result,
        trend: (data.history[name] ?? []).slice(-TREND_DAYS).map(({ day, score: s, grade }) => ({ day, score: s, grade })),
        suggestions: result.suggestions.map((s) => ({ ...s, dismissedUntil: data.dismissed[s.key] ?? 0 })),
      };
    },
    async requestScan(target) {
      const projects = await options.listProjects();
      const names = target === "all" ? projects.map((p) => p.name) : projects.some((p) => p.name === target) ? [target] : [];
      if (names.length === 0) return { accepted: false, error: "unknown project" };
      return { accepted: true, queued: enqueue(names) };
    },
    async dismiss(project, key) {
      const { data } = await options.store.read();
      const result = data.scans[project];
      if (!result) return { ok: false, error: "unknown project" };
      if (!result.suggestions.some((s) => s.key === key)) return { ok: false, error: "unknown suggestion" };
      return { ok: true, until: await options.store.dismiss(key) };
    },
    runDue,
    idle,
    start(opts = {}) {
      const tick = () => {
        runDue().catch(() => undefined);
      };
      const first = setTimeout(tick, opts.firstDelayMs ?? FIRST_CHECK_MS);
      const timer = setInterval(tick, opts.intervalMs ?? CHECK_EVERY_MS);
      first.unref();
      timer.unref();
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    },
  };
}
