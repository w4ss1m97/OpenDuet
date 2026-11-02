import { describe, expect, test } from "bun:test";
import { createTtlCache } from "../src/openduet/cockpit/cache";
import {
  buildContainers,
  createMachineService,
  parseDockerDf,
  parseDockerInfo,
  parseDockerStats,
  parseInspect,
  parseMemLevel,
  parsePs,
  runnerProcess,
  treeUsage,
} from "../src/openduet/cockpit/machine";
import { INSPECT_TEMPLATE } from "../src/openduet/cockpit/run";

const PS = [
  "  714   679  10   0.0  14000 /Users/me/actions-runner/bin/Runner.Listener",
  "  900   714  10  50.5  51200 /Users/me/actions-runner/bin/Runner.Worker",
  "  901   900   0  10.2  10240 /usr/bin/node",
  " 1262  2111   0   0.0  76336 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)",
  "garbage line",
  "  716     1  -5   1.0   2048 /Users/me/actions-runner-barber/bin/Runner.Listener",
].join("\n");

const ID1 = "a".repeat(64);
const ID2 = "b".repeat(64);
const ID3 = "c".repeat(64);

describe("ps parsing", () => {
  test("a comm with spaces and parentheses is one field; junk lines are dropped", () => {
    const procs = parsePs(PS);
    expect(procs.size).toBe(5);
    expect(procs.get(1262)).toMatchObject({ ppid: 2111, nice: 0, cpu: 0, comm: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)" });
    expect(procs.get(716)).toMatchObject({ nice: -5, cpu: 1 });
    expect(procs.get(714)!.rssMB).toBeCloseTo(14000 / 1024, 5);
  });
  test("empty or broken output is an empty table", () => {
    expect(parsePs("").size).toBe(0);
    expect(parsePs("1 2 3").size).toBe(0);
  });
  test("the tree sum adds the listener and every descendant, rounded", () => {
    const procs = parsePs(PS);
    expect(treeUsage(procs, 714)).toEqual({ cpu: 61, ramMB: Math.round((14000 + 51200 + 10240) / 1024) });
    expect(treeUsage(procs, 716)).toEqual({ cpu: 1, ramMB: 2 });
    expect(treeUsage(procs, 99999)).toEqual({ cpu: 0, ramMB: 0 });
  });
  test("a loop of parents does not hang the tree walk", () => {
    const procs = parsePs("1 2 0 1.0 1024 /a\n2 1 0 1.0 1024 /b");
    expect(treeUsage(procs, 1)).toEqual({ cpu: 2, ramMB: 2 });
  });
});

describe("runner process match", () => {
  const procs = parsePs(PS);
  test("the listener is the row whose comm is exactly <dir>/bin/Runner.Listener; a Worker child means working", () => {
    expect(runnerProcess(procs, "/Users/me/actions-runner")).toMatchObject({ listener: 714, working: true, nice: 10, cpuPercent: 61 });
    const idle = runnerProcess(procs, "/Users/me/actions-runner-barber");
    expect(idle).toMatchObject({ listener: 716, working: false, nice: -5 });
  });
  test("a paused runner has no listener; a longer folder name or a prefix does not match", () => {
    expect(runnerProcess(procs, "/Users/me/actions-runner-2")).toBeNull();
    expect(runnerProcess(procs, "/Users/me/actions-runner-bar")).toBeNull();
    expect(runnerProcess(procs, "/Users/me/actions")).toBeNull();
  });
  test("a Worker that is not the listener's child does not make it working", () => {
    const other = parsePs("10 1 0 0 1024 /d/bin/Runner.Listener\n11 5 0 0 1024 /d/bin/Runner.Worker");
    expect(runnerProcess(other, "/d")!.working).toBe(false);
  });
});

describe("memory level", () => {
  test("0-100 is the free percentage; anything else is null", () => {
    expect(parseMemLevel("55\n")).toBe(55);
    expect(parseMemLevel("0")).toBe(0);
    expect(parseMemLevel("100")).toBe(100);
    for (const junk of ["", "abc", "101", "-1", "55%", "5 5", "NaN", null]) expect(parseMemLevel(junk)).toBeNull();
  });
});

describe("docker parsing", () => {
  test("info: cpus and memory", () => {
    expect(parseDockerInfo("8|8210000000\n")).toEqual({ cpus: 8, memGB: 7.6 });
    expect(parseDockerInfo("garbage")).toBeNull();
    expect(parseDockerInfo("8|x")).toBeNull();
    expect(parseDockerInfo(null)).toBeNull();
  });
  test("stats: by full id, cpu and used memory only", () => {
    const stats = parseDockerStats(`${ID1}|0.05%|120.5MiB / 7.6GiB\n${ID2}|--|-- / --\nbad|1%|2MiB / 3GiB\n`);
    expect(stats.get(ID1)).toEqual({ cpu: "0.05%", mem: "120.5MiB" });
    expect(stats.get(ID2)).toEqual({ cpu: "–", mem: "–" });
    expect(stats.size).toBe(2);
  });
  test("df: size and the reclaimable amount without its percentage", () => {
    const disk = parseDockerDf("Images|3.2GB|1.1GB (34%)\nBuild Cache|500MB|500MB\nContainers|1MB|0B (0%)\nbroken\n");
    expect(disk).toEqual({
      Images: { size: "3.2GB", reclaimable: "1.1GB" },
      "Build Cache": { size: "500MB", reclaimable: "500MB" },
      Containers: { size: "1MB", reclaimable: "0B" },
    });
  });
  test("inspect: id, name without the slash, status, RUNNER_NAME only", () => {
    const rows = parseInspect(`${ID1}|/rentab-runner|running|RUNNER_NAME=rentab-docker\n${ID2}|/postgres|exited|\n`);
    expect(rows).toEqual([
      { id: ID1, name: "rentab-runner", status: "running", runnerName: "rentab-docker" },
      { id: ID2, name: "postgres", status: "exited", runnerName: null },
    ]);
  });
  test("inspect: a fourth field that is not RUNNER_NAME is never kept (POSTGRES_PASSWORD fixture)", () => {
    const rows = parseInspect(`${ID1}|/db|running|POSTGRES_PASSWORD=hunter2\n${ID2}|/db2|running|RUNNER_NAME=a|b=hunter3\n`);
    expect(JSON.stringify(rows)).not.toContain("hunter");
    expect(rows[0]!.runnerName).toBeNull();
    expect(rows[1]!.runnerName).toBeNull();
  });
  test("inspect: bad ids, names and statuses drop the row", () => {
    expect(parseInspect("short|/x|running|\n")).toEqual([]);
    expect(parseInspect(`${ID1}|/bad name|running|\n`)).toEqual([]);
    expect(parseInspect(`${ID1}|/ok|weird status|\n`)).toEqual([]);
    expect(parseInspect(`${ID1}|/ok|running|RUNNER_NAME=bad name\n`)[0]!.runnerName).toBeNull();
  });
  test("containers: a stopped container without RUNNER_NAME is dropped; a paused runner is kept", () => {
    const inspected = parseInspect(
      [
        `${ID1}|/runner-a|running|RUNNER_NAME=ra`,
        `${ID2}|/runner-b|exited|RUNNER_NAME=rb`,
        `${ID3}|/old-db|exited|`,
        `${"d".repeat(64)}|/web|running|`,
      ].join("\n"),
    );
    const stats = parseDockerStats(`${ID1}|2.5%|300MiB / 4GiB\n${"d".repeat(64)}|0.1%|20MiB / 4GiB`);
    const out = buildContainers(inspected, stats);
    expect(out.map((c) => c.name)).toEqual(["runner-a", "runner-b", "web"]);
    expect(out[0]).toMatchObject({ id: ID1, runnerName: "ra", status: "running", cpu: "2.5%", mem: "300MiB", paused: false });
    expect(out[1]).toMatchObject({ runnerName: "rb", status: "exited", cpu: "–", mem: "–", paused: true });
  });
});

describe("machine service", () => {
  const GB = 2 ** 30;
  const baseOs = { cores: () => 8, loadavg: () => [2, 1.5, 1], totalmem: () => 16 * GB };
  const statfs = async () => ({ bavail: 100 * GB, bsize: 1, blocks: 500 * GB });
  const dockerOut = (argv: string[]): string | null => {
    const key = argv.slice(0, 3).join(" ");
    if (argv[0] === "docker" && argv[1] === "info") return "4|8589934592\n";
    if (argv[0] === "docker" && argv[1] === "ps") return `${ID1}\n${ID3}\n`;
    if (argv[0] === "docker" && argv[1] === "inspect") return `${ID1}|/runner-a|running|RUNNER_NAME=ra\n${ID3}|/old|exited|POSTGRES_PASSWORD=hunter2\n`;
    if (argv[0] === "docker" && argv[1] === "stats") return `${ID1}|1.0%|100MiB / 4GiB\n`;
    if (argv[0] === "docker" && argv[1] === "system") return "Images|3GB|1GB (33%)\n";
    return key === "sysctl -n kern.memorystatus_level" ? "42\n" : null;
  };
  const make = (over: Record<string, unknown> = {}) => {
    const calls: string[][] = [];
    const service = createMachineService({
      run: async (argv) => {
        calls.push(argv);
        return dockerOut(argv);
      },
      os: baseOs,
      statfs,
      cache: createTtlCache(() => 0),
      ...over,
    });
    return { service, calls };
  };

  test("facts: os numbers, statfs disk, sysctl free percentage, thresholds", async () => {
    const { service } = make();
    const facts = await service.facts();
    expect(facts).toMatchObject({
      cores: 8, load: [2, 1.5, 1], memTotalGB: 16, memFreePercent: 42, diskFreeGB: 100, diskTotalGB: 500,
      thresholds: { loadPerCoreWarn: 1.0, ramFreeWarnPercent: 20, diskFreeWarnGB: 50 },
    });
    expect(facts.docker).toMatchObject({ running: true, cpus: 4, memGB: 8 });
  });
  test("docker: only runner containers or running ones; no id in the answer; no secret", async () => {
    const { service } = make();
    const facts = await service.facts();
    const text = JSON.stringify(facts);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain(ID1);
    expect(text).not.toContain('"name":"old"');
    expect(facts.docker).toMatchObject({ containers: [{ name: "runner-a", runnerName: "ra", status: "running", cpu: "1.0%", mem: "100MiB", paused: false }] });
  });
  test("a sysctl answer that is junk gives a null free percentage", async () => {
    const { service } = make({ run: async () => "banana" });
    expect((await service.facts()).memFreePercent).toBeNull();
  });
  test("docker not running when info fails", async () => {
    const { service } = make({ run: async (argv: string[]) => (argv[0] === "docker" ? null : "50") });
    expect((await service.facts()).docker).toEqual({ running: false });
  });
  test("docker system df never blocks the answer and shows up on a later read", async () => {
    let release: (v: string | null) => void = () => {};
    const slow = new Promise<string | null>((r) => (release = r));
    const { service } = make({
      run: async (argv: string[]) => (argv[0] === "docker" && argv[1] === "system" ? slow : dockerOut(argv)),
      cache: createTtlCache(() => 0),
    });
    const first = await service.facts();
    expect(first.docker).toMatchObject({ running: true, disk: {} });
    release("Images|3GB|1GB (33%)\n");
    await Bun.sleep(10);
    const second = await service.facts();
    expect(second.docker).toMatchObject({ disk: { Images: { size: "3GB", reclaimable: "1GB" } } });
  });
  test("probes are cached: a second read spawns nothing new", async () => {
    const { service, calls } = make();
    await service.facts();
    const n = calls.length;
    await service.facts();
    expect(calls.length).toBe(n);
  });
  test("containers(fresh) goes around the cache and keeps the full id for the control code", async () => {
    const { service, calls } = make();
    await service.facts();
    const n = calls.length;
    const state = await service.containers(true);
    expect(calls.length).toBeGreaterThan(n);
    expect(state).toMatchObject({ running: true, containers: [{ id: ID1, runnerName: "ra" }] });
  });
  test("the inspect call uses the fixed template and full ids only", async () => {
    const { service, calls } = make();
    await service.facts();
    const inspect = calls.find((c) => c[1] === "inspect")!;
    expect(inspect.slice(0, 4)).toEqual(["docker", "inspect", "--format", INSPECT_TEMPLATE]);
    expect(inspect.slice(4)).toEqual([ID1, ID3]);
  });
  test("disk-low attention appears under the threshold and not above it", async () => {
    const low = make({ statfs: async () => ({ bavail: 10 * GB, bsize: 1, blocks: 500 * GB }) });
    expect(await low.service.attention()).toEqual([
      { project: "Machine", severity: "high", message: expect.stringContaining("10 GB"), link: null },
    ]);
    expect(await make().service.attention()).toEqual([]);
  });
  test("a failing statfs does not break the answer", async () => {
    const { service } = make({ statfs: async () => { throw new Error("no"); } });
    const facts = await service.facts();
    expect(facts.diskFreeGB).toBe(0);
    expect(await service.attention()).toEqual([]);
  });
});
