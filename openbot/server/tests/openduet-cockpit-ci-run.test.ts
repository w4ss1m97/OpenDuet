import { afterEach, describe, expect, test } from "bun:test";
import { INSPECT_TEMPLATE, type SpawnedProcess, runAllowed, timeoutFor } from "../src/openduet/cockpit/run";

type Call = { argv: string[]; env: Record<string, string> };

/** A fake process that prints `out` and exits 0 (or never exits when `hang`). */
function fake(out = "ok", hang = false) {
  const calls: Call[] = [];
  const killed: Array<string | number | undefined> = [];
  const spawn = (argv: string[], options: { env: Record<string, string> }) => {
    calls.push({ argv, env: options.env });
    let finish: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
      if (!hang) resolve(0);
    });
    const proc: SpawnedProcess = {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(out));
          if (!hang) controller.close();
        },
      }),
      exited,
      kill(signal) {
        killed.push(signal);
        finish(137);
      },
    };
    return proc;
  };
  return { spawn, calls, killed };
}

const ID = "a".repeat(64);
const PLIST = "/Users/me/Library/LaunchAgents/actions.runner.o-r.runner-1.plist";
const PS = ["ps", "-axo", "pid=,ppid=,nice=,%cpu=,rss=,comm="];

/** Whether the argv reached spawn. */
async function spawns(argv: string[]) {
  const f = fake();
  await runAllowed(argv, { spawn: f.spawn });
  return f.calls.length === 1;
}

describe("C3 allowlist: gh", () => {
  test("runners (per_page=100) and one run's jobs (per_page=50) are allowed", async () => {
    expect(await spawns(["gh", "api", "repos/o/r/actions/runners?per_page=100"])).toBe(true);
    expect(await spawns(["gh", "api", "repos/o/r/actions/runs/12345/jobs?per_page=50"])).toBe(true);
  });
  test("other per_page, non-digit run ids, bad slugs, extra args are refused", async () => {
    for (const p of [
      "repos/o/r/actions/runners?per_page=30",
      "repos/o/r/actions/runners",
      "repos/o/r/actions/runners?per_page=100&x=1",
      "repos/o/r/actions/runs/abc/jobs?per_page=50",
      "repos/o/r/actions/runs/1;id/jobs?per_page=50",
      "repos/o/r/actions/runs/../jobs?per_page=50",
      `repos/o/r/actions/runs/${"1".repeat(21)}/jobs?per_page=50`,
      "repos/o/r/actions/runs//jobs?per_page=50",
      "repos/o/r/actions/runs/1/jobs?per_page=100",
      "repos/-x/r/actions/runners?per_page=100",
      "repos/a/b/c/actions/runners?per_page=100",
    ]) {
      expect(await spawns(["gh", "api", p])).toBe(false);
    }
    expect(await spawns(["gh", "api", "-X", "POST", "repos/o/r/actions/runners?per_page=100"])).toBe(false);
  });
});

describe("C3 allowlist: sysctl, ps, launchctl list", () => {
  test("sysctl only reads kern.memorystatus_level", async () => {
    expect(await spawns(["sysctl", "-n", "kern.memorystatus_level"])).toBe(true);
    expect(await spawns(["sysctl", "-n", "hw.memsize"])).toBe(false);
    expect(await spawns(["sysctl", "-w", "kern.memorystatus_level=1"])).toBe(false);
    expect(await spawns(["sysctl", "kern.memorystatus_level"])).toBe(false);
  });
  test("ps with comm= is allowed; command= (other processes' arguments) is refused", async () => {
    expect(await spawns(PS)).toBe(true);
    expect(await spawns(["ps", "-axo", "pid=,ppid=,nice=,%cpu=,rss=,command="])).toBe(false);
    expect(await spawns(["ps", "-axeo", "pid=,comm="])).toBe(false);
    expect(await spawns(["ps", "aux"])).toBe(false);
    expect(await spawns([...PS, "-E"])).toBe(false);
  });
  test("launchctl list only; no bootout, kickstart, print, remove", async () => {
    expect(await spawns(["launchctl", "list"])).toBe(true);
    for (const a of [["bootout", "gui/501/x"], ["kickstart", "x"], ["print", "x"], ["remove", "x"], ["list", "x"], ["submit"]]) {
      expect(await spawns(["launchctl", ...a])).toBe(false);
    }
  });
});

describe("C3 allowlist: launchctl load/unload", () => {
  test("unload P and load -w P for a runner plist in LaunchAgents", async () => {
    expect(await spawns(["launchctl", "unload", PLIST])).toBe(true);
    expect(await spawns(["launchctl", "load", "-w", PLIST])).toBe(true);
  });
  test("a plist elsewhere, relative, with .., a different name or extra flags is refused", async () => {
    for (const p of [
      "/Users/me/Library/LaunchAgents/com.evil.plist",
      "/Library/LaunchDaemons/actions.runner.o-r.x.plist",
      "/Users/me/Library/LaunchAgents/../LaunchDaemons/actions.runner.o.x.plist",
      "/Users/me/Library/LaunchAgents/sub/actions.runner.o-r.x.plist",
      "Library/LaunchAgents/actions.runner.o-r.x.plist",
      "/Users/me/Library/LaunchAgents/actions.runner.o-r.x.plist ",
      "/Users/me/Library/LaunchAgents/actions.runner.o r.x.plist",
      "/tmp/Users/me/Library/LaunchAgents/actions.runner.o.x.plist",
    ]) {
      expect(await spawns(["launchctl", "unload", p])).toBe(false);
      expect(await spawns(["launchctl", "load", "-w", p])).toBe(false);
    }
    expect(await spawns(["launchctl", "load", PLIST])).toBe(false);
    expect(await spawns(["launchctl", "unload", "-w", PLIST])).toBe(false);
    expect(await spawns(["launchctl", "load", "-w", PLIST, "-F"])).toBe(false);
    expect(await spawns(["launchctl", "bootout", "gui/501", PLIST])).toBe(false);
  });
});

describe("C3 allowlist: du", () => {
  const WORK = "/Users/me/actions-runner-2/_work";
  test("du -sk of a runner's _work folder", async () => {
    expect(await spawns(["du", "-sk", WORK])).toBe(true);
    expect(await spawns(["du", "-sk", "/Users/me/actions-runner/_work"])).toBe(true);
  });
  test("relative, .., other folders and flags are refused", async () => {
    for (const p of [
      "_work",
      "actions-runner/_work",
      "/Users/me/actions-runner/../.ssh/_work",
      "/Users/me/actions-runner/_work/..",
      "/Users/me/actions-runner/_work/sub",
      "/Users/me/Documents/_work",
      "/Users/me/actions-runner/",
      "/actions-runner/_work",
      "/Users/me/other-actions-runner/_work",
    ]) {
      expect(await spawns(["du", "-sk", p])).toBe(false);
    }
    expect(await spawns(["du", "-sh", WORK])).toBe(false);
    expect(await spawns(["du", "-sk", WORK, "/etc"])).toBe(false);
    expect(await spawns(["du", WORK])).toBe(false);
  });
});

describe("C3 allowlist: docker", () => {
  const stats = ["docker", "stats", "--no-stream", "--no-trunc", "--format", "{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}"];
  test("the fixed read shapes spawn", async () => {
    expect(await spawns(["docker", "info", "--format", "{{.NCPU}}|{{.MemTotal}}"])).toBe(true);
    expect(await spawns(["docker", "ps", "-aq", "--no-trunc"])).toBe(true);
    expect(await spawns(stats)).toBe(true);
    expect(await spawns(["docker", "system", "df", "--format", "{{.Type}}|{{.Size}}|{{.Reclaimable}}"])).toBe(true);
  });
  test("inspect needs the exact template and 1-100 full ids", async () => {
    expect(await spawns(["docker", "inspect", "--format", INSPECT_TEMPLATE, ID])).toBe(true);
    expect(await spawns(["docker", "inspect", "--format", INSPECT_TEMPLATE, ...Array.from({ length: 100 }, () => ID)])).toBe(true);
    expect(await spawns(["docker", "inspect", "--format", INSPECT_TEMPLATE, ...Array.from({ length: 101 }, () => ID)])).toBe(false);
    expect(await spawns(["docker", "inspect", "--format", INSPECT_TEMPLATE])).toBe(false);
    expect(await spawns(["docker", "inspect", ID])).toBe(false);
    expect(await spawns(["docker", "inspect", "--format", INSPECT_TEMPLATE, "abc123"])).toBe(false);
    expect(await spawns(["docker", "inspect", "--format", INSPECT_TEMPLATE, "a".repeat(12)])).toBe(false);
    expect(await spawns(["docker", "inspect", "--format", INSPECT_TEMPLATE, ID.toUpperCase()])).toBe(false);
    expect(await spawns(["docker", "inspect", "--format", INSPECT_TEMPLATE, "runner-container"])).toBe(false);
    expect(await spawns(["docker", "inspect", "--format", "{{json .}}", ID])).toBe(false);
    expect(await spawns(["docker", "inspect", "--format", "{{.Config.Env}}", ID])).toBe(false);
    expect(await spawns(["docker", "inspect", "-f", INSPECT_TEMPLATE, ID])).toBe(false);
  });
  test("the template prints only a RUNNER_NAME entry of the environment", () => {
    expect(INSPECT_TEMPLATE).toBe(
      '{{.Id}}|{{.Name}}|{{.State.Status}}|{{range .Config.Env}}{{if eq (index (split . "=") 0) "RUNNER_NAME"}}{{.}}{{end}}{{end}}',
    );
  });
  test("stop and start take one full id", async () => {
    expect(await spawns(["docker", "stop", ID])).toBe(true);
    expect(await spawns(["docker", "start", ID])).toBe(true);
    for (const a of [["stop", "web"], ["stop", ID.slice(0, 12)], ["stop", ID, ID], ["stop", "-t", "0", ID], ["kill", ID], ["rm", ID], ["rm", "-f", ID]]) {
      expect(await spawns(["docker", ...a])).toBe(false);
    }
  });
  test("exec, run, cp, compose, prune and other subcommands are refused", async () => {
    for (const a of [
      ["exec", ID, "sh"], ["run", "alpine"], ["cp", `${ID}:/etc/passwd`, "/tmp"], ["compose", "up"], ["system", "prune", "-f"],
      ["system", "df"], ["info"], ["ps"], ["ps", "-a"], ["stats"], ["logs", ID], ["pause", ID],
    ]) {
      expect(await spawns(["docker", ...a])).toBe(false);
    }
    expect(await spawns(["docker", "stats", "--no-stream", "--format", "{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}"])).toBe(false);
  });
});

describe("C3 other programs", () => {
  test("a NUL byte or unknown program is still refused", async () => {
    expect(await spawns(["ps\0", "-axo", "pid="])).toBe(false);
    expect(await spawns(["./svc.sh", "stop"])).toBe(false);
    expect(await spawns(["sh", "-c", "id"])).toBe(false);
    expect(await spawns(["launchctl", "unload", PLIST + "\0"])).toBe(false);
  });
});

describe("C3 timeouts and caps", () => {
  const realSetTimeout = globalThis.setTimeout;
  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  const table: Array<[string, string[], number]> = [
    ["git", ["git"], 10_000],
    ["gh", ["gh", "api", "repos/o/r/actions/runners?per_page=100"], 25_000],
    ["sysctl", ["sysctl", "-n", "kern.memorystatus_level"], 3_000],
    ["ps", PS, 5_000],
    ["launchctl list", ["launchctl", "list"], 5_000],
    ["launchctl unload", ["launchctl", "unload", PLIST], 40_000],
    ["launchctl load", ["launchctl", "load", "-w", PLIST], 40_000],
    ["du", ["du", "-sk", "/Users/me/actions-runner/_work"], 60_000],
    ["docker info", ["docker", "info", "--format", "{{.NCPU}}|{{.MemTotal}}"], 10_000],
    ["docker ps", ["docker", "ps", "-aq", "--no-trunc"], 10_000],
    ["docker stats", ["docker", "stats", "--no-stream", "--no-trunc", "--format", "{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}"], 20_000],
    ["docker system df", ["docker", "system", "df", "--format", "{{.Type}}|{{.Size}}|{{.Reclaimable}}"], 30_000],
    ["docker stop", ["docker", "stop", ID], 60_000],
    ["docker start", ["docker", "start", ID], 60_000],
    ["docker inspect", ["docker", "inspect", "--format", INSPECT_TEMPLATE, ID], 10_000],
  ];

  test("the table gives each tool its timeout", () => {
    for (const [, argv, ms] of table.filter(([name]) => name !== "git")) expect(timeoutFor(argv)).toBe(ms);
    expect(timeoutFor(["git", "-C", "/x"])).toBe(10_000);
  });

  test("runAllowed arms the timer with the tool's timeout", async () => {
    for (const [name, argv, ms] of table.filter(([n]) => n !== "git")) {
      const delays: number[] = [];
      globalThis.setTimeout = ((fn: () => void, delay?: number, ...rest: unknown[]) => {
        delays.push(delay ?? 0);
        return realSetTimeout(fn, delay, ...rest);
      }) as typeof setTimeout;
      await runAllowed(argv, { spawn: fake().spawn });
      globalThis.setTimeout = realSetTimeout;
      expect({ name, delays }).toEqual({ name, delays: [ms] });
    }
  });

  test("a hanging process is killed when the timeout passes", async () => {
    const f = fake("", true);
    expect(await runAllowed(["sysctl", "-n", "kern.memorystatus_level"], { spawn: f.spawn, timeoutMs: 15 })).toBeNull();
    expect(f.killed).toContain("SIGKILL");
  });

  test("ps may print 2 MiB, other tools 1 MiB", async () => {
    const mib = 1024 * 1024;
    const f = (n: number) => fake("a".repeat(n));
    expect((await runAllowed(PS, { spawn: f(2 * mib).spawn }))?.length).toBe(2 * mib);
    expect(await runAllowed(PS, { spawn: f(2 * mib + 1).spawn })).toBeNull();
    expect((await runAllowed(["launchctl", "list"], { spawn: f(mib).spawn }))?.length).toBe(mib);
    expect(await runAllowed(["launchctl", "list"], { spawn: f(mib + 1).spawn })).toBeNull();
  });
});

describe("C3 environment", () => {
  test("PATH gets /usr/local/bin and /opt/homebrew/bin when missing, and keeps them once", async () => {
    const before = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin";
      const a = fake();
      await runAllowed(["launchctl", "list"], { spawn: a.spawn });
      expect(a.calls[0]!.env.PATH).toBe("/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin");
      process.env.PATH = "/opt/homebrew/bin:/usr/bin";
      const b = fake();
      await runAllowed(["launchctl", "list"], { spawn: b.spawn });
      expect(b.calls[0]!.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/usr/local/bin");
    } finally {
      process.env.PATH = before;
    }
  });
});
