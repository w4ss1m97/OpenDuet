import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { z } from "zod";
import { buildAttention, clampThresholds } from "./attention";
import { type TtlCache, createTtlCache } from "./cache";
import { PROJECTS_FILE, SESSIONS_DIR, loadCockpitProjects, readNotesFile, safeSubpath, sessionFiles } from "./projects-file";
import { runGh, runGit } from "./run";
import type {
  CheckStatus,
  CockpitNotes,
  CockpitPr,
  CockpitProject,
  CockpitRun,
  CockpitSession,
  CockpitSnapshot,
  CockpitThresholds,
  CockpitWorktree,
  AttentionItem,
  ProjectData,
} from "./types";

const GIT_TTL_MS = 15_000;
const GH_TTL_MS = 60_000;
const MERGED_TTL_MS = 300_000;
const SECTION_MAX = 4000;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const ORIGIN = /github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** Session notes -> title, updated, flags, sections (each cut to 4000 characters) and the "Exact next step". */
export function parseNotes(text: string, mtime: number): CockpitNotes {
  let title = "";
  const sections: Array<{ title: string; lines: string[] }> = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) sections.push({ title: line.slice(3).trim(), lines: [] });
    else if (line.startsWith("# ") && !title) title = line.slice(2).trim();
    else sections.at(-1)?.lines.push(line);
  }
  const done = sections.map((s) => ({ title: s.title, text: s.lines.join("\n").trim().slice(0, SECTION_MAX) }));
  return {
    title,
    updated: /^Updated:\s*(\S+)/m.exec(text)?.[1] ?? null,
    mtime,
    blocked: /\bBLOCKED\b/.test(text),
    waiting: /waiting on (the )?owner/i.test(text),
    nextStep: done.find((s) => /^exact next step/i.test(s.title))?.text ?? null,
    sections: done,
  };
}

/** `owner/repo` from a GitHub remote URL; null for anything else. */
export function parseOrigin(url: string): string | null {
  return ORIGIN.exec(url.trim())?.[1] ?? null;
}

/** The check-run rollup of a PR as one word. */
export function checkStatus(rollup: Array<Record<string, unknown>> | null | undefined): CheckStatus {
  if (!rollup?.length) return "none";
  const states = rollup.map((c) => {
    if (c.__typename === "StatusContext") {
      return c.state === "SUCCESS" ? "ok" : c.state === "PENDING" || c.state === "EXPECTED" ? "wait" : "bad";
    }
    if (c.status !== "COMPLETED") return "wait";
    return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(c.conclusion)) ? "ok" : "bad";
  });
  return states.includes("bad") ? "failure" : states.includes("wait") ? "pending" : "success";
}

/** Paths from `git status --porcelain=v1 -z`. */
export function parseDirty(out: string): string[] {
  return out.split("\0").filter((e) => e.length > 3).map((e) => e.slice(3));
}

/** Linked worktrees (not the main checkout) that sit on a branch; branch names git would not print are dropped. */
export function parseWorktrees(out: string): Array<{ path: string; branch: string }> {
  const found: Array<{ path: string; branch: string }> = [];
  for (const block of out.split("\n\n").filter((b) => b.trim()).slice(1)) {
    const kv = new Map<string, string>();
    for (const line of block.split("\n")) {
      const at = line.indexOf(" ");
      kv.set(at < 0 ? line : line.slice(0, at), at < 0 ? "" : line.slice(at + 1));
    }
    const path = kv.get("worktree");
    const branch = (kv.get("branch") ?? "").replace("refs/heads/", "");
    if (!path || kv.has("prunable") || !branch || branch.startsWith("-") || !BRANCH.test(branch)) continue;
    found.push({ path, branch });
  }
  return found;
}

/** Whether `pid` is a running process (EPERM means it is, and is somebody else's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sessionSchema = z.object({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1).max(100),
  cwd: z.string().startsWith("/").max(1000),
  name: z.string().max(200).default(""),
  status: z.string().max(40).default(""),
  updatedAt: z.number().default(0),
});

/** Live Claude sessions from `*.json` in the sessions folder; only the six fields below are kept. */
export async function loadSessions(dir: string = SESSIONS_DIR, alive: (pid: number) => boolean = pidAlive): Promise<CockpitSession[]> {
  const sessions: CockpitSession[] = [];
  for (const file of await sessionFiles(dir)) {
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (!parsed.success || !alive(parsed.data.pid)) continue;
      const { pid, sessionId, cwd, name, status, updatedAt } = parsed.data;
      sessions.push({ pid, sessionId, cwd, name, status, updatedAt });
    } catch {
      // unreadable or half-written: skip
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Sessions whose cwd is one of the paths or inside one (on a folder boundary). */
export function matchSessions(sessions: CockpitSession[], paths: string[]): CockpitSession[] {
  return sessions.filter((s) => paths.some((p) => s.cwd === p || s.cwd.startsWith(p + sep)));
}

const githubUrl = z.string().startsWith("https://github.com/");
const prSchema = z.array(
  z.object({
    number: z.number(),
    title: z.string(),
    headRefName: z.string(),
    url: githubUrl,
    isDraft: z.boolean(),
    mergeStateStatus: z.string(),
    statusCheckRollup: z.array(z.record(z.string(), z.unknown())).nullish(),
    updatedAt: z.string(),
  }),
);
const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number(),
      workflow_id: z.number().nullish(),
      event: z.string().nullish(),
      name: z.string(),
      head_branch: z.string().nullish(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: githubUrl,
      updated_at: z.string(),
    }),
  ),
});

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parsePrs(out: string | null): CockpitPr[] | null {
  const parsed = prSchema.safeParse(parseJson(out));
  if (!parsed.success) return null;
  return parsed.data.map((p) => ({
    number: p.number, title: p.title, branch: p.headRefName, url: p.url, draft: p.isDraft,
    mergeState: p.mergeStateStatus, checks: checkStatus(p.statusCheckRollup), updated: p.updatedAt,
  }));
}

function parseMerged(out: string | null): string[] | null {
  const parsed = z.array(z.object({ headRefName: z.string() })).safeParse(parseJson(out));
  return parsed.success ? [...new Set(parsed.data.map((p) => p.headRefName))].sort() : null;
}

function parseRuns(out: string | null): CockpitRun[] | null {
  const parsed = runsSchema.safeParse(parseJson(out));
  if (!parsed.success) return null;
  return parsed.data.workflow_runs.map((r) => ({
    id: r.id, wid: r.workflow_id ?? null, dynamic: r.event === "dynamic", workflow: r.name,
    branch: r.head_branch ?? "", status: r.status, conclusion: r.conclusion, url: r.html_url,
    updated: r.updated_at, t: Date.parse(r.updated_at) / 1000,
  }));
}

/** Everything collectProject reads from the machine, so a test can stand in for it. */
export type CollectDeps = {
  git(path: string, args: string[]): Promise<string | null>;
  gh(args: string[]): Promise<string | null>;
  cache: TtlCache;
  home: string;
  readNotes(path: string): Promise<{ text: string; mtime: number } | null>;
  /** Seconds since the epoch of a file's last change; null when it is gone. */
  mtimeOf(path: string): Promise<number | null>;
  /** The real path when it lies inside the home folder; null otherwise. */
  realUnderHome(path: string): Promise<string | null>;
  sessions: CockpitSession[];
};

const int = (text: string | null) => Number.parseInt((text ?? "").trim(), 10) || 0;

async function defaultBranch(path: string, deps: CollectDeps): Promise<string> {
  const ref = (await deps.git(path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.trim();
  if (ref) return ref.split("/").slice(1).join("/") || "main";
  for (const b of ["main", "master"]) {
    if (
      (await deps.git(path, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${b}`])) ||
      (await deps.git(path, ["rev-parse", "--verify", "-q", `refs/heads/${b}`]))
    ) return b;
  }
  return "main";
}

async function dirtyInfo(path: string, deps: CollectDeps) {
  const entries = parseDirty((await deps.git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])) ?? "");
  const times = (await Promise.all(entries.slice(0, 500).map((e) => deps.mtimeOf(join(path, e))))).filter((t): t is number => t !== null);
  return { count: entries.length, oldest: times.length ? Math.min(...times) : null, files: entries.slice(0, 8) };
}

async function worktreesInfo(path: string, base: string, merged: Set<string>, deps: CollectDeps): Promise<CockpitWorktree[]> {
  const listed = parseWorktrees((await deps.git(path, ["worktree", "list", "--porcelain"])) ?? "");
  const ref = (await deps.git(path, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`])) ? `origin/${base}` : base;
  const found: CockpitWorktree[] = [];
  for (const { path: wt, branch } of listed) {
    const real = await deps.realUnderHome(wt);
    if (!real) continue;
    const [ahead, dirty] = await Promise.all([
      deps.git(path, ["rev-list", "--count", `${ref}..${branch}`]),
      dirtyInfo(real, deps),
    ]);
    found.push({ path: real, branch, ahead: int(ahead), dirty: dirty.count, prMerged: merged.has(branch) });
  }
  return found;
}

/** One project's card: git state, notes, worktrees, PRs, CI and live sessions. Failures leave a field empty. */
export async function collectProject(project: CockpitProject, deps: CollectDeps): Promise<ProjectData> {
  const { path } = project;
  const shown = path.startsWith(deps.home) ? `~${path.slice(deps.home.length)}` : path;
  const out: ProjectData = { name: project.name, path: shown, error: null };
  const git = (...args: string[]) => deps.git(path, args);
  if ((await git("rev-parse", "--git-dir")) === null) return { ...out, error: "not a git repository" };

  const origin = ((await git("remote", "get-url", "origin")) ?? "").trim();
  const repo = parseOrigin(origin);
  const base = await defaultBranch(path, deps);
  const [branchOut, upstreamOut, log, notesLogOut, dirty] = await Promise.all([
    git("rev-parse", "--abbrev-ref", "HEAD"),
    git("rev-parse", "--abbrev-ref", "@{u}"),
    git("log", "-15", "--format=%H%x1f%ct%x1f%an%x1f%s"),
    git("log", "-8", "--format=%ct%x1f%h%x1f%s", "--", ".claude/session-notes.md"),
    dirtyInfo(path, deps),
  ]);
  const upstream = (upstreamOut ?? "").trim() || null;
  const [behind, ahead] = await Promise.all([
    upstream ? git("rev-list", "--count", "HEAD..@{u}") : null,
    origin ? git("rev-list", "--count", "HEAD", "--not", "--remotes") : null,
  ]);

  const commits = (log ?? "").split("\n").filter(Boolean).flatMap((line) => {
    const [sha, t, author, subject] = line.split("\x1f");
    if (!sha || !t) return [];
    return [{ sha: sha.slice(0, 7), t: int(t), author: author ?? "", subject: subject ?? "", url: repo ? `https://github.com/${repo}/commit/${sha}` : null }];
  });
  const notesLog = (notesLogOut ?? "").split("\n").filter(Boolean).flatMap((line) => {
    const [t, sha, subject] = line.split("\x1f");
    return t && sha ? [{ t: int(t), sha, subject: subject ?? "" }] : [];
  });

  const merged = repo ? await deps.cache.cached(`merged:${repo}`, MERGED_TTL_MS, async () => parseMerged(await deps.gh(["pr", "list", "--repo", repo, "--state", "merged", "--limit", "40", "--json", "headRefName"]))) : null;
  const worktrees = await worktreesInfo(path, base, new Set(merged ?? []), deps);
  const [prs, runs] = repo
    ? await Promise.all([
        deps.cache.cached(`prs:${repo}`, GH_TTL_MS, async () => parsePrs(await deps.gh(["pr", "list", "--repo", repo, "--state", "open", "--limit", "30", "--json", "number,title,headRefName,url,isDraft,mergeStateStatus,statusCheckRollup,updatedAt"]))),
        deps.cache.cached(`runs:${repo}`, GH_TTL_MS, async () => parseRuns(await deps.gh(["api", `repos/${repo}/actions/runs?per_page=30`]))),
      ])
    : [null, null];

  const rawNotes = await deps.readNotes(path);
  return {
    ...out,
    repo, repoUrl: repo ? `https://github.com/${repo}` : null, default: base,
    branch: (branchOut ?? "").trim(), upstream, ahead: int(ahead), behind: int(behind), hasRemote: origin !== "",
    dirty, commits, notesLog, notes: rawNotes ? parseNotes(rawNotes.text, rawNotes.mtime) : null,
    worktrees, prs, runs,
    sessions: matchSessions(deps.sessions, [path, ...worktrees.map((w) => w.path)]),
    newestCommit: commits[0]?.t ?? null,
  };
}

export type CockpitService = {
  snapshot(): Promise<CockpitSnapshot>;
  project(name: string): Promise<{ project: ProjectData; attention: AttentionItem[] } | null>;
};

/** The service the routes call; every default is the real machine, each can be replaced in a test. */
export function createCockpitService(options: {
  listProjects?: () => CockpitProject[] | Promise<CockpitProject[]>;
  loadSessionList?: () => CockpitSession[] | Promise<CockpitSession[]>;
  home?: string;
  now?: () => number;
  thresholds?: Partial<CockpitThresholds>;
  deps?: Partial<CollectDeps>;
} = {}): CockpitService {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const cache = options.deps?.cache ?? createTtlCache(now);
  const thresholds = clampThresholds(options.thresholds ?? {});
  const list = options.listProjects ?? (() => loadCockpitProjects({ file: PROJECTS_FILE, home }));
  const sessionsNow = options.loadSessionList ?? (() => loadSessions());
  const baseDeps: Omit<CollectDeps, "sessions"> = {
    git: (path, args) => runGit(path, args),
    gh: (args) => runGh(args),
    cache,
    home,
    readNotes: readNotesFile,
    mtimeOf: async (p) => {
      try {
        return (await lstat(p)).mtimeMs / 1000;
      } catch {
        return null;
      }
    },
    realUnderHome: (p) => safeSubpath(home, p),
    ...options.deps,
  };
  const collect = async (projects: CockpitProject[]) => {
    const sessions = await sessionsNow();
    return Promise.all(
      projects.map(async (project) =>
        (await cache.cached(`project:${project.name}:${project.path}`, GIT_TTL_MS, () => collectProject(project, { ...baseDeps, sessions }))) ??
        ({ name: project.name, path: project.path, error: "could not read this project" } satisfies ProjectData),
      ),
    );
  };
  return {
    async snapshot() {
      const projects = await list();
      const data = await collect(projects);
      const at = now();
      return { projects: data, attention: buildAttention(data, thresholds, at / 1000), names: projects.map((p) => p.name), generatedAt: at };
    },
    async project(name) {
      const found = (await list()).find((p) => p.name === name);
      if (!found) return null;
      const [data] = await collect([found]);
      return { project: data!, attention: buildAttention([data!], thresholds, now() / 1000) };
    },
  };
}
