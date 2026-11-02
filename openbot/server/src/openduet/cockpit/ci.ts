import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";
import { type TtlCache, createBackground, createTtlCache, type Background } from "./cache";
import { parseRuns } from "./collect";
import { type DockerState, type MachineService, type PublicContainer, type ProcRow, publicContainer, runnerProcess } from "./machine";
import { isSlug, runAllowed, runGh } from "./run";
import type { CockpitRun } from "./types";

/* The CI page: self-hosted runners found on this Mac, matched to GitHub's view of the repos they serve. */

const GH_TTL_MS = 60_000;
const LAUNCHCTL_TTL_MS = 30_000;
const DU_TTL_MS = 600_000;
const MAX_RUNNER_FILE = 16 * 1024;
const MAX_SERVICE_FILE = 1024;
const MAX_JOBS_PER_REPO = 5;
const MAX_JOBS_PER_SNAPSHOT = 10;
const RUNNER_DIR = /^actions-runner[\w.-]*$/;
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** `owner/repo` from a runner's gitHubUrl; null for an organisation URL or any other host. */
export function repoFromUrl(url: string): string | null {
  const m = GITHUB_URL.exec(url);
  const slug = m ? `${m[1]}/${m[2]}` : "";
  return isSlug(slug) ? slug : null;
}

type Info = { isDirectory(): boolean; isSymbolicLink(): boolean; isFile(): boolean; size: number; uid: number };

/** The slice of node:fs/promises discovery uses, so a test can watch which paths are touched. */
export type FsDeps = {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<Info>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
};

export const realFs: FsDeps = {
  readdir: (p) => readdir(p),
  lstat: (p) => lstat(p),
  readFile: (p) => readFile(p, "utf8"),
  realpath: (p) => realpath(p),
};

const runnerFile = z.object({ agentName: z.string().regex(/^[\w.-]{1,64}$/), gitHubUrl: z.string().max(300) });

export type DiscoveredRunner = {
  agentName: string;
  /** Real absolute path; stays on the server. */
  dir: string;
  dirShown: string;
  repo: string | null;
  /** The `.service` file's text, trimmed; checked again before it is ever used. */
  servicePlist: string | null;
};

async function readSmall(fs: FsDeps, path: string, limit: number): Promise<string | null> {
  try {
    const info = await fs.lstat(path);
    if (!info.isFile() || info.size > limit) return null;
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

/**
 * Runner folders in the real home: names are filtered before any lstat, the folder must be a real directory
 * (not a link), and only `.runner` and `.service` are read. A folder without a valid `.runner` is skipped.
 */
export async function discoverRunners(home: string, fs: FsDeps = realFs): Promise<DiscoveredRunner[]> {
  let root: string;
  let names: string[];
  try {
    root = await fs.realpath(home);
    names = (await fs.readdir(root)).filter((n) => RUNNER_DIR.test(n)).sort();
  } catch {
    return [];
  }
  const found: DiscoveredRunner[] = [];
  for (const name of names) {
    const dir = `${root}/${name}`;
    try {
      const info = await fs.lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const text = await readSmall(fs, `${dir}/.runner`, MAX_RUNNER_FILE);
    if (text === null) continue;
    let parsed: z.infer<typeof runnerFile>;
    try {
      const r = runnerFile.safeParse(JSON.parse(text.replace(/^﻿/, "")));
      if (!r.success) continue;
      parsed = r.data;
    } catch {
      continue;
    }
    const service = (await readSmall(fs, `${dir}/.service`, MAX_SERVICE_FILE))?.trim() || null;
    found.push({ agentName: parsed.agentName, dir, dirShown: `~/${name}`, repo: repoFromUrl(parsed.gitHubUrl), servicePlist: service });
  }
  return found;
}

const runnersSchema = z.object({
  runners: z.array(
    z.object({ name: z.string(), status: z.string(), busy: z.boolean(), os: z.string().nullish(), labels: z.array(z.object({ name: z.string() })).nullish() }),
  ),
});
const jobsSchema = z.object({
  jobs: z.array(z.object({ name: z.string(), status: z.string(), runner_name: z.string().nullish(), started_at: z.string().nullish() })),
});

export type GithubRunner = { name: string; status: string; busy: boolean; os: string; labels: string[] };
export type CiJob = { name: string; status: string; runner: string | null; started: string | null; workflow: string; branch: string };

function parseJson(text: string | null): unknown {
  try {
    return text === null ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseGithubRunners(out: string | null): GithubRunner[] | null {
  const parsed = runnersSchema.safeParse(parseJson(out));
  return parsed.success
    ? parsed.data.runners.map((r) => ({ name: r.name, status: r.status, busy: r.busy, os: r.os ?? "", labels: (r.labels ?? []).map((l) => l.name) }))
    : null;
}

export type NativeRunner = {
  name: string;
  dir: string;
  repo: string | null;
  paused: boolean;
  working: boolean;
  serviceLoaded: boolean;
  nice: number | null;
  cpuPercent: number;
  ramMB: number;
  workGB: number | null;
};

export type CiRepo = { repo: string; projects: string[]; runners: GithubRunner[]; runs: CockpitRun[]; jobs: CiJob[]; error: string | null };

/** `GET /api/cockpit/ci`. */
export type CiResponse = { repos: CiRepo[]; local: NativeRunner[]; containers: PublicContainer[]; generatedAt: number };

export type CiDeps = {
  home: string;
  cache: TtlCache;
  now: () => number;
  fs: FsDeps;
  gh: (args: string[]) => Promise<string | null>;
  run: (argv: string[]) => Promise<string | null>;
  machine: { processes(fresh?: boolean): Promise<Map<number, ProcRow> | null>; containers(fresh?: boolean): Promise<DockerState> };
  /** The repos of the C1 projects (the cockpit snapshot is cached, this adds no git or gh call of its own). */
  projectRepos: () => Promise<Array<{ name: string; repo: string | null }>>;
};

export type CiService = {
  ci(): Promise<CiResponse>;
  /** A fresh look at the runner folders (never cached). */
  discover(): Promise<DiscoveredRunner[]>;
  /** Whether GitHub (answer at most 60 s old) says this runner is running a job; `repo` null looks at every known repo. */
  githubBusy(repo: string | null, name: string): Promise<boolean>;
};

export function createCiService(options: Partial<CiDeps> & Pick<CiDeps, "machine" | "projectRepos">): CiService {
  const now = options.now ?? Date.now;
  const home = options.home ?? homedir();
  const cache = options.cache ?? createTtlCache(now);
  const fs = options.fs ?? realFs;
  const gh = options.gh ?? ((args: string[]) => runGh(args));
  const run = options.run ?? ((argv: string[]) => runAllowed(argv));
  const { machine, projectRepos } = options;
  const du = new Map<string, Background<number>>();

  const workGB = (dir: string): number | null => {
    const path = `${dir}/_work`;
    let bg = du.get(path);
    if (!bg) {
      bg = createBackground(
        DU_TTL_MS,
        async () => {
          const kib = /^(\d+)\s/.exec((await run(["du", "-sk", path])) ?? "")?.[1];
          return kib === undefined ? null : Math.round((Number(kib) / 2 ** 20) * 10) / 10;
        },
        now,
      );
      du.set(path, bg);
    }
    return bg.get();
  };

  const githubRunners = (slug: string) =>
    cache.cached<GithubRunner[]>(`ci:runners:${slug}`, GH_TTL_MS, async () => parseGithubRunners(await gh(["api", `repos/${slug}/actions/runners?per_page=100`])));
  const githubRuns = (slug: string) =>
    cache.cached<CockpitRun[]>(`runs:${slug}`, GH_TTL_MS, async () => parseRuns(await gh(["api", `repos/${slug}/actions/runs?per_page=30`])));
  const githubJobs = (slug: string, run: CockpitRun) =>
    cache.cached<CiJob[]>(`ci:jobs:${slug}:${run.id}`, GH_TTL_MS, async () => {
      const parsed = jobsSchema.safeParse(parseJson(await gh(["api", `repos/${slug}/actions/runs/${run.id}/jobs?per_page=50`])));
      if (!parsed.success) return null;
      return parsed.data.jobs
        .filter((j) => j.status !== "completed")
        .map((j) => ({ name: j.name, status: j.status, runner: j.runner_name ?? null, started: j.started_at ?? null, workflow: run.workflow, branch: run.branch }));
    });

  const launchctlLabels = async (): Promise<string[]> =>
    (await cache.cached<string[]>("ci:launchctl", LAUNCHCTL_TTL_MS, async () => {
      const out = await run(["launchctl", "list"]);
      return out === null ? null : out.split("\n").map((l) => l.split("\t")[2]?.trim() ?? "").filter(Boolean);
    })) ?? [];

  return {
    discover: () => discoverRunners(home, fs),
    async githubBusy(repo, name) {
      // A container does not say which repo it serves: look at every repo this page knows.
      const slugs = repo
        ? [repo]
        : [...new Set([...(await projectRepos()).map((p) => p.repo), ...(await discoverRunners(home, fs)).map((r) => r.repo)].filter((r): r is string => !!r && isSlug(r)))];
      const lists = await Promise.all(slugs.map((slug) => githubRunners(slug)));
      return lists.some((list) => (list ?? []).some((r) => r.name === name && r.busy));
    },
    async ci() {
      const [found, procs, docker, labels, projects] = await Promise.all([
        discoverRunners(home, fs), machine.processes(), machine.containers(), launchctlLabels(), projectRepos(),
      ]);
      const table = procs ?? new Map<number, ProcRow>();
      const local: NativeRunner[] = found.map((r) => {
        const p = runnerProcess(table, r.dir);
        return {
          name: r.agentName, dir: r.dirShown, repo: r.repo, paused: p === null, working: p?.working ?? false,
          serviceLoaded: labels.some((l) => l.startsWith("actions.runner.") && l.endsWith(`.${r.agentName}`)),
          nice: p?.nice ?? null, cpuPercent: p?.cpuPercent ?? 0, ramMB: p?.ramMB ?? 0, workGB: workGB(r.dir),
        };
      });

      // Repos: the projects' first (in list order), then the runners'; GitHub treats names case-insensitively.
      const repos = new Map<string, { repo: string; projects: string[] }>();
      for (const { name, repo } of projects) {
        if (!repo || !isSlug(repo)) continue;
        const entry = repos.get(repo.toLowerCase()) ?? { repo, projects: [] };
        entry.projects.push(name);
        repos.set(repo.toLowerCase(), entry);
      }
      for (const r of found) if (r.repo && !repos.has(r.repo.toLowerCase())) repos.set(r.repo.toLowerCase(), { repo: r.repo, projects: [] });

      const read = await Promise.all(
        [...repos.values()].map(async (entry) => {
          const [runners, runs] = await Promise.all([githubRunners(entry.repo), githubRuns(entry.repo)]);
          return { entry, runners, runs };
        }),
      );
      let budget = MAX_JOBS_PER_SNAPSHOT;
      const rows: CiRepo[] = await Promise.all(
        read.map(async ({ entry, runners, runs }) => {
          const active = (runs ?? []).filter((r) => r.status === "queued" || r.status === "in_progress").slice(0, Math.min(MAX_JOBS_PER_REPO, budget));
          budget -= active.length;
          const jobs = (await Promise.all(active.map((r) => githubJobs(entry.repo, r)))).flatMap((j) => j ?? []);
          return {
            repo: entry.repo, projects: entry.projects, runners: runners ?? [], runs: runs ?? [], jobs,
            error: runs === null ? "gh api failed (repo missing, or no access)" : null,
          };
        }),
      );
      return {
        repos: rows,
        local,
        containers: docker.running ? docker.containers.filter((c) => c.runnerName !== null).map(publicContainer) : [],
        generatedAt: now(),
      };
    },
  };
}
