/** A project from the list file: the name on its card and its real path. */
export type CockpitProject = { name: string; path: string };

export type Severity = "high" | "medium" | "low";

/** One line of the attention inbox. `link` is a GitHub URL, or null when the fix is local. */
export type AttentionItem = {
  project: string;
  severity: Severity;
  message: string;
  link: string | null;
};

export type CockpitThresholds = {
  dirtyHours: number;
  notesLagDays: number;
  sessionIdleHours: number;
};

/** Session notes. Times are seconds since the epoch. */
export type CockpitNotes = {
  title: string;
  updated: string | null;
  mtime: number;
  blocked: boolean;
  waiting: boolean;
  /** The "Exact next step" section, when the notes have one. */
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

export type CockpitDirty = { count: number; oldest: number | null; files: string[] };

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

/** A running Claude Code session. `updatedAt` is milliseconds. */
export type CockpitSession = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: string;
  updatedAt: number;
};

/** What the cockpit knows about one project. Everything but name, path and error is absent when error is set. */
export type ProjectData = {
  name: string;
  /** The path with the home folder written as `~`. */
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
  dirty?: CockpitDirty;
  commits?: CockpitCommit[];
  notesLog?: Array<{ t: number; sha: string; subject: string }>;
  notes?: CockpitNotes | null;
  worktrees?: CockpitWorktree[];
  prs?: CockpitPr[] | null;
  runs?: CockpitRun[] | null;
  sessions?: CockpitSession[];
  newestCommit?: number | null;
};

/** `GET /api/cockpit/projects`. */
export type CockpitSnapshot = {
  projects: ProjectData[];
  attention: AttentionItem[];
  names: string[];
  generatedAt: number;
};
