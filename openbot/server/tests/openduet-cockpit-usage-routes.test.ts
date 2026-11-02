import { afterAll, describe, expect, test } from "bun:test";
import { type CockpitService, createCockpitService } from "../src/openduet/cockpit/collect";
import { createCockpitApp, startCockpitServer } from "../src/openduet/cockpit/server";
import { DEFAULT_CONFIG } from "../src/openduet/cockpit/usage-prices";
import { createUsageService } from "../src/openduet/cockpit/usage-service";
import type { UsageIngest } from "../src/openduet/cockpit/usage-ingest";
import type { UsageConfig, UsageStatus } from "../src/openduet/cockpit/usage-types";
import { HOME, PROJECTS, config, row, storeWith } from "./support/usage-fixture";

const PORT = 3002;
const LOCAL = { ip: { address: "127.0.0.1" } };
const NOW = Date.parse("2026-10-30T12:00:00Z");
const idle: UsageStatus = { backfilling: false, filesDone: 0, filesTotal: 0, skippedLines: 0, lastError: null };

const store = storeWith(
  [
    row({ model: "opus-4-5", input: 1_000_000, output: 4000, requests: 50 }),
    row({ session: "s2", day: "2026-10-27", model: "sonnet-4-5", input: 1_000_000, requests: 1 }),
  ],
  [["s1", "-Users-me-alpha", "/Users/me/alpha", "=cmd"], ["s2", "-Users-me-alpha", "/Users/me/alpha", "Plain"]],
);
const stubIngest = (status: UsageStatus = idle, runs: { n: number } = { n: 0 }): UsageIngest => ({
  ready: async () => undefined,
  runOnce: () => {
    runs.n += 1;
    return new Promise<void>(() => undefined); // a backfill that never ends
  },
  store: () => store,
  status: () => status,
});
const make = (over: { config?: UsageConfig; configError?: string | null; ingest?: UsageIngest } = {}) =>
  createUsageService({
    ingest: over.ingest ?? stubIngest(),
    config: { get: async () => ({ config: over.config ?? DEFAULT_CONFIG, error: over.configError ?? null }) },
    listProjects: async () => PROJECTS,
    tz: "Europe/Paris",
    now: () => NOW,
    home: HOME,
  });
const projectsService: CockpitService = { snapshot: async () => ({ projects: [], attention: [], names: [], generatedAt: 1 }), project: async () => null };
const appWith = (usage = make()) => createCockpitApp({ getPort: () => PORT, origins: new Set(), service: projectsService, usage });
const get = (app: ReturnType<typeof appWith>, path: string, method = "GET") =>
  app.request(`http://127.0.0.1:${PORT}${path}`, { method, headers: { Host: `127.0.0.1:${PORT}` } }, LOCAL);

describe("usage routes", () => {
  test("GET /usage answers the summary with status and configError, even while a backfill is pending", async () => {
    const pending: UsageStatus = { backfilling: true, filesDone: 3, filesTotal: 40, skippedLines: 2, lastError: null };
    const runs = { n: 0 };
    const res = await get(appWith(make({ ingest: stubIngest(pending, runs) })), "/api/cockpit/usage?from=2026-10-01&to=2026-10-30");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["burnPerHour", "configError", "days", "firstDay", "flags", "from", "hours", "sessionDays", "sessions", "status", "to", "unknownModels"]);
    expect(body.status).toEqual(pending);
    expect(body.configError).toBeNull();
    expect(body.days).toHaveLength(2);
    expect(runs.n).toBe(0); // a GET never starts or waits for a pass
  });

  test("the default range is the last 30 days; a config error is passed on", async () => {
    const res = await get(appWith(make({ configError: "usage-config.json is not valid JSON" })), "/api/cockpit/usage");
    const body = await res.json();
    expect(body).toMatchObject({ from: "2026-10-01", to: "2026-10-30", configError: "usage-config.json is not valid JSON" });
  });

  test("a bad date, a reversed range or a span over 400 days is 400", async () => {
    for (const query of ["from=nope", "to=2026-13-40", "from=2026-10-02&to=2026-10-01", "from=2025-01-01&to=2026-10-30", "from=", "from=2026-10-01&from=2026-10-02x"]) {
      const res = await get(appWith(), `/api/cockpit/usage?${query}`);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
  });

  test("a session answers its detail; an unknown or odd id is 404", async () => {
    const app = appWith();
    const res = await get(app, "/api/cockpit/usage/sessions/s1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "s1", name: "=cmd", project: "Alpha" });
    expect((await get(app, "/api/cockpit/usage/sessions/nope")).status).toBe(404);
    expect((await get(app, "/api/cockpit/usage/sessions/..%2Fx")).status).toBe(404);
  });

  test("budgets: the week start, the statuses and the threshold", async () => {
    const withBudget = config({ budgets: [{ scope: "overall", unit: "usd", limit: 100 }] });
    const body = await (await get(appWith(make({ config: withBudget })), "/api/cockpit/usage/budgets")).json();
    expect(body.weekStart).toBe("2026-10-26");
    expect(body.budgetPercent).toBe(80);
    expect(body.configError).toBeNull();
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0]).toMatchObject({ scope: "overall", unit: "usd", limit: 100 });
    expect(body.budgets[0].used).toBeGreaterThan(0);
  });

  test("advisor: tips and the total saving", async () => {
    const body = await (await get(appWith(), "/api/cockpit/usage/advisor")).json();
    expect(body.configError).toBeNull();
    expect(body.tips[0]).toMatchObject({ kind: "opus-short", key: "opus-short:s1" });
    expect(typeof body.totalSaving).toBe("number");
  });

  test("anything but GET is 405", async () => {
    for (const path of ["/api/cockpit/usage", "/api/cockpit/usage/budgets", "/api/cockpit/usage/export.csv?view=days"]) {
      const res = await get(appWith(), path, "POST");
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
  });

  test("the csv is an attachment with safe headers", async () => {
    const res = await get(appWith(), "/api/cockpit/usage/export.csv?view=days&from=2026-10-01&to=2026-10-30");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="duet-usage-days-2026-10-01-2026-10-30.csv"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.text()).startsWith('"day","project","model","agent"')).toBe(true);
  });

  test("the csv is sanitized and its view and range are checked", async () => {
    const app = appWith();
    expect(await (await get(app, "/api/cockpit/usage/export.csv?view=sessions")).text()).toContain(`"'=cmd"`);
    expect((await get(app, "/api/cockpit/usage/export.csv?view=evil")).status).toBe(400);
    expect((await get(app, "/api/cockpit/usage/export.csv")).status).toBe(400);
    expect((await get(app, "/api/cockpit/usage/export.csv?view=days&from=bad")).status).toBe(400);
  });

  test("without a usage service the usage routes are 404", async () => {
    const app = createCockpitApp({ getPort: () => PORT, origins: new Set(), service: projectsService });
    expect((await get(app, "/api/cockpit/usage")).status).toBe(404);
  });
});

describe("usage in the projects snapshot", () => {
  const spend = storeWith([row({ day: "2026-10-27", input: 5_000_000, requests: 1 })], [["s1", "-Users-me-alpha", "/Users/me/alpha"]]);
  const withIngest = (): UsageIngest => ({ ...stubIngest(), store: () => spend });

  test("a budget at 100% shows up as a high attention item", async () => {
    const usage = make({ ingest: withIngest(), config: config({ budgets: [{ scope: "Alpha", unit: "usd", limit: 15 }, { scope: "overall", unit: "usd", limit: 1000 }] }) });
    const service = createCockpitService({ listProjects: () => [], loadSessionList: () => [], now: () => NOW, extraAttention: () => usage.attention() });
    const { attention } = await service.snapshot();
    expect(attention).toEqual([{ project: "Alpha", severity: "high", message: "Weekly budget at 100%: 15 of 15 $ (API-equivalent)", link: null }]);
  });

  test("extra items are sorted in by severity and a failing source does not break the snapshot", async () => {
    const low = { project: "x", severity: "low" as const, message: "l", link: null };
    const high = { project: "y", severity: "high" as const, message: "h", link: null };
    const ok = createCockpitService({ listProjects: () => [], loadSessionList: () => [], extraAttention: async () => [low, high] });
    expect((await ok.snapshot()).attention.map((i) => i.severity)).toEqual(["high", "low"]);
    const broken = createCockpitService({ listProjects: () => [], loadSessionList: () => [], extraAttention: async () => { throw new Error("boom"); } });
    expect((await broken.snapshot()).attention).toEqual([]);
  });
});

describe("usage poller", () => {
  test("runs at once, then on the interval, and stops", async () => {
    const runs = { n: 0 };
    const ingest: UsageIngest = { ...stubIngest(idle, runs), runOnce: async () => void (runs.n += 1) };
    const usage = createUsageService({ ingest, config: { get: async () => ({ config: DEFAULT_CONFIG, error: null }) }, listProjects: async () => [], intervalMs: 10 });
    const stop = usage.start();
    expect(runs.n).toBe(1);
    await Bun.sleep(60);
    expect(runs.n).toBeGreaterThan(2);
    stop();
    const seen = runs.n;
    await Bun.sleep(40);
    expect(runs.n).toBe(seen);
  });

  test("a failing pass never throws out of the interval", async () => {
    const ingest: UsageIngest = { ...stubIngest(), runOnce: () => Promise.reject(new Error("boom")) };
    const usage = createUsageService({ ingest, config: { get: async () => ({ config: DEFAULT_CONFIG, error: null }) }, listProjects: async () => [], intervalMs: 10 });
    const stop = usage.start();
    await Bun.sleep(30);
    stop();
  });
});

describe("cockpit listener with usage", () => {
  const servers: Array<{ stop(force?: boolean): unknown }> = [];
  afterAll(() => {
    for (const s of servers) s.stop(true);
  });

  test("an injected usage service is served; an injected projects service alone starts no usage", async () => {
    const withUsage = startCockpitServer({ port: 0, origins: new Set(), service: projectsService, usage: make() });
    servers.push(withUsage);
    expect((await fetch(`http://127.0.0.1:${withUsage.port}/api/cockpit/usage/budgets`)).status).toBe(200);
    const without = startCockpitServer({ port: 0, origins: new Set(), service: projectsService });
    servers.push(without);
    expect((await fetch(`http://127.0.0.1:${without.port}/api/cockpit/usage`)).status).toBe(404);
  });
});
