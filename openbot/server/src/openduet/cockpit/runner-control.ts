import { homedir } from "node:os";
import { type TtlCache, createTtlCache } from "./cache";
import { type CiService, type FsDeps, realFs } from "./ci";
import { type MachineService, runnerProcess } from "./machine";
import { runAllowed } from "./run";

/* Pause and resume one self-hosted runner. Native: launchctl unload/load of its own LaunchAgent (like svc.sh,
 * which is never run). Docker: stop/start of the container whose RUNNER_NAME matches, by its full id. */

const WINDOW_MS = 3_600_000;
const MAX_PER_WINDOW = 30;

export type ControlOutcome =
  | { kind: "ok"; state: "paused" | "running" }
  | { kind: "notfound" }
  | { kind: "busy" }
  | { kind: "locked" }
  | { kind: "rate"; retryAfterSeconds: number }
  | { kind: "failed" };

export type RunnerControl = {
  control(name: string, action: "pause" | "resume", force: boolean): Promise<ControlOutcome>;
};

export type ControlDeps = {
  ci: Pick<CiService, "discover" | "githubBusy">;
  machine: Pick<MachineService, "processes" | "containers">;
  run: (argv: string[]) => Promise<string | null>;
  cache: TtlCache;
  now: () => number;
  home: string;
  fs: FsDeps;
  uid: () => number;
  /** Wait before the caches are dropped: a listener takes a moment to start or exit. */
  settleMs: number;
};

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createRunnerControl(options: Pick<ControlDeps, "ci" | "machine"> & Partial<ControlDeps>): RunnerControl {
  const now = options.now ?? Date.now;
  const run = options.run ?? ((argv: string[]) => runAllowed(argv));
  const cache = options.cache ?? createTtlCache(now);
  const fs = options.fs ?? realFs;
  const home = options.home ?? homedir();
  const uid = options.uid ?? (() => process.getuid?.() ?? -1);
  const settleMs = options.settleMs ?? 1500;
  const { ci, machine } = options;
  const started: number[] = [];
  let locked = false;

  /** The runner's LaunchAgent plist, only when `.service` names exactly this runner's file and it is ours. */
  async function trustedPlist(text: string | null, agentName: string): Promise<string | null> {
    if (!text) return null;
    try {
      const realHome = await fs.realpath(home);
      const shape = new RegExp(`^${escapeRe(realHome)}/Library/LaunchAgents/actions\\.runner\\.[\\w.-]+\\.${escapeRe(agentName)}\\.plist$`);
      if (!shape.test(text) || text.split("/").includes("..")) return null;
      const info = await fs.lstat(text);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid()) return null;
      return (await fs.realpath(text)) === text ? text : null;
    } catch {
      return null;
    }
  }

  return {
    async control(name, action, force) {
      if (locked) return { kind: "locked" };
      locked = true;
      try {
        const native = (await ci.discover()).find((r) => r.agentName === name);
        const container = native ? undefined : await machine.containers(true).then((s) => (s.running ? s.containers.find((c) => c.runnerName === name) : undefined));
        if (!native && !container) return { kind: "notfound" };

        if (action === "pause" && !force) {
          const procs = native ? await machine.processes(true) : null;
          const working = native && procs ? (runnerProcess(procs, native.dir)?.working ?? false) : false;
          if (working || (await ci.githubBusy(native?.repo ?? null, name))) return { kind: "busy" };
        }

        let argv: string[] | null;
        if (native) {
          const plist = await trustedPlist(native.servicePlist, native.agentName);
          argv = plist ? (action === "pause" ? ["launchctl", "unload", plist] : ["launchctl", "load", "-w", plist]) : null;
        } else {
          argv = ["docker", action === "pause" ? "stop" : "start", container!.id];
        }
        if (!argv) return { kind: "failed" };

        const t = now();
        while (started.length && t - started[0]! >= WINDOW_MS) started.shift();
        if (started.length >= MAX_PER_WINDOW) {
          return { kind: "rate", retryAfterSeconds: Math.max(1, Math.ceil((started[0]! + WINDOW_MS - t) / 1000)) };
        }
        started.push(t);

        const ok = (await run(argv)) !== null;
        if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
        cache.invalidate("machine:");
        cache.invalidate("ci:");
        return ok ? { kind: "ok", state: action === "pause" ? "paused" : "running" } : { kind: "failed" };
      } finally {
        locked = false;
      }
    },
  };
}
