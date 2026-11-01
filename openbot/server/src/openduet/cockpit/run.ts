/*
 * The only way the cockpit runs a program: `git` and `gh`, as an argv array (no shell), with a fixed
 * environment, a timeout, and a cap on what it may print. Anything else is refused before it spawns.
 */

/** The slice of a Bun subprocess the runner needs, so tests can inject a fake. */
export type SpawnedProcess = {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string | number): void;
};

export type Spawn = (argv: string[], options: { env: Record<string, string> }) => SpawnedProcess;

export type RunDeps = { spawn?: Spawn; timeoutMs?: number };

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
const SLUG_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `owner/repo`; a part made only of dots or starting with a dash is not a GitHub name. */
const isSlug = (slug: string) =>
  SLUG_SHAPE.test(slug) && slug.split("/").every((part) => !/^\.+$/.test(part) && !part.startsWith("-"));

const realSpawn: Spawn = (argv, { env }) =>
  Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });

function fixedEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
    HOME: process.env.HOME ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
    LC_ALL: "C",
  };
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
      argv.length > 1 + GIT_FLAGS.length + 2
    );
  }
  if (argv[0] === "gh") {
    if (argv[1] === "pr" && argv[2] === "list" && argv[3] === "--repo") {
      return isSlug(argv[4] ?? "");
    }
    if (argv[1] === "api" && argv.length === 3) {
      const match = /^repos\/([^/]+\/[^/]+)\/actions\/runs\?per_page=30$/.exec(argv[2] ?? "");
      return match !== null && isSlug(match[1]!);
    }
  }
  return false;
}

/** Reads at most MAX_STDOUT_BYTES; null when the stream says more. */
async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_STDOUT_BYTES) return null;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Runs an allowed argv; stdout on a clean exit, null for anything else (refused, failed, timed out, too big). */
export async function runAllowed(argv: string[], deps: RunDeps = {}): Promise<string | null> {
  if (!allowed(argv)) return null;
  const timeoutMs = deps.timeoutMs ?? (argv[0] === "gh" ? GH_TIMEOUT_MS : GIT_TIMEOUT_MS);
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
    const out = await Promise.race([readCapped(proc.stdout), timeout]);
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
