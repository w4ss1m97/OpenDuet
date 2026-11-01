import { queryOptions } from "@tanstack/react-query";

/*
 * The cockpit: a read-only view of the projects on this Mac, served by its own small server
 * (server/src/openduet/cockpit). It listens on 127.0.0.1 only, on another port than the API, so these
 * reads are cross-origin and carry no credentials. That is why they do not go through `client`, which
 * always sends them. Times are seconds since the epoch, except a session's `updatedAt` (milliseconds).
 */

export type Severity = "high" | "medium" | "low";

/** One line of the attention inbox. `link` is a GitHub URL, or null when the fix is local. */
export type AttentionItem = {
  project: string;
  severity: Severity;
  message: string;
  link: string | null;
};

export type CockpitNotes = {
  title: string;
  updated: string | null;
  mtime: number;
  blocked: boolean;
  waiting: boolean;
  nextStep: string | null;
  sections: Array<{ title: string; text: string }>;
};

export type CockpitCommit = {
  sha: string;
  t: number;
  author: string;
  subject: string;
  url: string | null;
};

export type CockpitWorktree = {
  path: string;
  branch: string;
  ahead: number;
  dirty: number;
  prMerged: boolean;
};

export type CheckStatus = "success" | "failure" | "pending" | "none";

export type CockpitPr = {
  number: number;
  title: string;
  branch: string;
  url: string;
  draft: boolean;
  mergeState: string;
  checks: CheckStatus;
  updated: string;
};

export type CockpitRun = {
  id: number;
  wid: number | null;
  dynamic: boolean;
  workflow: string;
  branch: string;
  status: string;
  conclusion: string | null;
  url: string;
  updated: string;
  t: number;
};

export type CockpitSession = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: string;
  updatedAt: number;
};

/** One project. When `error` is set, only `name`, `path` and `error` are there. */
export type CockpitProject = {
  name: string;
  path: string;
  error: string | null;
  repo?: string | null;
  repoUrl?: string | null;
  default?: string;
  branch?: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  hasRemote?: boolean;
  dirty?: { count: number; oldest: number | null; files: string[] };
  commits?: CockpitCommit[];
  notes?: CockpitNotes | null;
  worktrees?: CockpitWorktree[];
  prs?: CockpitPr[] | null;
  runs?: CockpitRun[] | null;
  sessions?: CockpitSession[];
  newestCommit?: number | null;
};

export type CockpitSnapshot = {
  projects: CockpitProject[];
  attention: AttentionItem[];
  names: string[];
  generatedAt: number;
};

export type CockpitDetail = {
  project: CockpitProject;
  attention: AttentionItem[];
};

export const cockpitKeys = {
  all: ["cockpit"] as const,
  list: ["cockpit", "projects"] as const,
  detail: (name: string) => ["cockpit", "projects", name] as const,
};

const BASE = `http://127.0.0.1:${import.meta.env.VITE_COCKPIT_PORT ?? 3002}`;

/** Thrown when the cockpit server does not answer at all, so a screen can say it is off. */
export class CockpitOffError extends Error {
  constructor() {
    super("Cockpit is off");
    this.name = "CockpitOffError";
  }
}

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      credentials: "omit",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CockpitOffError();
  }
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "That project isn't in the cockpit list."
        : "Couldn't load the cockpit. Reload the page.",
    );
  }
  return (await response.json()) as T;
}

const REFRESH_MS = 30_000;

export const cockpitProjectsQueryOptions = () =>
  queryOptions({
    queryKey: cockpitKeys.list,
    queryFn: ({ signal }): Promise<CockpitSnapshot> =>
      read("/api/cockpit/projects", signal),
    refetchInterval: REFRESH_MS,
    retry: false,
  });

export const cockpitProjectQueryOptions = (name: string) =>
  queryOptions({
    queryKey: cockpitKeys.detail(name),
    queryFn: ({ signal }): Promise<CockpitDetail> =>
      read(`/api/cockpit/projects/${encodeURIComponent(name)}`, signal),
    refetchInterval: REFRESH_MS,
    retry: false,
  });
