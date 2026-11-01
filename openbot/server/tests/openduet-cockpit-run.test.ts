import { describe, expect, test } from "bun:test";
import {
  GIT_FLAGS,
  type SpawnedProcess,
  runAllowed,
  runGit,
} from "../src/openduet/cockpit/run";

type Call = { argv: string[]; env: Record<string, string> };

/** A fake process: prints `out`, exits with `code`; `hang` never exits until killed. */
function fake(out: string | Uint8Array, code = 0, hang = false) {
  const calls: Call[] = [];
  const killed: Array<string | number | undefined> = [];
  const spawn = (argv: string[], options: { env: Record<string, string> }) => {
    calls.push({ argv, env: options.env });
    let finish: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
      if (!hang) resolve(code);
    });
    const bytes = typeof out === "string" ? new TextEncoder().encode(out) : out;
    const proc: SpawnedProcess = {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
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

describe("cockpit command runner", () => {
  test("returns stdout of an allowed git call, argv is an array with the guard flags first", async () => {
    const f = fake("main\n");
    const out = await runGit("/tmp/p", ["rev-parse", "HEAD"], { spawn: f.spawn });
    expect(out).toBe("main\n");
    const argv = f.calls[0]!.argv;
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.slice(0, 1 + GIT_FLAGS.length)).toEqual(["git", ...GIT_FLAGS]);
    expect(argv.slice(-2)).toEqual(["rev-parse", "HEAD"]);
    expect(argv).toContain("-C");
    expect(argv[argv.indexOf("-C") + 1]).toBe("/tmp/p");
    expect(GIT_FLAGS.slice(0, 5)).toEqual([
      "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    ]);
  });

  test("fixed environment only", async () => {
    const f = fake("");
    await runGit("/tmp/p", ["status"], { spawn: f.spawn });
    const env = f.calls[0]!.env;
    expect(Object.keys(env).sort()).toEqual(
      ["GH_PROMPT_DISABLED", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "HOME", "LC_ALL", "NO_COLOR", "PATH"],
    );
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  test("unknown tool is refused before spawn", async () => {
    const f = fake("x");
    expect(await runAllowed(["sh", "-c", "id"], { spawn: f.spawn })).toBeNull();
    expect(await runAllowed(["rm", "-rf", "/"], { spawn: f.spawn })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("git argv without the guard flags is refused", async () => {
    const f = fake("x");
    expect(await runAllowed(["git", "status"], { spawn: f.spawn })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("relative or NUL paths are refused for git", async () => {
    const f = fake("x");
    expect(await runGit("relative", ["status"], { spawn: f.spawn })).toBeNull();
    expect(await runGit("/tmp/a\0b", ["status"], { spawn: f.spawn })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("gh: bad slug and unlisted subcommands are refused before spawn", async () => {
    const f = fake("[]");
    const bad = ["a/b; id", "a/b/c", "../x", "a", "a b/c", "-x/y"];
    for (const slug of bad) {
      expect(await runAllowed(["gh", "pr", "list", "--repo", slug, "--state", "open"], { spawn: f.spawn })).toBeNull();
      expect(await runAllowed(["gh", "api", `repos/${slug}/actions/runs?per_page=30`], { spawn: f.spawn })).toBeNull();
    }
    expect(await runAllowed(["gh", "pr", "merge", "--repo", "a/b"], { spawn: f.spawn })).toBeNull();
    expect(await runAllowed(["gh", "api", "repos/a/b/issues"], { spawn: f.spawn })).toBeNull();
    expect(await runAllowed(["gh", "api", "-X", "POST", "repos/a/b/actions/runs?per_page=30"], { spawn: f.spawn })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("gh: the two allowed shapes spawn", async () => {
    const f = fake("[]");
    expect(await runAllowed(["gh", "pr", "list", "--repo", "o/r.x-1", "--state", "open"], { spawn: f.spawn })).toBe("[]");
    expect(await runAllowed(["gh", "api", "repos/o/r/actions/runs?per_page=30"], { spawn: f.spawn })).toBe("[]");
    expect(f.calls).toHaveLength(2);
  });

  test("timeout kills with SIGKILL and returns null", async () => {
    const f = fake("partial", 0, true);
    const out = await runGit("/tmp/p", ["log"], { spawn: f.spawn, timeoutMs: 20 });
    expect(out).toBeNull();
    expect(f.killed).toContain("SIGKILL");
  });

  test("more than 1 MiB of stdout returns null and kills", async () => {
    const f = fake(new Uint8Array(1024 * 1024 + 1).fill(97));
    const out = await runGit("/tmp/p", ["log"], { spawn: f.spawn });
    expect(out).toBeNull();
    expect(f.killed).toContain("SIGKILL");
  });

  test("exactly 1 MiB is accepted", async () => {
    const f = fake(new Uint8Array(1024 * 1024).fill(97));
    const out = await runGit("/tmp/p", ["log"], { spawn: f.spawn });
    expect(out?.length).toBe(1024 * 1024);
  });

  test("non-zero exit returns null", async () => {
    const f = fake("fatal", 128);
    expect(await runGit("/tmp/p", ["log"], { spawn: f.spawn })).toBeNull();
  });

  test("a spawn that throws returns null", async () => {
    const out = await runGit("/tmp/p", ["log"], {
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(out).toBeNull();
  });

  test("real git runs through Bun.spawn", async () => {
    const out = await runGit(process.cwd(), ["rev-parse", "--is-inside-work-tree"]);
    expect(out?.trim()).toBe("true");
  });
});
