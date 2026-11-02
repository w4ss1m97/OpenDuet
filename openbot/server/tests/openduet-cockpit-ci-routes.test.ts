import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTtlCache } from "../src/openduet/cockpit/cache";
import { type CiDeps, createCiService, realFs } from "../src/openduet/cockpit/ci";
import { type DockerState, parsePs } from "../src/openduet/cockpit/machine";
import { createRunnerControl } from "../src/openduet/cockpit/runner-control";
import { createCockpitApp } from "../src/openduet/cockpit/server";
import type { CockpitService } from "../src/openduet/cockpit/collect";

const PORT = 3002;
const ORIGIN = "http://localhost:3010";
const ORIGINS = new Set([ORIGIN, "tauri://localhost"]);
const LOCAL = { ip: { address: "127.0.0.1" } };
const ID = "a".repeat(64);
const service: CockpitService = { snapshot: async () => ({ projects: [], attention: [], names: [], generatedAt: 1 }), project: async () => null };

let home: string;
let plist: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "ci-routes-")));
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  plist = join(home, "Library", "LaunchAgents", "actions.runner.o-r.runner-1.plist");
  writeFileSync(plist, "<plist/>");
  const dir = join(home, "actions-runner");
  mkdirSync(dir);
  writeFileSync(join(dir, ".runner"), JSON.stringify({ agentName: "runner-1", gitHubUrl: "https://github.com/o/r" }));
  writeFileSync(join(dir, ".service"), `${plist}\n`);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Opts = {
  busyOnGithub?: boolean;
  worker?: boolean;
  docker?: DockerState;
  uid?: number;
  now?: () => number;
  runResult?: string | null;
  slow?: Promise<void>;
};

function build(o: Opts = {}) {
  const spawned: string[][] = [];
  const cache = createTtlCache(() => 0);
  const ps = `714 1 0 0 1024 ${home}/actions-runner/bin/Runner.Listener\n${o.worker ? `900 714 0 0 1024 ${home}/actions-runner/bin/Runner.Worker\n` : ""}`;
  const machine = {
    processes: async () => parsePs(ps),
    containers: async (): Promise<DockerState> => o.docker ?? { running: false },
  };
  const ci = createCiService({
    home, cache, machine, projectRepos: async () => [{ name: "P", repo: "o/r" }],
    gh: async (args) =>
      (args[1] ?? "").includes("/actions/runners")
        ? JSON.stringify({ runners: [{ name: "runner-1", status: "online", busy: o.busyOnGithub ?? false, os: "macOS", labels: [] }] })
        : JSON.stringify({ workflow_runs: [] }),
    run: async () => null,
  });
  let ghInvalidated = 0;
  const control = createRunnerControl({
    ci, machine, cache: { ...cache, invalidate: (p) => { ghInvalidated++; cache.invalidate(p); } },
    home, fs: realFs, uid: () => o.uid ?? process.getuid!(), now: o.now ?? (() => 0), settleMs: 0,
    run: async (argv) => {
      spawned.push(argv);
      await o.slow;
      return o.runResult === undefined ? "" : o.runResult;
    },
  });
  const app = createCockpitApp({ getPort: () => PORT, origins: ORIGINS, service, ci, control, now: o.now });
  const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    app.request(`http://127.0.0.1:${PORT}${path}`, { method: init.method ?? "GET", headers: { Host: `127.0.0.1:${PORT}`, ...init.headers } }, LOCAL as object);
  const post = (path: string, headers: Record<string, string> = { Origin: ORIGIN }) => call(path, { method: "POST", headers });
  return { call, post, spawned, invalidated: () => ghInvalidated };
}

describe("GET /api/cockpit/ci", () => {
  test("200 with repos, local, containers and generatedAt; no store", async () => {
    const { call } = build();
    const res = await call("/api/cockpit/ci");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["containers", "generatedAt", "local", "repos"]);
    expect(body.repos[0].repo).toBe("o/r");
    expect(body.local[0]).toMatchObject({ name: "runner-1", dir: "~/actions-runner", paused: false });
  });
  test("a LAN Host is 403", async () => {
    const { call } = build();
    expect((await call("/api/cockpit/ci", { headers: { Host: "192.168.1.5:3002" } })).status).toBe(403);
  });
  test("without a ci service the route is 404", async () => {
    const app = createCockpitApp({ getPort: () => PORT, origins: ORIGINS, service });
    const res = await app.request(`http://127.0.0.1:${PORT}/api/cockpit/ci`, { headers: { Host: `127.0.0.1:${PORT}` } }, LOCAL as object);
    expect(res.status).toBe(404);
  });
});

const PAUSE = "/api/cockpit/runners/runner-1/pause";
const RESUME = "/api/cockpit/runners/runner-1/resume";

describe("POST pause/resume: the guard", () => {
  test("no Origin or a foreign one is 403 without ACAO, nothing spawned", async () => {
    const b = build();
    for (const headers of [{}, { Origin: "https://evil.example" }]) {
      const res = await b.post(PAUSE, headers);
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(b.spawned).toEqual([]);
  });
  test("the desktop shell's origin is allowed", async () => {
    const b = build();
    expect((await b.post(PAUSE, { Origin: "tauri://localhost" })).status).toBe(200);
  });
  test("a body is 400", async () => {
    const b = build();
    expect((await b.post(PAUSE, { Origin: ORIGIN, "Content-Length": "2" })).status).toBe(400);
    expect((await b.post(PAUSE, { Origin: ORIGIN, "Transfer-Encoding": "chunked" })).status).toBe(400);
    expect(b.spawned).toEqual([]);
  });
  test("only ?force=1 once is accepted as a query", async () => {
    const b = build();
    for (const q of ["?force=yes", "?force=1&force=1", "?force=", "?x=1", "?force=1&x=1", "?force=true"]) {
      expect((await b.post(PAUSE + q)).status).toBe(400);
    }
    expect(b.spawned).toEqual([]);
    expect((await b.post(PAUSE + "?force=1")).status).toBe(200);
  });
  test("OPTIONS and other methods are 405; other paths under runners are 404 or 405", async () => {
    const b = build();
    expect((await b.call(PAUSE, { method: "OPTIONS", headers: { Origin: ORIGIN } })).status).toBe(405);
    expect((await b.call(PAUSE, { method: "PUT", headers: { Origin: ORIGIN } })).status).toBe(405);
    expect((await b.call(PAUSE)).status).toBe(404);
    expect((await b.post("/api/cockpit/runners/runner-1/stop")).status).toBe(405);
    expect((await b.post("/api/cockpit/ci")).status).toBe(405);
  });
  test("an unknown runner (or a name with odd characters) is 404, nothing spawned", async () => {
    const b = build();
    expect((await b.post("/api/cockpit/runners/nope/pause")).status).toBe(404);
    expect((await b.post("/api/cockpit/runners/..%2Fx/pause")).status).toBe(404);
    expect((await b.post("/api/cockpit/runners/a%20b/pause")).status).toBe(404);
    expect(b.spawned).toEqual([]);
  });
});

describe("pause and resume a native runner", () => {
  test("pause = launchctl unload <plist>; resume = launchctl load -w <plist>; 200 with the state", async () => {
    const b = build();
    const res = await b.post(PAUSE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "paused" });
    expect(b.spawned).toEqual([["launchctl", "unload", plist]]);
    const again = await b.post(RESUME);
    expect(await again.json()).toEqual({ state: "running" });
    expect(b.spawned[1]).toEqual(["launchctl", "load", "-w", plist]);
  });
  test("it never runs svc.sh", async () => {
    const b = build();
    await b.post(PAUSE);
    await b.post(RESUME);
    expect(b.spawned.flat().some((a) => a.includes("svc.sh"))).toBe(false);
  });
  test("busy on GitHub is 409 without force, 200 with force", async () => {
    const b = build({ busyOnGithub: true });
    expect((await b.post(PAUSE)).status).toBe(409);
    expect(b.spawned).toEqual([]);
    expect((await b.post(PAUSE + "?force=1")).status).toBe(200);
    expect(b.spawned).toHaveLength(1);
  });
  test("a local Worker child is 409 without force; resume is never blocked", async () => {
    const b = build({ worker: true });
    expect((await b.post(PAUSE)).status).toBe(409);
    expect((await b.post(RESUME)).status).toBe(200);
  });
  test("caches of machine and ci are dropped afterwards", async () => {
    const b = build();
    await b.post(PAUSE);
    expect(b.invalidated()).toBeGreaterThanOrEqual(2);
  });
  test("a launchctl failure is 502", async () => {
    const b = build({ runResult: null });
    expect((await b.post(PAUSE)).status).toBe(502);
  });
});

describe("the .service file is distrusted", () => {
  const withService = (text: string) => writeFileSync(join(home, "actions-runner", ".service"), text);
  test("a plist outside LaunchAgents, with a wrong name or with .. is 502 and nothing spawns", async () => {
    for (const text of [
      "/etc/evil.plist",
      `${home}/Library/LaunchAgents/com.evil.plist`,
      `${home}/Library/LaunchAgents/actions.runner.o-r.other-runner.plist`,
      `${home}/Library/LaunchAgents/../LaunchAgents/actions.runner.o-r.runner-1.plist`,
      `/Library/LaunchAgents/actions.runner.o-r.runner-1.plist`,
      "",
    ]) {
      withService(text);
      const b = build();
      expect((await b.post(PAUSE)).status).toBe(502);
      expect(b.spawned).toEqual([]);
    }
  });
  test("a plist that is a symlink is 502", async () => {
    const target = join(home, "real.plist");
    writeFileSync(target, "x");
    rmSync(plist);
    symlinkSync(target, plist);
    const b = build();
    expect((await b.post(PAUSE)).status).toBe(502);
    expect(b.spawned).toEqual([]);
  });
  test("a plist owned by another user is 502", async () => {
    const b = build({ uid: process.getuid!() + 1 });
    expect((await b.post(PAUSE)).status).toBe(502);
    expect(b.spawned).toEqual([]);
  });
  test("a missing plist is 502", async () => {
    rmSync(plist);
    const b = build();
    expect((await b.post(PAUSE)).status).toBe(502);
    expect(b.spawned).toEqual([]);
  });
  test("a plist reached through a symlinked folder (realpath differs) is 502", async () => {
    const real = join(home, "RealAgents");
    mkdirSync(real);
    writeFileSync(join(real, "actions.runner.o-r.runner-1.plist"), "x");
    rmSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    symlinkSync(real, join(home, "Library", "LaunchAgents"));
    const b = build();
    expect((await b.post(PAUSE)).status).toBe(502);
    expect(b.spawned).toEqual([]);
    chmodSync(real, 0o755);
  });
});

describe("docker runners", () => {
  const docker: DockerState = {
    running: true, cpus: 4, memGB: 8,
    containers: [{ id: ID, name: "rentab-docker", runnerName: "dock-1", status: "running", cpu: "1%", mem: "1MiB", paused: false }],
  };
  test("stop and start address the container by its full id", async () => {
    const b = build({ docker });
    expect((await b.post("/api/cockpit/runners/dock-1/pause?force=1")).status).toBe(200);
    expect((await b.post("/api/cockpit/runners/dock-1/resume")).status).toBe(200);
    expect(b.spawned).toEqual([["docker", "stop", ID], ["docker", "start", ID]]);
  });
  test("busy on GitHub (any repo) blocks a pause without force", async () => {
    const b = build({ docker: { ...docker, containers: [{ ...docker.containers[0]!, runnerName: "runner-1" }] }, busyOnGithub: true });
    // the native runner-1 wins by name, so this checks the busy path through GitHub only
    expect((await b.post(PAUSE)).status).toBe(409);
  });
});

describe("limits", () => {
  test("two concurrent controls spawn once; the other is 429", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const b = build({ slow });
    const first = b.post(PAUSE);
    await Bun.sleep(20);
    const second = await b.post(RESUME);
    expect(second.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect(b.spawned).toHaveLength(1);
  });
  test("the 31st control within an hour is 429 with Retry-After; an hour later it works again", async () => {
    let t = 0;
    const b = build({ now: () => t });
    for (let i = 0; i < 30; i++) expect((await b.post(i % 2 ? RESUME : PAUSE)).status).toBe(200);
    const res = await b.post(PAUSE);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(b.spawned).toHaveLength(30);
    t = 3_600_001;
    expect((await b.post(PAUSE)).status).toBe(200);
  });
});
