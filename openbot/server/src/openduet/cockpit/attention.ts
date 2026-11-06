import type { AttentionItem, CockpitThresholds, ProjectData, Severity } from "./types";

/** When a project starts asking for attention. */
export const DEFAULT_THRESHOLDS: CockpitThresholds = {
  dirtyHours: 24,
  notesLagDays: 2,
  sessionIdleHours: 6,
};

const clamp = (value: unknown, fallback: number, min: number, max: number) => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, n));
};

/** Thresholds from any source, each held to a sane range. */
export function clampThresholds(input: Partial<CockpitThresholds>): CockpitThresholds {
  return {
    dirtyHours: clamp(input.dirtyHours, DEFAULT_THRESHOLDS.dirtyHours, 1, 720),
    notesLagDays: clamp(input.notesLagDays, DEFAULT_THRESHOLDS.notesLagDays, 0.5, 90),
    sessionIdleHours: clamp(input.sessionIdleHours, DEFAULT_THRESHOLDS.sessionIdleHours, 1, 720),
  };
}

/** A length of time in seconds as `12min`, `5h` or `3d`. */
export function ago(seconds: number): string {
  const sec = Math.max(0, seconds);
  if (sec < 3600) return `${Math.floor(sec / 60)}min`;
  if (sec < 172800) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** The reasons one project needs a look. `now` is in seconds. */
export function attentionFor(
  project: ProjectData,
  thresholds: CockpitThresholds,
  now: number,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const add = (severity: Severity, message: string, link: string | null = null) =>
    items.push({ project: project.name, severity, message, link });

  if (project.error) {
    add("low", project.error);
    return items;
  }
  const base = project.default ?? "main";

  // The latest finished run of each workflow on the default branch (not Dependabot's own runs).
  const latest = new Map<string, NonNullable<ProjectData["runs"]>[number]>();
  for (const run of [...(project.runs ?? [])].sort((a, b) => a.t - b.t)) {
    if (run.branch === base && run.status === "completed" && !run.dynamic) {
      latest.set(String(run.wid ?? run.workflow), run);
    }
  }
  for (const run of latest.values()) {
    if (run.conclusion && FAILED.has(run.conclusion)) {
      add("high", `CI «${run.workflow}» failed on ${base} (${ago(now - run.t)} ago)`, run.url);
    }
  }

  for (const pr of project.prs ?? []) {
    if (pr.checks === "success" && !pr.draft && pr.mergeState !== "DIRTY" && pr.mergeState !== "BEHIND") {
      add("medium", `PR #${pr.number} is green, waiting to be merged: ${pr.title}`, pr.url);
    }
  }

  const dirty = project.dirty;
  if (dirty && dirty.count && dirty.oldest && now - dirty.oldest > thresholds.dirtyHours * 3600) {
    add("medium", `${dirty.count} uncommitted file(s), oldest ${ago(now - dirty.oldest)} old`);
  }
  if (project.ahead) add("medium", `${project.ahead} commit(s) not pushed on ${project.branch}`);

  const notes = project.notes;
  if (notes && (notes.blocked || notes.waiting)) {
    add("medium", `Session notes say ${notes.blocked ? "BLOCKED" : "waiting on the owner"}`);
  }
  if (notes && project.newestCommit && project.newestCommit - notes.mtime > thresholds.notesLagDays * 86400) {
    add("low", `Session notes are ${ago(project.newestCommit - notes.mtime)} older than the newest commit`);
  }
  if (!notes) add("low", "No .claude/session-notes.md");

  for (const wt of project.worktrees ?? []) {
    if (wt.ahead && !wt.prMerged) {
      const folder = wt.path.split("/").pop();
      add("medium", `Worktree ${folder} (${wt.branch}) has ${wt.ahead} commit(s) not in ${base}`);
    }
  }

  const idle = (project.sessions ?? []).filter(
    (s) => s.status !== "busy" && now - s.updatedAt / 1000 > thresholds.sessionIdleHours * 3600,
  );
  if (idle.length) {
    const longest = Math.max(...idle.map((s) => now - s.updatedAt / 1000));
    const names = idle.slice(0, 3).map((s) => `«${s.name}»`).join(", ");
    add(
      "low",
      `${idle.length} Claude session(s) idle for more than ${thresholds.sessionIdleHours}h (longest ${ago(longest)}): ${names}${idle.length > 3 ? "…" : ""}`,
    );
  }
  return items;
}

/** Every project's items in one list, high first; inside a level the project order is kept. */
export function buildAttention(
  projects: ProjectData[],
  thresholds: CockpitThresholds,
  now: number,
): AttentionItem[] {
  return projects
    .flatMap((project) => attentionFor(project, thresholds, now))
    .map((item, index) => ({ item, index }))
    .sort((a, b) => RANK[a.item.severity] - RANK[b.item.severity] || a.index - b.index)
    .map(({ item }) => item);
}
