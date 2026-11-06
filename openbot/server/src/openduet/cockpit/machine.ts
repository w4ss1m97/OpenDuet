import { cpus, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { type Background, type TtlCache, createBackground, createTtlCache } from "./cache";
import { INSPECT_TEMPLATE, runAllowed } from "./run";
import type { AttentionItem } from "./types";

/* This Mac's load, memory and disk, the Docker VM, and the process table the CI page matches runners against. */

export const MACHINE_THRESHOLDS = { loadPerCoreWarn: 1.0, ramFreeWarnPercent: 20, diskFreeWarnGB: 50 } as const;

const BASE_TTL_MS = 10_000;
const PS_TTL_MS = 10_000;
const DOCKER_TTL_MS = 30_000;
const DF_TTL_MS = 300_000;
const GB = 2 ** 30;
const MAX_CONTAINERS = 100;
const DASH = "–";
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const STATUSES = new Set(["created", "running", "paused", "restarting", "removing", "exited", "dead"]);
const round1 = (n: number) => Math.round(n * 10) / 10;

export type ProcRow = { pid: number; ppid: number; nice: number; cpu: number; rssMB: number; comm: string };

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S.*?)\s*$/;

/** `ps -axo pid=,ppid=,nice=,%cpu=,rss=,comm=`; comm is the rest of the line, so a path with spaces stays whole. */
export function parsePs(out: string | null): Map<number, ProcRow> {
  const procs = new Map<number, ProcRow>();
  for (const line of (out ?? "").split("\n")) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    procs.set(pid, { pid, ppid: Number(m[2]), nice: Number(m[3]), cpu: Number(m[4]), rssMB: Number(m[5]) / 1024, comm: m[6]! });
  }
  return procs;
}

/** CPU % and RAM (MB) of a process and all of its descendants. */
export function treeUsage(procs: Map<number, ProcRow>, root: number): { cpu: number; ramMB: number } {
  const children = new Map<number, number[]>();
  for (const p of procs.values()) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  let cpu = 0;
  let rss = 0;
  const seen = new Set<number>();
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = procs.get(pid);
    if (row) {
      cpu += row.cpu;
      rss += row.rssMB;
    }
    stack.push(...(children.get(pid) ?? []));
  }
  return { cpu: Math.round(cpu), ramMB: Math.round(rss) };
}

export type RunnerProcess = { listener: number; working: boolean; nice: number; cpuPercent: number; ramMB: number };

/**
 * The runner started from `dir`: the row whose comm is exactly `<dir>/bin/Runner.Listener`. It is working when
 * a child of it is a Runner.Worker. Null when no listener runs (the runner is paused or stopped).
 */
export function runnerProcess(procs: Map<number, ProcRow>, dir: string): RunnerProcess | null {
  const wanted = `${dir}/bin/Runner.Listener`;
  const listener = [...procs.values()].find((p) => p.comm === wanted);
  if (!listener) return null;
  const working = [...procs.values()].some((p) => p.ppid === listener.pid && p.comm.endsWith("/bin/Runner.Worker"));
  const { cpu, ramMB } = treeUsage(procs, listener.pid);
  return { listener: listener.pid, working, nice: listener.nice, cpuPercent: cpu, ramMB };
}

/** `kern.memorystatus_level` is the free memory percentage; anything but an integer 0-100 is unknown. */
export function parseMemLevel(out: string | null): number | null {
  const text = (out ?? "").trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n <= 100 ? n : null;
}

export function parseDockerInfo(out: string | null): { cpus: number; memGB: number } | null {
  const m = /^(\d+)\|(\d+)$/.exec((out ?? "").trim());
  return m ? { cpus: Number(m[1]), memGB: round1(Number(m[2]) / GB) } : null;
}

/** Full container id -> CPU and used memory as docker prints them (a dash when it prints none). */
export function parseDockerStats(out: string | null): Map<string, { cpu: string; mem: string }> {
  const stats = new Map<string, { cpu: string; mem: string }>();
  for (const line of (out ?? "").split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length !== 3 || !CONTAINER_ID.test(parts[0]!)) continue;
    const mem = parts[2]!.split(" / ")[0]!.trim();
    stats.set(parts[0]!, {
      cpu: /^\d+(?:\.\d+)?%$/.test(parts[1]!) ? parts[1]! : DASH,
      mem: /^[\d.]+\s?[A-Za-z]+$/.test(mem) ? mem : DASH,
    });
  }
  return stats;
}

export type DiskUse = Record<string, { size: string; reclaimable: string }>;

/** `docker system df` rows by type; the reclaimable amount keeps its number and unit but not its percentage. */
export function parseDockerDf(out: string | null): DiskUse {
  const disk: DiskUse = {};
  for (const line of (out ?? "").split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length !== 3 || !/^[A-Za-z ]{1,30}$/.test(parts[0]!)) continue;
    const size = parts[1]!.trim();
    const reclaimable = parts[2]!.trim().split(" ")[0]!;
    const amount = /^[\d.]+[A-Za-z]*$/;
    disk[parts[0]!] = { size: amount.test(size) ? size : DASH, reclaimable: amount.test(reclaimable) ? reclaimable : DASH };
  }
  return disk;
}

export type Inspected = { id: string; name: string; status: string; runnerName: string | null };

/**
 * The lines of `docker inspect --format INSPECT_TEMPLATE`. The fourth field is kept only when it is a
 * `RUNNER_NAME=<name>` entry, so nothing else of a container's environment can get through.
 */
export function parseInspect(out: string | null): Inspected[] {
  const rows: Inspected[] = [];
  for (const line of (out ?? "").split("\n")) {
    const [id, rawName, status, ...env] = line.trim().split("|");
    const name = (rawName ?? "").replace(/^\//, "");
    if (!id || !CONTAINER_ID.test(id) || !/^[\w.-]{1,128}$/.test(name) || !status || !STATUSES.has(status)) continue;
    const runner = /^RUNNER_NAME=([\w.-]{1,64})$/.exec(env.join("|"));
    rows.push({ id, name, status, runnerName: runner?.[1] ?? null });
  }
  return rows;
}

/** A container the cockpit shows. `id` is for the control code only and never leaves the server. */
export type DockerContainer = {
  id: string;
  name: string;
  runnerName: string | null;
  status: string;
  cpu: string;
  mem: string;
  paused: boolean;
};

/** Running containers and runner containers (paused ones stay visible); other stopped ones are dropped. */
export function buildContainers(inspected: Inspected[], stats: Map<string, { cpu: string; mem: string }>): DockerContainer[] {
  return inspected
    .filter((c) => c.status === "running" || c.runnerName !== null)
    .map((c) => ({
      id: c.id,
      name: c.name,
      runnerName: c.runnerName,
      status: c.status,
      cpu: stats.get(c.id)?.cpu ?? DASH,
      mem: stats.get(c.id)?.mem ?? DASH,
      paused: c.status !== "running",
    }));
}

export type PublicContainer = Omit<DockerContainer, "id">;
export const publicContainer = ({ id: _id, ...rest }: DockerContainer): PublicContainer => rest;

export type DockerState = { running: false } | { running: true; cpus: number; memGB: number; containers: DockerContainer[] };

export type DockerFacts =
  | { running: false }
  | { running: true; cpus: number; memGB: number; containers: PublicContainer[]; disk: DiskUse };

/** `GET /api/cockpit/machine`. */
export type MachineFacts = {
  cores: number;
  load: number[];
  memTotalGB: number;
  memFreePercent: number | null;
  diskFreeGB: number;
  diskTotalGB: number;
  thresholds: typeof MACHINE_THRESHOLDS;
  docker: DockerFacts | null;
};

export type MachineDeps = {
  run: (argv: string[]) => Promise<string | null>;
  cache: TtlCache;
  now: () => number;
  os: { cores: () => number; loadavg: () => number[]; totalmem: () => number };
  statfs: (path: string) => Promise<{ bavail: number; bsize: number; blocks: number }>;
};

export type MachineService = {
  facts(): Promise<MachineFacts>;
  /** The process table; `fresh` skips the 10 s cache (the pause check wants the truth). */
  processes(fresh?: boolean): Promise<Map<number, ProcRow> | null>;
  /** Docker's containers, with full ids; `fresh` skips the 30 s cache. */
  containers(fresh?: boolean): Promise<DockerState>;
  attention(): Promise<AttentionItem[]>;
};

type Base = { cores: number; load: number[]; memTotalGB: number; memFreePercent: number | null; diskFreeGB: number; diskTotalGB: number; diskKnown: boolean };

const PS_ARGV = ["ps", "-axo", "pid=,ppid=,nice=,%cpu=,rss=,comm="];

/** The machine probes; every one is a fixed program through run.ts or an `os`/statfs read, cached for its TTL. */
export function createMachineService(options: Partial<MachineDeps> = {}): MachineService {
  const now = options.now ?? Date.now;
  const run = options.run ?? ((argv: string[]) => runAllowed(argv));
  const cache = options.cache ?? createTtlCache(now);
  const os = options.os ?? { cores: () => cpus().length || 1, loadavg, totalmem };
  const disk = options.statfs ?? ((path: string) => statfs(path));

  const base = async (): Promise<Base> =>
    (await cache.cached<Base>("machine:base", BASE_TTL_MS, async () => {
      const [level, space] = await Promise.all([
        run(["sysctl", "-n", "kern.memorystatus_level"]),
        disk("/").then((s) => ({ free: Math.round((s.bavail * s.bsize) / GB), total: Math.round((s.blocks * s.bsize) / GB), known: true }), () => ({ free: 0, total: 0, known: false })),
      ]);
      const [one = 0, five = 0, fifteen = 0] = os.loadavg();
      return {
        cores: os.cores(), load: [one, five, fifteen], memTotalGB: round1(os.totalmem() / GB), memFreePercent: parseMemLevel(level),
        diskFreeGB: space.free, diskTotalGB: space.total, diskKnown: space.known,
      };
    })) ?? { cores: 1, load: [0, 0, 0], memTotalGB: 0, memFreePercent: null, diskFreeGB: 0, diskTotalGB: 0, diskKnown: false };

  const dockerNow = async (): Promise<DockerState> => {
    const info = parseDockerInfo(await run(["docker", "info", "--format", "{{.NCPU}}|{{.MemTotal}}"]));
    if (!info) return { running: false };
    const ids = ((await run(["docker", "ps", "-aq", "--no-trunc"])) ?? "").split(/\s+/).filter((id) => CONTAINER_ID.test(id)).slice(0, MAX_CONTAINERS);
    if (ids.length === 0) return { running: true, ...info, containers: [] };
    const [inspected, stats] = await Promise.all([
      run(["docker", "inspect", "--format", INSPECT_TEMPLATE, ...ids]),
      run(["docker", "stats", "--no-stream", "--no-trunc", "--format", "{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}"]),
    ]);
    return { running: true, ...info, containers: buildContainers(parseInspect(inspected), parseDockerStats(stats)) };
  };

  const df: Background<DiskUse> = createBackground(
    DF_TTL_MS,
    async () => {
      const found = parseDockerDf(await run(["docker", "system", "df", "--format", "{{.Type}}|{{.Size}}|{{.Reclaimable}}"]));
      return Object.keys(found).length ? found : null;
    },
    now,
  );

  const containers = async (fresh = false): Promise<DockerState> =>
    fresh ? dockerNow() : ((await cache.cached("machine:docker", DOCKER_TTL_MS, dockerNow)) ?? { running: false });

  return {
    async facts() {
      const [b, docker] = await Promise.all([base(), containers()]);
      const { diskKnown: _known, ...numbers } = b;
      return {
        ...numbers,
        thresholds: MACHINE_THRESHOLDS,
        docker: docker.running
          ? { running: true, cpus: docker.cpus, memGB: docker.memGB, containers: docker.containers.map(publicContainer), disk: df.get() ?? {} }
          : { running: false },
      };
    },
    async processes(fresh = false) {
      const read = async () => {
        const out = await run(PS_ARGV);
        return out === null ? null : parsePs(out);
      };
      return fresh ? read() : cache.cached("machine:ps", PS_TTL_MS, read);
    },
    containers,
    async attention() {
      const b = await base();
      if (!b.diskKnown || b.diskFreeGB >= MACHINE_THRESHOLDS.diskFreeWarnGB) return [];
      return [{ project: "Machine", severity: "high", message: `Disk low: ${b.diskFreeGB} GB free (alert under ${MACHINE_THRESHOLDS.diskFreeWarnGB} GB)`, link: null }];
    },
  };
}
