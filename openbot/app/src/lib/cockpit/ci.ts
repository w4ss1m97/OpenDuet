import { queryOptions } from "@tanstack/react-query";
import { BASE, type CockpitRun, CockpitOffError, read } from "./queries";
import type { DockerContainer } from "./machine";

/*
 * CI (C3): self-hosted runners found on this Mac, matched to what GitHub says about the repos they serve.
 * Types mirror server/src/openduet/cockpit/ci.ts. Pause and resume are POSTs the server guards by Origin.
 */

export type GithubRunner = {
  name: string;
  status: string;
  busy: boolean;
  os: string;
  labels: string[];
};

export type CiJob = {
  name: string;
  status: string;
  runner: string | null;
  started: string | null;
  workflow: string;
  branch: string;
};

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

export type CiRepo = {
  repo: string;
  projects: string[];
  runners: GithubRunner[];
  runs: CockpitRun[];
  jobs: CiJob[];
  error: string | null;
};

export type CiFacts = {
  repos: CiRepo[];
  local: NativeRunner[];
  containers: DockerContainer[];
  generatedAt: number;
};

export type RunnerState = "paused" | "offline" | "busy" | "idle";

/** A runner's state: paused on this Mac wins, then what GitHub says. */
export function runnerState(
  github: GithubRunner,
  local: Pick<NativeRunner, "paused"> | undefined,
  container: Pick<DockerContainer, "paused"> | undefined,
): RunnerState {
  if (local?.paused || container?.paused) return "paused";
  if (github.status !== "online") return "offline";
  return github.busy ? "busy" : "idle";
}

/** How long a run took, from its start to its last update: `9s`, `1m 05s`, `1h 02m`. */
export function runDuration(
  started: string | null,
  updated: string,
): string {
  const a = started ? Date.parse(started) : Number.NaN;
  const b = Date.parse(updated);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "–";
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s}s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export const ciKeys = { all: ["cockpit", "ci"] as const };

export const ciQueryOptions = () =>
  queryOptions({
    queryKey: ciKeys.all,
    queryFn: ({ signal }): Promise<CiFacts> => read("/api/cockpit/ci", signal),
    refetchInterval: 30_000,
    retry: false,
  });

export type ControlResult =
  | { ok: true; state: "paused" | "running" }
  | { ok: false; busy: boolean; message: string };

/** Pause or resume a runner. A 409 (it is working) comes back as `busy` so the screen can ask before forcing. */
export async function controlRunner(
  name: string,
  action: "pause" | "resume",
  force = false,
): Promise<ControlResult> {
  let response: Response;
  try {
    response = await fetch(
      `${BASE}/api/cockpit/runners/${encodeURIComponent(name)}/${action}${force ? "?force=1" : ""}`,
      { method: "POST", credentials: "omit" },
    );
  } catch {
    throw new CockpitOffError();
  }
  if (response.ok) {
    const body = (await response.json()) as { state: "paused" | "running" };
    return { ok: true, state: body.state };
  }
  if (response.status === 409) {
    return { ok: false, busy: true, message: `${name} is running a job.` };
  }
  return {
    ok: false,
    busy: false,
    message:
      response.status === 429
        ? "Too many pause/resume actions; wait a moment."
        : "The runner could not be controlled.",
  };
}
