/*
 * Facts about one project, read from its committed HEAD tree only (never the working tree) through
 * the cockpit runner: file counts per language, a shallow tree, manifests, workflows, docs, tags and
 * releases. Files are read only when they are on a short allowlist and not on the never-read list,
 * and one that holds a credential is dropped whole. No model is involved.
 */
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createTtlCache, type TtlCache } from "./cache";
import { parseOrigin } from "./collect";
import { PROJECTS_FILE, loadCockpitProjects } from "./projects-file";
import { type RunDeps, runGh, runGit } from "./run";
import { containsSecret, isNeverRead } from "./secrets";
import type {
  CockpitProject,
  ExploreDoc,
  ExploreFacts,
  ExploreLanguage,
  ExploreManifest,
  ExploreNode,
  ExploreRelease,
  ExploreTag,
  ExploreWorkflow,
} from "./types";

const MAX_ENTRIES = 50_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const MAX_TREE_NODES = 400;
const MAX_TREE_DEPTH = 3;
const MAX_PATH_CHARS = 200;
const DOC_BYTES = 16 * 1024;
const EXCERPT_CHARS = 16 * 1024;
const MAX_MANIFESTS = 12;
const MAX_WORKFLOWS = 10;
const MAX_DOCS = 20;
const MAX_ENTRY_POINTS = 8;
const MAX_LIST_ITEMS = 30;
const EXPLORE_TTL_MS = 10 * 60 * 1000;

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python", kt: "Kotlin", kts: "Kotlin", java: "Java", swift: "Swift", go: "Go", rs: "Rust",
  rb: "Ruby", php: "PHP", c: "C", h: "C", cpp: "C++", cc: "C++", hpp: "C++", cs: "C#",
  sh: "Shell", bash: "Shell", zsh: "Shell", sql: "SQL", html: "HTML", css: "CSS", scss: "CSS", vue: "Vue", svelte: "Svelte",
};

/** A text the explanation may quote: already checked for credentials. */
export type Excerpt = { path: string; text: string };

/** What exploring produces: the public facts, plus the excerpts only the explanation prompt uses. */
export type ExploreCore = { facts: ExploreFacts; excerpts: Excerpt[] };

type Entry = { path: string; oid: string; size: number };

function parseTree(out: string): { entries: Entry[]; truncated: boolean } {
  const entries: Entry[] = [];
  let truncated = false;
  for (const record of out.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid, size] = record.slice(0, tab).split(/\s+/);
    const path = record.slice(tab + 1);
    // Regular files only: no symlinks (120000) and no submodules (160000).
    if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !oid || path.length > MAX_PATH_CHARS) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({ path, oid, size: Number.parseInt(size ?? "0", 10) || 0 });
  }
  return { entries, truncated };
}

function parseNumstat(out: string): Map<string, number> {
  const lines = new Map<string, number>();
  for (const record of out.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(record);
    if (match && match[1] !== "-") lines.set(match[3]!, Number(match[1]));
  }
  return lines;
}

function buildTree(entries: Entry[]): { tree: ExploreNode[]; truncated: boolean } {
  const nodes = new Map<string, ExploreNode>();
  for (const { path, size } of entries) {
    const parts = path.split("/");
    for (let depth = 1; depth <= Math.min(parts.length, MAX_TREE_DEPTH); depth++) {
      const nodePath = parts.slice(0, depth).join("/");
      const node = nodes.get(nodePath) ?? { path: nodePath, type: depth === parts.length ? "file" : "dir", files: 0, bytes: 0 };
      node.files += 1;
      node.bytes += size;
      nodes.set(nodePath, node);
    }
  }
  const sorted = [...nodes.values()].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return { tree: sorted.slice(0, MAX_TREE_NODES), truncated: sorted.length > MAX_TREE_NODES };
}

const uniqueSorted = (names: Iterable<string>) => [...new Set(names)].sort().slice(0, MAX_LIST_ITEMS);

function parseManifest(path: string, text: string): ExploreManifest | null {
  const base = path.split("/").pop()!;
  const empty = { path, name: null, version: null, dependencies: [] as string[], scripts: [] as string[] };
  if (base === "package.json") {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      const keys = (v: unknown) => (v && typeof v === "object" ? Object.keys(v) : []);
      return {
        ...empty, kind: "npm",
        name: typeof json.name === "string" ? json.name.slice(0, 100) : null,
        version: typeof json.version === "string" ? json.version.slice(0, 40) : null,
        dependencies: uniqueSorted([...keys(json.dependencies), ...keys(json.devDependencies), ...keys(json.peerDependencies)]),
        scripts: uniqueSorted(keys(json.scripts)),
      };
    } catch {
      return { ...empty, kind: "npm" };
    }
  }
  if (base === "pyproject.toml") {
    const section = /\[project\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
    const list = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(section)?.[1] ?? "";
    const deps = [...list.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)].map((m) => m[1]!);
    return {
      ...empty, kind: "python",
      name: /^name\s*=\s*["']([^"']+)["']/m.exec(section)?.[1] ?? null,
      version: /^version\s*=\s*["']([^"']+)["']/m.exec(section)?.[1] ?? null,
      dependencies: uniqueSorted(deps),
    };
  }
  if (/^requirements.*\.txt$/.test(base)) {
    const deps = text.split("\n").map((l) => /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l.trim())?.[1]).filter((d): d is string => !!d);
    return { ...empty, kind: "python", dependencies: uniqueSorted(deps) };
  }
  if (base === "Cargo.toml") {
    let section = "";
    let name: string | null = null;
    let version: string | null = null;
    const deps: string[] = [];
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      const head = /^\[([^\]]+)\]$/.exec(line);
      if (head) {
        section = head[1]!;
        const dep = /^(?:dev-|build-)?dependencies\.(.+)$/.exec(section);
        if (dep) deps.push(dep[1]!);
        continue;
      }
      const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
      if (!kv) continue;
      if (section === "package" && kv[1] === "name") name = /"([^"]+)"/.exec(kv[2]!)?.[1] ?? null;
      else if (section === "package" && kv[1] === "version") version = /"([^"]+)"/.exec(kv[2]!)?.[1] ?? null;
      else if (/^(?:dev-|build-)?dependencies$/.test(section)) deps.push(kv[1]!);
    }
    return { ...empty, kind: "rust", name, version, dependencies: uniqueSorted(deps) };
  }
  if (base === "go.mod") {
    const deps: string[] = [];
    let inBlock = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (/^require\s*\($/.test(line)) inBlock = true;
      else if (inBlock && line === ")") inBlock = false;
      else if (inBlock) {
        const m = /^(\S+)\s+v/.exec(line);
        if (m) deps.push(m[1]!);
      } else {
        const m = /^require\s+(\S+)\s+v/.exec(line);
        if (m) deps.push(m[1]!);
      }
    }
    return { ...empty, kind: "go", name: /^module\s+(\S+)/m.exec(text)?.[1] ?? null, dependencies: uniqueSorted(deps) };
  }
  if (/^(?:build|settings)\.gradle(?:\.kts)?$/.test(base)) {
    const deps = [...text.matchAll(/\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*["']([^"':]+:[^"':]+)/g)].map((m) => m[1]!);
    return { ...empty, kind: "gradle", dependencies: uniqueSorted(deps) };
  }
  if (base === "libs.versions.toml") return { ...empty, kind: "gradle" };
  return null;
}

function parseWorkflow(path: string, text: string): ExploreWorkflow | null {
  try {
    const doc = parseYaml(text, { maxAliasCount: 10 }) as Record<string, unknown> | null;
    if (!doc || typeof doc !== "object") return null;
    const on = doc.on ?? (doc as Record<string, unknown>)[String(true)];
    const triggers = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === "object" ? Object.keys(on) : [];
    const jobs = doc.jobs && typeof doc.jobs === "object" ? Object.keys(doc.jobs) : [];
    return {
      path,
      name: typeof doc.name === "string" ? doc.name.slice(0, 100) : path.split("/").pop()!,
      triggers: uniqueSorted(triggers),
      jobs: uniqueSorted(jobs),
    };
  } catch {
    return null;
  }
}

const tagLine = z.tuple([z.string().min(1), z.coerce.number(), z.string().regex(/^[0-9a-f]{40}$/)]);
function parseTags(out: string): ExploreTag[] {
  return out.split("\n").flatMap((line) => {
    const parsed = tagLine.safeParse(line.split("\t"));
    return parsed.success ? [{ name: parsed.data[0].slice(0, 100), t: parsed.data[1], sha: parsed.data[2] }] : [];
  });
}

const releaseList = z.array(
  z.object({
    tag_name: z.string(),
    name: z.string().nullish(),
    published_at: z.string().nullish(),
    html_url: z.string().startsWith("https://"),
    prerelease: z.boolean().default(false),
  }),
);
function parseReleases(out: string | null): ExploreRelease[] | null {
  if (out === null) return null;
  try {
    const parsed = releaseList.safeParse(JSON.parse(out));
    if (!parsed.success) return null;
    return parsed.data.map((r) => ({
      tag: r.tag_name.slice(0, 100),
      name: (r.name || r.tag_name).slice(0, 200),
      t: r.published_at ? Date.parse(r.published_at) / 1000 || 0 : 0,
      url: r.html_url,
      prerelease: r.prerelease,
    }));
  } catch {
    return null;
  }
}

const README = /^readme(?:\.[a-z0-9]+)?$/i;
const ROOT_DOCS = new Set(["CLAUDE.md", "AGENTS.md"]);
const MANIFEST_NAMES = /^(?:package\.json|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|libs\.versions\.toml)$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const DOC = /^docs\/.+\.md$/i;
const ENTRY = /^(?:src\/)?(?:index|main|app|server)\.(?:ts|tsx|js|py|kt)$/;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function emptyFacts(now: number, head: string | null, truncated = false): ExploreFacts {
  return {
    head, generatedAt: now, files: 0, bytes: 0, truncated, languages: [], tree: [], treeTruncated: false,
    manifests: [], workflows: [], docs: [], entryPoints: [], tags: [], releases: null,
  };
}

/**
 * Facts for the repository at `root`; null when it is not a git repository. A git answer that fails
 * or is too big leaves its part empty (and sets `truncated` for the tree), never an error.
 */
export async function exploreProject(
  root: string,
  options: { run?: RunDeps; now?: () => number } = {},
): Promise<ExploreCore | null> {
  const now = options.now ?? Date.now;
  const git = (args: string[], maxStdoutBytes?: number) => runGit(root, args, { ...options.run, maxStdoutBytes });
  if ((await git(["rev-parse", "--git-dir"])) === null) return null;

  // The first line of the log is HEAD's commit; an empty repository has none.
  const logged = await git(["log", "-15", "--format=%H%x1f%ct%x1f%an%x1f%s"]);
  const head = /^[0-9a-f]{40}/.exec(logged ?? "")?.[0] ?? null;
  if (head === null) return { facts: emptyFacts(now(), null), excerpts: [] };

  const origin = ((await git(["remote", "get-url", "origin"])) ?? "").trim();
  const repo = parseOrigin(origin);
  const [treeOut, numstat, tagsOut, releasesOut] = await Promise.all([
    git(["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"], MAX_LIST_BYTES),
    git(["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "HEAD"], MAX_LIST_BYTES),
    git(["for-each-ref", "--sort=-creatordate", "--count=30", "--format=%(refname:short)%09%(creatordate:unix)%09%(objectname)", "refs/tags"]),
    repo ? runGh(["api", `repos/${repo}/releases?per_page=20`], options.run) : Promise.resolve(null),
  ]);

  const parsedTree = treeOut === null ? { entries: [], truncated: true } : parseTree(treeOut);
  const entries = parsedTree.entries.filter((e) => !isNeverRead(e.path));
  const lineCounts = numstat === null ? new Map<string, number>() : parseNumstat(numstat);

  const byLanguage = new Map<string, ExploreLanguage>();
  for (const e of entries) {
    const ext = e.path.split("/").pop()!.split(".").pop()!.toLowerCase();
    const name = e.path.includes(".") ? LANGUAGES[ext] : undefined;
    if (!name) continue;
    const row = byLanguage.get(name) ?? { name, files: 0, bytes: 0, lines: 0 };
    row.files += 1;
    row.bytes += e.size;
    row.lines += lineCounts.get(e.path) ?? 0;
    byLanguage.set(name, row);
  }
  const { tree, truncated: treeTruncated } = buildTree(entries);

  // Pick what to read: allowlist only, small files only.
  const readable = entries.filter((e) => e.size <= MAX_FILE_BYTES).sort((a, b) => cmp(a.path, b.path));
  const wanted = {
    readme: readable.filter((e) => !e.path.includes("/") && README.test(e.path)).slice(0, 1),
    agents: readable.filter((e) => ROOT_DOCS.has(e.path)),
    manifests: readable.filter((e) => e.path.split("/").length <= MAX_TREE_DEPTH && MANIFEST_NAMES.test(e.path.split("/").pop()!)).slice(0, MAX_MANIFESTS),
    workflows: readable.filter((e) => WORKFLOW.test(e.path)).slice(0, MAX_WORKFLOWS),
    docs: readable.filter((e) => DOC.test(e.path)).slice(0, MAX_DOCS),
    entries: readable.filter((e) => ENTRY.test(e.path)).slice(0, MAX_ENTRY_POINTS),
  };
  const texts = new Map<string, string>();
  const toRead = [...new Set(Object.values(wanted).flat())];
  for (let i = 0; i < toRead.length; i += 8) {
    await Promise.all(
      toRead.slice(i, i + 8).map(async (e) => {
        const text = await git(["cat-file", "blob", e.oid], MAX_FILE_BYTES + 1024);
        if (text === null || text.includes("\0") || containsSecret(text)) return;
        texts.set(e.path, text);
      }),
    );
  }
  const have = (list: Entry[]) => list.filter((e) => texts.has(e.path));

  const manifests = have(wanted.manifests).flatMap((e) => parseManifest(e.path, texts.get(e.path)!) ?? []);
  const workflows = have(wanted.workflows).flatMap((e) => parseWorkflow(e.path, texts.get(e.path)!) ?? []);
  const docs: ExploreDoc[] = have(wanted.docs).map((e) => ({
    path: e.path,
    title: /^#{1,6}\s+(.+?)\s*#*$/m.exec(texts.get(e.path)!.slice(0, DOC_BYTES))?.[1]?.slice(0, 200) ?? null,
    bytes: e.size,
  }));
  const excerpts: Excerpt[] = [...wanted.readme, ...wanted.agents, ...wanted.manifests, ...wanted.entries, ...wanted.docs]
    .filter((e) => texts.has(e.path))
    .map((e) => ({ path: e.path, text: texts.get(e.path)!.slice(0, e.path.startsWith("docs/") ? DOC_BYTES : EXCERPT_CHARS) }));

  return {
    facts: {
      head,
      generatedAt: now(),
      files: entries.length,
      bytes: entries.reduce((sum, e) => sum + e.size, 0),
      truncated: parsedTree.truncated || numstat === null,
      languages: [...byLanguage.values()].sort((a, b) => b.bytes - a.bytes || cmp(a.name, b.name)),
      tree,
      treeTruncated,
      manifests,
      workflows,
      docs,
      entryPoints: have(wanted.entries).map((e) => e.path),
      tags: tagsOut === null ? [] : parseTags(tagsOut),
      releases: parseReleases(releasesOut),
    },
    excerpts,
  };
}

/** A project's facts plus where it lives (the explanation cache is keyed by the real path). */
export type ExploreResult = ExploreCore & { name: string; root: string };

export type ExploreService = { explore(name: string): Promise<ExploreResult | null> };

/** Looks a project up in the cockpit list and explores it, keeping the answer for ten minutes. */
export function createExploreService(
  options: {
    listProjects?: () => CockpitProject[];
    home?: string;
    now?: () => number;
    cache?: TtlCache;
    run?: RunDeps;
  } = {},
): ExploreService {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now;
  const cache = options.cache ?? createTtlCache(now);
  const list = options.listProjects ?? (() => loadCockpitProjects({ file: PROJECTS_FILE, home }));
  return {
    async explore(name) {
      const project = list().find((p) => p.name === name);
      if (!project) return null;
      const core = await cache.cached(`explore:${project.name}:${project.path}`, EXPLORE_TTL_MS, () =>
        exploreProject(project.path, { run: options.run, now }),
      );
      return core ? { ...core, name: project.name, root: project.path } : null;
    },
  };
}
