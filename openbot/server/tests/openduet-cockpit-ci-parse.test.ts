import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTtlCache } from "../src/openduet/cockpit/cache";
import { type CiDeps, type FsDeps, createCiService, discoverRunners, repoFromUrl } from "../src/openduet/cockpit/ci";
import { parsePs } from "../src/openduet/cockpit/machine";

let home: string;
const ID1 = "a".repeat(64);

function runnerDir(name: string, agent: string, url = "https://github.com/o/r", extra: Record<string, unknown> = {}) {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".runner"), "﻿" + JSON.stringify({ agentName: agent, gitHubUrl: url, serverUrl: "https://pipelines.actions.githubusercontent.com/x", poolName: "Default", workFolder: "_work", ...extra }));
  writeFileSync(join(dir, ".service"), `${home}/Library/LaunchAgents/actions.runner.o-r.${agent}.plist\n`);
  return dir;
}

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "ci-home-")));
  runnerDir("actions-runner", "runner-1");
  runnerDir("actions-runner-2", "runner-2", "https://github.com/o/other.git");
  mkdirSync(join(home, "actions-runner-books"), { recursive: true }); // no .runner
  writeFileSync(join(home, "actions-runner-books", ".env"), "SECRET=1");
  // a bad one: JSON that is not JSON, one too big, one with a bad agent name, one that is a symlink
  mkdirSync(join(home, "actions-runner-bad"), { recursive: true });
  writeFileSync(join(home, "actions-runner-bad", ".runner"), "{not json");
  mkdirSync(join(home, "actions-runner-big"), { recursive: true });
  writeFileSync(join(home, "actions-runner-big", ".runner"), JSON.stringify({ agentName: "big", gitHubUrl: "https://github.com/o/r", pad: "x".repeat(17 * 1024) }));
  runnerDir("actions-runner-name", "bad name; id");
  const elsewhere = join(home, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, ".runner"), JSON.stringify({ agentName: "evil", gitHubUrl: "https://github.com/o/r" }));
  symlinkSync(elsewhere, join(home, "actions-runner-link"));
  // not runner folders at all
  mkdirSync(join(home, "Documents"));
  mkdirSync(join(home, ".ssh"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("repoFromUrl", () => {
  test("github.com slugs only", () => {
    expect(repoFromUrl("https://github.com/o/r")).toBe("o/r");
    expect(repoFromUrl("https://github.com/o/r.git")).toBe("o/r");
    expect(repoFromUrl("https://github.com/o/r/")).toBe("o/r");
    for (const bad of ["https://github.com/o", "https://evil.com/o/r", "http://github.com/o/r", "https://github.com/../r", "https://github.com/o/r/extra", "git@github.com:o/r", ""]) {
      expect(repoFromUrl(bad)).toBeNull();
    }
  });
});

describe("runner discovery", () => {
  test("finds runner folders with a valid .runner (BOM stripped), skips the rest", async () => {
    const found = await discoverRunners(home);
    expect(found.map((r) => r.agentName).sort()).toEqual(["runner-1", "runner-2"]);
    const one = found.find((r) => r.agentName === "runner-1")!;
    expect(one).toMatchObject({ dir: join(home, "actions-runner"), dirShown: "~/actions-runner", repo: "o/r" });
    expect(one.servicePlist).toBe(`${home}/Library/LaunchAgents/actions.runner.o-r.runner-1.plist`);
    expect(found.find((r) => r.agentName === "runner-2")!.repo).toBe("o/other");
  });
  test("home entries that do not match ^actions-runner are never touched; secrets files are never opened", async () => {
    const touched: string[] = [];
    const spy: FsDeps = {
      readdir: (p) => readdir(p),
      realpath: (p) => realpath(p),
      lstat: async (p) => {
        touched.push(p);
        return lstat(p);
      },
      readFile: async (p) => {
        touched.push(p);
        return readFile(p, "utf8");
      },
    };
    await discoverRunners(home, spy);
    expect(touched.length).toBeGreaterThan(0);
    for (const p of touched) {
      const rest = p.slice(home.length + 1);
      expect(rest).toMatch(/^actions-runner[\w.-]*(\/(\.runner|\.service))?$/);
    }
    expect(touched.some((p) => /\.env|\.credentials|\.path|_diag|Documents|\.ssh/.test(p))).toBe(false);
    expect(touched.some((p) => p.endsWith("actions-runner-books/.runner"))).toBe(true);
  });
  test("a .service that is a symlink or too big is ignored (the runner is still listed)", async () => {
    const dir = runnerDir("actions-runner-svc", "svc-runner");
    rmSync(join(dir, ".service"));
    writeFileSync(join(home, "target.txt"), "/Users/x/Library/LaunchAgents/actions.runner.a.b.plist");
    symlinkSync(join(home, "target.txt"), join(dir, ".service"));
    expect((await discoverRunners(home)).find((r) => r.agentName === "svc-runner")!.servicePlist).toBeNull();
    rmSync(join(dir, ".service"));
    writeFileSync(join(dir, ".service"), "x".repeat(2000));
    expect((await discoverRunners(home)).find((r) => r.agentName === "svc-runner")!.servicePlist).toBeNull();
    rmSync(dir, { recursive: true });
  });
  test("an unreadable home gives an empty list", async () => {
    expect(await discoverRunners(join(home, "nope"))).toEqual([]);
  });
});

/** A service whose gh answers from a script, with a fake process table and docker. */
function build(over: Partial<CiDeps> & { ps?: string; gh?: (args: string[]) => Promise<string | null> } = {}) {
  const ghCalls: string[][] = [];
  const runs = (n: number, status: string) =>
    JSON.stringify({ workflow_runs: Array.from({ length: n }, (_, i) => ({ id: 100 + i, name: "CI", head_branch: "main", status, conclusion: status === "completed" ? "success" : null, html_url: "https://github.com/o/r/actions/runs/1", updated_at: "2026-11-01T00:10:00Z", run_started_at: "2026-11-01T00:00:00Z", run_attempt: 2, event: "push" })) });
  const gh =
    over.gh ??
    (async (args: string[]) => {
      ghCalls.push(args);
      const path = args[1] ?? "";
      if (path.includes("/actions/runners")) return JSON.stringify({ runners: [{ name: "runner-1", status: "online", busy: true, os: "macOS", labels: [{ name: "self-hosted" }] }] });
      if (path.includes("/jobs")) return JSON.stringify({ jobs: [{ name: "build", status: "in_progress", runner_name: "runner-1", started_at: "2026-11-01T00:01:00Z" }, { name: "done", status: "completed" }] });
      return runs(2, "in_progress");
    });
  const service = createCiService({
    home,
    cache: createTtlCache(() => 0),
    gh,
    run: async (argv) => {
      return argv[0] === "launchctl" ? `-\t0\tactions.runner.o-r.runner-1\n123\t0\tcom.apple.x\n` : null;
    },
    machine: {
      processes: async () =>
        parsePs(`714 1 10 2.0 2048 ${home}/actions-runner/bin/Runner.Listener\n900 714 10 40.0 4096 ${home}/actions-runner/bin/Runner.Worker\n`),
      containers: async () => ({
        running: true, cpus: 4, memGB: 8,
        containers: [
          { id: ID1, name: "dock-1", runnerName: "runner-d", status: "exited", cpu: "–", mem: "–", paused: true },
          { id: "b".repeat(64), name: "web", runnerName: null, status: "running", cpu: "1%", mem: "5MiB", paused: false },
        ],
      }),
    },
    projectRepos: async () => [{ name: "Proj", repo: "o/r" }, { name: "Same", repo: "O/R" }, { name: "NoRemote", repo: null }],
    ...over,
  });
  return { service, ghCalls };
}

describe("ci service", () => {
  test("repos are the union of project repos and .runner repos, deduplicated", async () => {
    const { service } = build();
    const out = await service.ci();
    expect(out.repos.map((r) => r.repo)).toEqual(["o/r", "o/other"]);
    expect(out.repos[0]!.projects).toEqual(["Proj", "Same"]);
    expect(out.repos[1]!.projects).toEqual([]);
  });
  test("a repo's runners, runs (with started and attempt) and active jobs", async () => {
    const out = await build().service.ci();
    const repo = out.repos[0]!;
    expect(repo.error).toBeNull();
    expect(repo.runners).toEqual([{ name: "runner-1", status: "online", busy: true, os: "macOS", labels: ["self-hosted"] }]);
    expect(repo.runs[0]).toMatchObject({ started: "2026-11-01T00:00:00Z", attempt: 2, status: "in_progress" });
    expect(repo.jobs[0]).toEqual({ name: "build", status: "in_progress", runner: "runner-1", started: "2026-11-01T00:01:00Z", workflow: "CI", branch: "main" });
    expect(repo.jobs.every((j) => j.name !== "done")).toBe(true);
  });
  test("local runners: state from the process table, no pid or absolute path", async () => {
    const out = await build().service.ci();
    const one = out.local.find((r) => r.name === "runner-1")!;
    expect(one).toEqual({ name: "runner-1", dir: "~/actions-runner", repo: "o/r", paused: false, working: true, serviceLoaded: true, nice: 10, cpuPercent: 42, ramMB: 6, workGB: null });
    const two = out.local.find((r) => r.name === "runner-2")!;
    expect(two).toMatchObject({ paused: true, working: false, serviceLoaded: false, nice: null, cpuPercent: 0, ramMB: 0 });
  });
  test("only runner containers are listed, without their id", async () => {
    const out = await build().service.ci();
    expect(out.containers).toEqual([{ name: "dock-1", runnerName: "runner-d", status: "exited", cpu: "–", mem: "–", paused: true }]);
  });
  test("the answer has no home path, no pid, nothing of the .runner file besides the name and repo", async () => {
    const text = JSON.stringify(await build().service.ci());
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain(home);
    expect(text).not.toMatch(/"pid"/);
    for (const secret of ["serverUrl", "pipelines.actions", "poolName", "workFolder", ID1]) expect(text).not.toContain(secret);
  });
  test("jobs are fetched only for queued/in_progress runs, at most 5 per repo and 10 per snapshot", async () => {
    const many = (n: number, status: string) => JSON.stringify({ workflow_runs: Array.from({ length: n }, (_, i) => ({ id: 1000 + i, name: "CI", head_branch: "m", status, conclusion: null, html_url: "https://github.com/o/r/actions/runs/1", updated_at: "2026-11-01T00:10:00Z" })) });
    const calls: string[] = [];
    const { service } = build({
      projectRepos: async () => [{ name: "A", repo: "o/a" }, { name: "B", repo: "o/b" }, { name: "C", repo: "o/c" }, { name: "R", repo: "o/r" }],
      gh: async (args) => {
        const p = args[1]!;
        if (p.includes("/actions/runners")) return JSON.stringify({ runners: [] });
        if (p.includes("/jobs")) {
          calls.push(p);
          return JSON.stringify({ jobs: [] });
        }
        return many(7, p.includes("repos/o/c/") ? "completed" : "queued");
      },
    });
    await service.ci();
    const perRepo = (slug: string) => calls.filter((c) => c.startsWith(`repos/${slug}/`)).length;
    expect(calls.length).toBe(10);
    expect(perRepo("o/a")).toBe(5);
    expect(perRepo("o/b")).toBe(5);
    expect(perRepo("o/c")).toBe(0);
    expect(perRepo("o/r")).toBe(0);
  });
  test("a repo whose runs cannot be read carries an error, the others are unaffected", async () => {
    const { service } = build({
      gh: async (args) => {
        const p = args[1]!;
        if (p.startsWith("repos/o/other/")) return null;
        if (p.includes("/actions/runners")) return JSON.stringify({ runners: [] });
        if (p.includes("/jobs")) return JSON.stringify({ jobs: [] });
        return JSON.stringify({ workflow_runs: [] });
      },
    });
    const out = await service.ci();
    expect(out.repos.find((r) => r.repo === "o/other")).toMatchObject({ error: expect.stringContaining("gh api failed"), runners: [], runs: [], jobs: [] });
    expect(out.repos.find((r) => r.repo === "o/r")!.error).toBeNull();
  });
  test("du is a background fact: the answer does not wait for it and shows it later", async () => {
    let release: (v: string | null) => void = () => {};
    const slow = new Promise<string | null>((r) => (release = r));
    const { service } = build({
      run: async (argv) => (argv[0] === "du" ? slow : argv[0] === "launchctl" ? "" : null),
    });
    const first = await service.ci();
    expect(first.local.every((r) => r.workGB === null)).toBe(true);
    release("2097152\t/x/_work\n");
    await Bun.sleep(10);
    const second = await service.ci();
    expect(second.local.find((r) => r.name === "runner-1")!.workGB).toBe(2);
  });
  test("du is asked for each runner's _work folder through the allowlist shape", async () => {
    const argvs: string[][] = [];
    const { service } = build({ run: async (argv) => { argvs.push(argv); return null; } });
    await service.ci();
    await Bun.sleep(5);
    expect(argvs.filter((a) => a[0] === "du").map((a) => a.join(" ")).sort()).toEqual([`du -sk ${home}/actions-runner-2/_work`, `du -sk ${home}/actions-runner/_work`]);
  });
  test("ps failing does not break the page: every runner reads as stopped", async () => {
    const { service } = build({ machine: { processes: async () => null, containers: async () => ({ running: false }) } });
    const out = await service.ci();
    expect(out.local.every((r) => r.paused)).toBe(true);
    expect(out.containers).toEqual([]);
  });
});
