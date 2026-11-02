/*
 * The only way the cockpit runs a program: a short list of read-only tools (git, gh, sysctl, ps, launchctl,
 * du, docker) plus the runner pause/resume calls, each as an argv array (no shell), with a fixed
 * environment, a timeout, and a cap on what it may print. Anything else is refused before it spawns.
 */

/** The slice of a Bun subprocess the runner needs, so tests can inject a fake. */
export type SpawnedProcess = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string | number): void;
};

export type Spawn = (argv: string[], options: { env: Record<string, string> }) => SpawnedProcess;

export type RunDeps = { spawn?: Spawn; timeoutMs?: number; maxStdoutBytes?: number };

/** Every git call starts with these: no index locks, no fsmonitor or hooks from the repo, no transports. */
export const GIT_FLAGS = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.allow=never",
] as const;

const GIT_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 25_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const PS_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDOUT_CEILING = 8 * 1024 * 1024;
const SLUG_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `owner/repo`; a part made only of dots or starting with a dash is not a GitHub name. */
export const isSlug = (slug: string) =>
  SLUG_SHAPE.test(slug) && slug.split("/").every((part) => !/^\.+$/.test(part) && !part.startsWith("-"));

const realSpawn: Spawn = (argv, { env }) =>
  Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });

/** The PATH of the server, plus the two folders docker and gh live in (Duet.app started from Finder lacks them). */
function fixedPath(): string {
  const parts = (process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin").split(":");
  for (const extra of ["/usr/local/bin", "/opt/homebrew/bin"]) if (!parts.includes(extra)) parts.push(extra);
  return parts.join(":");
}

function fixedEnv(): Record<string, string> {
  return {
    PATH: fixedPath(),
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
    LC_ALL: "C",
  };
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const OID = /^[0-9a-f]{40}$/;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** A ref or branch name made of plain characters: never starts with a dash, no `..`. */
const isRefName = (name: string) => /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith("-") && !name.includes("..");

/** The exact git subcommand shapes the cockpit makes (args after `-C <dir>`). */
function gitArgsAllowed(a: string[]): boolean {
  const [cmd, ...rest] = a;
  switch (cmd) {
    case "symbolic-ref":
      return same(rest, ["--short", "refs/remotes/origin/HEAD"]);
    case "rev-parse":
      return (
        same(rest, ["--git-dir"]) ||
        same(rest, ["--abbrev-ref", "HEAD"]) ||
        same(rest, ["--abbrev-ref", "@{u}"]) ||
        (rest.length === 3 && rest[0] === "--verify" && rest[1] === "-q" &&
          (rest[2]!.startsWith("refs/remotes/origin/") || rest[2]!.startsWith("refs/heads/")) && isRefName(rest[2]!))
      );
    case "status":
      return same(rest, ["--porcelain=v1", "-z", "--untracked-files=normal"]);
    case "worktree":
      return same(rest, ["list", "--porcelain"]);
    case "remote":
      return same(rest, ["get-url", "origin"]);
    case "rev-list": {
      if (same(rest, ["--count", "HEAD..@{u}"]) || same(rest, ["--count", "HEAD", "--not", "--remotes"])) return true;
      if (rest.length === 2 && rest[0] === "--count") {
        const parts = rest[1]!.split("..");
        return parts.length === 2 && parts.every((p) => p !== "" && isRefName(p));
      }
      return false;
    }
    case "log":
      return (
        same(rest, ["-15", "--format=%H%x1f%ct%x1f%an%x1f%s"]) ||
        same(rest, ["-8", "--format=%ct%x1f%h%x1f%s", "--", ".claude/session-notes.md"])
      );
    case "ls-tree":
      return same(rest, ["-r", "-l", "-z", "--full-tree", "HEAD"]);
    case "cat-file":
      return rest.length === 2 && rest[0] === "blob" && OID.test(rest[1]!);
    case "diff":
      return same(rest, ["--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", EMPTY_TREE, "HEAD"]);
    case "for-each-ref":
      return same(rest, [
        "--sort=-creatordate", "--count=30", "--format=%(refname:short)%09%(creatordate:unix)%09%(objectname)", "refs/tags",
      ]);
    default:
      return false;
  }
}

/** What `docker inspect` prints per container: the id, name, state and only the RUNNER_NAME entry of the environment. */
export const INSPECT_TEMPLATE =
  '{{.Id}}|{{.Name}}|{{.State.Status}}|{{range .Config.Env}}{{if eq (index (split . "=") 0) "RUNNER_NAME"}}{{.}}{{end}}{{end}}';

const RUNS_API = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/\d{1,20}\/jobs\?per_page=50$/;
const RUNNERS_API = /^repos\/([^/]+\/[^/]+)\/actions\/runners\?per_page=100$/;
const WORK_DIR = /^\/(?:[^/\0]+\/)+actions-runner[\w.-]*\/_work$/;
const RUNNER_PLIST = /^\/Users\/[^/]+\/Library\/LaunchAgents\/actions\.runner\.[\w.-]+\.plist$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const PS_ARGS = ["-axo", "pid=,ppid=,nice=,%cpu=,rss=,comm="];

const noDotDot = (path: string) => !path.split("/").includes("..");

function dockerAllowed(a: string[]): boolean {
  const [cmd, ...rest] = a;
  switch (cmd) {
    case "info":
      return same(rest, ["--format", "{{.NCPU}}|{{.MemTotal}}"]);
    case "ps":
      return same(rest, ["-aq", "--no-trunc"]);
    case "stats":
      return same(rest, ["--no-stream", "--no-trunc", "--format", "{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}"]);
    case "system":
      return same(rest, ["df", "--format", "{{.Type}}|{{.Size}}|{{.Reclaimable}}"]);
    case "inspect": {
      const ids = rest.slice(2);
      return rest[0] === "--format" && rest[1] === INSPECT_TEMPLATE && ids.length >= 1 && ids.length <= 100 && ids.every((id) => CONTAINER_ID.test(id));
    }
    case "stop":
    case "start":
      return rest.length === 1 && CONTAINER_ID.test(rest[0]!);
    default:
      return false;
  }
}

/** Whether argv is a call the cockpit is allowed to make; the check runs before anything spawns. */
function allowed(argv: string[]): boolean {
  if (argv.some((part) => typeof part !== "string" || part.includes("\0"))) return false;
  if (argv[0] === "git") {
    const flags = argv.slice(1, 1 + GIT_FLAGS.length);
    const dir = argv[1 + GIT_FLAGS.length + 1];
    return (
      flags.length === GIT_FLAGS.length &&
      flags.every((flag, i) => flag === GIT_FLAGS[i]) &&
      argv[1 + GIT_FLAGS.length] === "-C" &&
      typeof dir === "string" &&
      dir.startsWith("/") &&
      gitArgsAllowed(argv.slice(1 + GIT_FLAGS.length + 2))
    );
  }
  if (argv[0] === "gh") {
    if (argv[1] === "pr" && argv[2] === "list" && argv[3] === "--repo") {
      return isSlug(argv[4] ?? "");
    }
    if (argv[1] === "api" && argv.length === 3) {
      const api = argv[2] ?? "";
      if (RUNNERS_API.test(api) || RUNS_API.test(api)) return isSlug((RUNNERS_API.exec(api) ?? RUNS_API.exec(api))![1]!);
      const match = /^repos\/([^/]+\/[^/]+)\/(?:actions\/runs|releases)\?per_page=(\d+)$/.exec(argv[2] ?? "");
      if (match === null || !isSlug(match[1]!)) return false;
      return argv[2]!.includes("/actions/runs?") ? match[2] === "30" : match[2] === "20";
    }
    return false;
  }
  switch (argv[0]) {
    case "sysctl":
      return same(argv.slice(1), ["-n", "kern.memorystatus_level"]);
    case "ps":
      return same(argv.slice(1), PS_ARGS);
    case "launchctl": {
      const rest = argv.slice(1);
      if (same(rest, ["list"])) return true;
      const plist = rest[0] === "unload" && rest.length === 2 ? rest[1] : rest[0] === "load" && rest[1] === "-w" && rest.length === 3 ? rest[2] : undefined;
      return plist !== undefined && RUNNER_PLIST.test(plist) && noDotDot(plist);
    }
    case "du":
      return argv.length === 3 && argv[1] === "-sk" && WORK_DIR.test(argv[2]!) && noDotDot(argv[2]!);
    case "docker":
      return dockerAllowed(argv.slice(1));
    default:
      return false;
  }
}

/** How long each tool may run before it is killed. */
export function timeoutFor(argv: string[]): number {
  switch (argv[0]) {
    case "gh":
      return GH_TIMEOUT_MS;
    case "sysctl":
      return 3_000;
    case "ps":
      return 5_000;
    case "launchctl":
      return argv[1] === "list" ? 5_000 : 40_000;
    case "du":
      return 60_000;
    case "docker":
      return argv[1] === "stats" ? 20_000 : argv[1] === "system" ? 30_000 : argv[1] === "stop" || argv[1] === "start" ? 60_000 : 10_000;
    default:
      return GIT_TIMEOUT_MS;
  }
}

/** Reads at most `limit` bytes; null when the stream says more. */
async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) return null;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Runs an allowed argv; stdout on a clean exit, null for anything else (refused, failed, timed out, too big). */
export async function runAllowed(argv: string[], deps: RunDeps = {}): Promise<string | null> {
  if (!allowed(argv)) return null;
  const timeoutMs = deps.timeoutMs ?? timeoutFor(argv);
  const requested = deps.maxStdoutBytes;
  const limit = Number.isFinite(requested) && requested! > 0
      ? Math.min(requested!, MAX_STDOUT_CEILING)
      : argv[0] === "ps" ? PS_MAX_STDOUT_BYTES : MAX_STDOUT_BYTES;
  let proc: SpawnedProcess;
  try {
    proc = (deps.spawn ?? realSpawn)(argv, { env: fixedEnv() });
  } catch {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
  });
  try {
    const out = await Promise.race([readCapped(proc.stdout, limit), timeout]);
    if (out === null) {
      // Too much output, or out of time: make sure the process is gone.
      proc.kill("SIGKILL");
      return null;
    }
    const code = await proc.exited;
    return timedOut || code !== 0 ? null : out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** `git <guard flags> -C path …args`; path must be absolute. */
export function runGit(path: string, args: string[], deps: RunDeps = {}): Promise<string | null> {
  return runAllowed(["git", ...GIT_FLAGS, "-C", path, ...args], deps);
}

/** `gh …args`, only the two shapes {@link runAllowed} lets through. */
export function runGh(args: string[], deps: RunDeps = {}): Promise<string | null> {
  return runAllowed(["gh", ...args], deps);
}
