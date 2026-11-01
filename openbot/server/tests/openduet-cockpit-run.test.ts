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
    const out = await runGit("/tmp/p", ["rev-parse", "--abbrev-ref", "HEAD"], { spawn: f.spawn });
    expect(out).toBe("main\n");
    const argv = f.calls[0]!.argv;
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.slice(0, 1 + GIT_FLAGS.length)).toEqual(["git", ...GIT_FLAGS]);
    expect(argv.slice(-3)).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(argv).toContain("-C");
    expect(argv[argv.indexOf("-C") + 1]).toBe("/tmp/p");
    expect(GIT_FLAGS.slice(0, 5)).toEqual([
      "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    ]);
  });

  test("fixed environment only", async () => {
    const f = fake("");
    await runGit("/tmp/p", ["worktree", "list", "--porcelain"], { spawn: f.spawn });
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
    expect(await runAllowed(["git", "worktree", "list", "--porcelain"], { spawn: f.spawn })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("relative or NUL paths are refused for git", async () => {
    const f = fake("x");
    expect(await runGit("relative", ["worktree", "list", "--porcelain"], { spawn: f.spawn })).toBeNull();
    expect(await runGit("/tmp/a\0b", ["worktree", "list", "--porcelain"], { spawn: f.spawn })).toBeNull();
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
    const out = await runGit("/tmp/p", ["log", "-15", "--format=%H%x1f%ct%x1f%an%x1f%s"], { spawn: f.spawn, timeoutMs: 20 });
    expect(out).toBeNull();
    expect(f.killed).toContain("SIGKILL");
  });

  test("more than 1 MiB of stdout returns null and kills", async () => {
    const f = fake(new Uint8Array(1024 * 1024 + 1).fill(97));
    const out = await runGit("/tmp/p", ["log", "-15", "--format=%H%x1f%ct%x1f%an%x1f%s"], { spawn: f.spawn });
    expect(out).toBeNull();
    expect(f.killed).toContain("SIGKILL");
  });

  test("exactly 1 MiB is accepted", async () => {
    const f = fake(new Uint8Array(1024 * 1024).fill(97));
    const out = await runGit("/tmp/p", ["log", "-15", "--format=%H%x1f%ct%x1f%an%x1f%s"], { spawn: f.spawn });
    expect(out?.length).toBe(1024 * 1024);
  });

  test("non-zero exit returns null", async () => {
    const f = fake("fatal", 128);
    expect(await runGit("/tmp/p", ["log", "-15", "--format=%H%x1f%ct%x1f%an%x1f%s"], { spawn: f.spawn })).toBeNull();
  });

  test("a spawn that throws returns null", async () => {
    const out = await runGit("/tmp/p", ["log", "-15", "--format=%H%x1f%ct%x1f%an%x1f%s"], {
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(out).toBeNull();
  });

  test("real git runs through Bun.spawn", async () => {
    const out = await runGit(process.cwd(), ["rev-parse", "--git-dir"]);
    expect(out?.trim()).toBeTruthy();
  });

  const OID = "a".repeat(40);
  const gitOk = async (args: string[], deps: { maxStdoutBytes?: number } = {}) => {
    const f = fake("ok");
    const out = await runGit("/tmp/p", args, { spawn: f.spawn, ...deps });
    return { out, spawned: f.calls.length };
  };

  test("git: config, checkout, gc and other subcommands are refused", async () => {
    for (const args of [["config", "user.name", "x"], ["checkout", "main"], ["gc"], ["status"], ["log"], ["fetch"], ["rev-parse", "HEAD"]]) {
      expect((await gitOk(args)).spawned).toBe(0);
    }
  });

  test("git cat-file needs a 40-hex blob oid", async () => {
    expect((await gitOk(["cat-file", "blob", OID])).out).toBe("ok");
    for (const bad of ["HEAD:x", "abc", OID.toUpperCase(), OID + "0", "-p"]) {
      expect((await gitOk(["cat-file", "blob", bad])).spawned).toBe(0);
    }
    expect((await gitOk(["cat-file", "-p", OID])).spawned).toBe(0);
  });

  test("git diff needs --no-ext-diff and --no-textconv", async () => {
    const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const full = ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", tree, "HEAD"];
    expect((await gitOk(full)).out).toBe("ok");
    expect((await gitOk(full.filter((x) => x !== "--no-ext-diff"))).spawned).toBe(0);
    expect((await gitOk(full.filter((x) => x !== "--no-textconv"))).spawned).toBe(0);
  });

  test("git: the C1c explorer shapes spawn", async () => {
    expect((await gitOk(["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"])).out).toBe("ok");
    expect(
      (await gitOk(["for-each-ref", "--sort=-creatordate", "--count=30", "--format=%(refname:short)%09%(creatordate:unix)%09%(objectname)", "refs/tags"])).out,
    ).toBe("ok");
    expect((await gitOk(["ls-tree", "-r", "HEAD"])).spawned).toBe(0);
  });

  test("git: every shape collect.ts uses is accepted", async () => {
    const shapes: string[][] = [
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      ["rev-parse", "--verify", "-q", "refs/remotes/origin/main"],
      ["rev-parse", "--verify", "-q", "refs/heads/feat/x"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
      ["worktree", "list", "--porcelain"],
      ["rev-list", "--count", "origin/main..feat/x"],
      ["rev-list", "--count", "main..feat/x"],
      ["rev-parse", "--git-dir"],
      ["remote", "get-url", "origin"],
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["rev-parse", "--abbrev-ref", "@{u}"],
      ["log", "-15", "--format=%H%x1f%ct%x1f%an%x1f%s"],
      ["log", "-8", "--format=%ct%x1f%h%x1f%s", "--", ".claude/session-notes.md"],
      ["rev-list", "--count", "HEAD..@{u}"],
      ["rev-list", "--count", "HEAD", "--not", "--remotes"],
    ];
    for (const s of shapes) expect((await gitOk(s)).out).toBe("ok");
    expect((await gitOk(["rev-list", "--count", "--output=/tmp/x..main"])).spawned).toBe(0);
  });

  test("gh: releases shape is allowed, other api paths are refused", async () => {
    const f = fake("[]");
    expect(await runAllowed(["gh", "api", "repos/o/r/releases?per_page=20"], { spawn: f.spawn })).toBe("[]");
    for (const p of ["repos/o/r/releases?per_page=100", "repos/o/r/releases", "repos/o/r/issues?per_page=20", "repos/o/r/releases/1", "user"]) {
      expect(await runAllowed(["gh", "api", p], { spawn: f.spawn })).toBeNull();
    }
    expect(await runAllowed(["gh", "api", "repos/-x/r/releases?per_page=20"], { spawn: f.spawn })).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  test("maxStdoutBytes raises the cap but is clamped to 8 MiB", async () => {
    const args = ["log", "-15", "--format=%H%x1f%ct%x1f%an%x1f%s"];
    const mib = 1024 * 1024;
    const big = fake(new Uint8Array(2 * mib).fill(97));
    expect((await runGit("/tmp/p", args, { spawn: big.spawn, maxStdoutBytes: 4 * mib }))?.length).toBe(2 * mib);
    const huge = fake(new Uint8Array(8 * mib + 1).fill(97));
    expect(await runGit("/tmp/p", args, { spawn: huge.spawn, maxStdoutBytes: 100 * mib })).toBeNull();
    const exact = fake(new Uint8Array(8 * mib).fill(97));
    expect((await runGit("/tmp/p", args, { spawn: exact.spawn, maxStdoutBytes: 100 * mib }))?.length).toBe(8 * mib);
  });
});
