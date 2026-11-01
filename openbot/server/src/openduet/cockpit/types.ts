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

/** A tracked file or folder of the committed tree, at most three levels deep. `files` and `bytes` count everything below a folder. */
export type ExploreNode = { path: string; type: "dir" | "file"; files: number; bytes: number };

export type ExploreLanguage = { name: string; files: number; bytes: number; lines: number };

export type ExploreManifest = {
  path: string;
  kind: "npm" | "python" | "rust" | "go" | "gradle" | "other";
  name: string | null;
  version: string | null;
  dependencies: string[];
  scripts: string[];
};

export type ExploreWorkflow = { path: string; name: string; triggers: string[]; jobs: string[] };

export type ExploreDoc = { path: string; title: string | null; bytes: number };

export type ExploreTag = { name: string; t: number; sha: string };

export type ExploreRelease = { tag: string; name: string; t: number; url: string; prerelease: boolean };

/** `GET /api/cockpit/projects/:name/explore`: facts read from the committed HEAD tree only. `head` is null for an empty repo. */
export type ExploreFacts = {
  head: string | null;
  /** Milliseconds since the epoch. */
  generatedAt: number;
  files: number;
  bytes: number;
  /** True when the tree had more than 50 000 entries or a git answer was too big. */
  truncated: boolean;
  languages: ExploreLanguage[];
  tree: ExploreNode[];
  treeTruncated: boolean;
  manifests: ExploreManifest[];
  workflows: ExploreWorkflow[];
  docs: ExploreDoc[];
  entryPoints: string[];
  /** Newest first. */
  tags: ExploreTag[];
  /** Null when the project has no GitHub remote or gh failed. */
  releases: ExploreRelease[] | null;
};

export type ExplainSection = { title: string; text: string };
export type ExplainNode = { id: string; label: string; kind: string };
export type ExplainEdge = { from: string; to: string; label: string };
export type ExplainModule = { path: string; role: string };

/** What the model explains, in French. The diagram is data: the app draws it, labels are plain text. */
export type Explanation = {
  summary: string;
  sections: ExplainSection[];
  modules: ExplainModule[];
  diagram: { nodes: ExplainNode[]; edges: ExplainEdge[] };
};

export type CachedExplanation = { head: string; generatedAt: number; explanation: Explanation };

/** `GET /api/cockpit/projects/:name/explain`. */
export type ExplainStatus = {
  head: string | null;
  promptVersion: number;
  estimate: { inputTokens: number; maxOutputTokens: number } | null;
  /** The explanation for this HEAD, when one is stored. */
  cached: CachedExplanation | null;
  /** The newest explanation of an older HEAD or prompt version. */
  staleCached: CachedExplanation | null;
};

/** `POST /api/cockpit/projects/:name/explain` answers 200 with this. */
export type ExplainResult = { head: string; promptVersion: number; cached: boolean; generatedAt: number; explanation: Explanation };
