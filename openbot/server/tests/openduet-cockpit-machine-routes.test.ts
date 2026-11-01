import { describe, expect, test } from "bun:test";
import { createTtlCache } from "../src/openduet/cockpit/cache";
import { type CockpitService, createCockpitService } from "../src/openduet/cockpit/collect";
import { createMachineService } from "../src/openduet/cockpit/machine";
import { cockpitExtraAttention, createCockpitApp } from "../src/openduet/cockpit/server";

const PORT = 3002;
const LOCAL = { ip: { address: "127.0.0.1" } };
const GB = 2 ** 30;
const service: CockpitService = { snapshot: async () => ({ projects: [], attention: [], names: [], generatedAt: 1 }), project: async () => null };

const machineWith = (freeGB: number) =>
  createMachineService({
    run: async () => null,
    cache: createTtlCache(() => 0),
    os: { cores: () => 4, loadavg: () => [1, 1, 1], totalmem: () => 8 * GB },
    statfs: async () => ({ bavail: freeGB * GB, bsize: 1, blocks: 500 * GB }),
  });

describe("GET /api/cockpit/machine", () => {
  const app = createCockpitApp({ getPort: () => PORT, origins: new Set(), service, machine: machineWith(200) });
  const call = (path: string, host = `127.0.0.1:${PORT}`) => app.request(`http://127.0.0.1:${PORT}${path}`, { headers: { Host: host } }, LOCAL as object);
  test("200 with the gauges, thresholds and docker", async () => {
    const res = await call("/api/cockpit/machine");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      cores: 4, load: [1, 1, 1], memTotalGB: 8, memFreePercent: null, diskFreeGB: 200, diskTotalGB: 500,
      thresholds: { loadPerCoreWarn: 1, ramFreeWarnPercent: 20, diskFreeWarnGB: 50 }, docker: { running: false },
    });
  });
  test("a LAN Host is 403", async () => {
    expect((await call("/api/cockpit/machine", "192.168.1.5:3002")).status).toBe(403);
  });
  test("without a machine service it is 404", async () => {
    const bare = createCockpitApp({ getPort: () => PORT, origins: new Set(), service });
    expect((await bare.request(`http://127.0.0.1:${PORT}/api/cockpit/machine`, { headers: { Host: `127.0.0.1:${PORT}` } }, LOCAL as object)).status).toBe(404);
  });
});

describe("disk-low attention", () => {
  const snapshotWith = async (freeGB: number) => {
    const machine = machineWith(freeGB);
    const projects = createCockpitService({
      listProjects: () => [], loadSessionList: () => [],
      extraAttention: cockpitExtraAttention(undefined, machine),
    });
    return (await projects.snapshot()).attention;
  };
  test("appears in the projects attention list under 50 GB, high severity", async () => {
    expect(await snapshotWith(10)).toEqual([{ project: "Machine", severity: "high", message: expect.stringContaining("10 GB"), link: null }]);
  });
  test("absent above it", async () => {
    expect(await snapshotWith(80)).toEqual([]);
  });
  test("a failing usage source does not hide it", async () => {
    const machine = machineWith(10);
    const extra = cockpitExtraAttention({ attention: async () => { throw new Error("x"); } } as never, machine);
    expect(await extra()).toHaveLength(1);
  });
});
