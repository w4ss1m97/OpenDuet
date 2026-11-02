import { describe, expect, test } from "bun:test";
import { type SpawnedProcess, runAllowed, runGhApi, runNpm, timeoutFor } from "../src/openduet/cockpit/run";
import { parseSecretScanning } from "../src/openduet/cockpit/quality-parse";

const enc = (s: string) => new TextEncoder().encode(s);
function stream(s: string) {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc(s)); c.close(); } });
}
/** A fake process with stdout, stderr and an exit code. */
function fake(out: string, code = 0, err = "") {
  const calls: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const spawn = (argv: string[], options: { env: Record<string, string> }): SpawnedProcess => {
    calls.push({ argv, env: options.env });
    return { stdout: stream(out), stderr: stream(err), exited: Promise.resolve(code), kill() {} };
  };
  return { spawn, calls };
}

const S = "o/r";
const DATE = "2026-10-01";
const okGh = [
  `repos/${S}/actions/runs?per_page=100&created=%3E%3D${DATE}`,
  `repos/${S}/actions/runs/123/jobs`,
  `repos/${S}/actions/runs/123/attempts/1/jobs`,
  `repos/${S}/dependabot/alerts?state=open&per_page=100`,
  `repos/${S}/code-scanning/alerts?state=open&per_page=100`,
  `repos/${S}/secret-scanning/alerts?state=open&per_page=100&hide_secret=true`,
  `repos/${S}/branches/main/protection`,
  `repos/${S}/branches/release-1.2_x/protection`,
  `repos/${S}`,
];

describe("gh api shapes", () => {
  test("each C4 shape is accepted", async () => {
    for (const path of okGh) {
      const f = fake("{}");
      const r = await runGhApi(path, { spawn: f.spawn });
      expect(r).toEqual({ ok: true, json: {} });
      expect(f.calls[0]!.argv).toEqual(["gh", "api", path]);
    }
  });

  test("near misses are refused before spawn", async () => {
    const bad = [
      `repos/${S}/actions/runs?per_page=50&created=%3E%3D${DATE}`,
      `repos/${S}/actions/runs?per_page=100&created=%3E%3D2026-1-1`,
      `repos/${S}/actions/runs?per_page=100&created=%3E%3D${DATE}&x=1`,
      `repos/${S}/dependabot/alerts?state=open&per_page=100&x=1`,
      `repos/${S}/dependabot/alerts?state=closed&per_page=100`,
      `repos/${S}/secret-scanning/alerts?state=open&per_page=100`,
      `repos/../x/dependabot/alerts?state=open&per_page=100`,
      `repos/o/../actions/runs/1/jobs`,
      `repos/${S}/branches/feat/x/protection`,
      `repos/${S}/branches/-x/protection`,
      `repos/${S}/branches/${"a".repeat(101)}/protection`,
      `repos/${S}/actions/runs/12ab/jobs`,
      `repos/${S}/actions/runs/${"1".repeat(21)}/jobs`,
      `repos/${S}/actions/runs/1/attempts/2/jobs`,
      `repos/${S}/actions/jobs/1/logs`,
      `repos/${S}/contents/.env`,
    ];
    for (const path of bad) {
      const f = fake("{}");
      expect(await runGhApi(path, { spawn: f.spawn })).toEqual({ ok: false, status: null });
      expect(f.calls).toHaveLength(0);
    }
    const f = fake("{}");
    expect(await runAllowed(["gh", "api", "--allow-escape-sequences", `repos/${S}/actions/jobs/1/logs`], { spawn: f.spawn })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  test("stderr gives only the status code", async () => {
    const f = fake("", 1, "gh: Resource not accessible token ghp_secret (HTTP 403)");
    expect(await runGhApi(`repos/${S}/dependabot/alerts?state=open&per_page=100`, { spawn: f.spawn })).toEqual({ ok: false, status: 403 });
    const g = fake("", 1, "gh: Not Found (HTTP 404)");
    expect(await runGhApi(`repos/${S}`, { spawn: g.spawn })).toEqual({ ok: false, status: 404 });
    const h = fake("", 1, "network down");
    expect(await runGhApi(`repos/${S}`, { spawn: h.spawn })).toEqual({ ok: false, status: null });
  });

  test("unreadable stdout is a failure without a status", async () => {
    expect(await runGhApi(`repos/${S}`, { spawn: fake("<html>").spawn })).toEqual({ ok: false, status: null });
  });

  test("the secret-scanning parser keeps counts only", () => {
    const fixture = [{ number: 1, secret_type: "x", secret: "ghp_REALLOOKINGVALUE", html_url: "u" }, { number: 2, secret: "zzz" }];
    const out = JSON.stringify(parseSecretScanning(fixture));
    expect(out).not.toContain("REALLOOKING");
    expect(out).not.toContain("secret");
    expect(parseSecretScanning(fixture)).toEqual({ available: true, total: 2 });
    expect(parseSecretScanning({ message: "x" })).toEqual({ available: false, why: "unreadable answer" });
  });
});

describe("npm", () => {
  const abs = "/Users/w/p";
  const base = (kind: string, prefix = abs) => [
    "npm", kind, "--json", "--ignore-scripts", "--registry=https://registry.npmjs.org/", "--prefix", prefix,
  ];

  test("audit and outdated accepted, exit 1 still gives stdout, env adds npm settings", async () => {
    const f = fake('{"a":1}', 1);
    expect(await runNpm(abs, "audit", { spawn: f.spawn })).toBe('{"a":1}');
    expect(f.calls[0]!.argv).toEqual(base("audit"));
    expect(f.calls[0]!.env.npm_config_update_notifier).toBe("false");
    expect(f.calls[0]!.env.npm_config_fund).toBe("false");
    const g = fake("{}", 0);
    expect(await runNpm(abs, "outdated", { spawn: g.spawn })).toBe("{}");
  });

  test("exit 2 or more is a failure", async () => {
    expect(await runNpm(abs, "audit", { spawn: fake("x", 2).spawn })).toBeNull();
  });

  test("timeouts per tool", () => {
    expect(timeoutFor(base("audit"))).toBe(120_000);
    expect(timeoutFor(["gh", "api", "x"])).toBe(25_000);
    expect(timeoutFor(["/usr/bin/osascript"])).toBe(10_000);
    expect(timeoutFor(["git"])).toBe(10_000);
  });

  test("refused shapes", async () => {
    const f = fake("{}");
    const refused: string[][] = [
      ["npm", "audit", "--json", "--ignore-scripts", "--prefix", abs],
      ["npm", "audit", "--json", "--registry=https://registry.npmjs.org/", "--prefix", abs],
      ["npm", "audit", "--json", "--ignore-scripts", "--registry=https://evil.example/", "--prefix", abs],
      base("audit", "relative/dir"),
      base("audit", "/a/../etc"),
      base("install"),
      base("audit").concat(["--foo"]),
      ["uv", "pip", "list", "--outdated"],
      ["gitleaks", "dir", abs],
    ];
    for (const argv of refused) expect(await runAllowed(argv, { spawn: f.spawn })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });
});

describe("osascript", () => {
  const argv = (title: string, body: string) => [
    "/usr/bin/osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e", "end run", "--", title, body,
  ];
  test("only the fixed script is accepted", async () => {
    const f = fake("");
    expect(await runAllowed(argv("t", "b"), { spawn: f.spawn })).toBe("");
    expect(f.calls).toHaveLength(1);
    const g = fake("");
    const other = argv("t", "b");
    other[4] = 'do shell script "id"';
    expect(await runAllowed(other, { spawn: g.spawn })).toBeNull();
    expect(await runAllowed(["/usr/bin/osascript", "-e", "beep"], { spawn: g.spawn })).toBeNull();
    expect(await runAllowed(["osascript", ...argv("t", "b").slice(1)], { spawn: g.spawn })).toBeNull();
    expect(await runAllowed([...argv("t", "b"), "extra"], { spawn: g.spawn })).toBeNull();
    expect(g.calls).toHaveLength(0);
  });
});

describe("new git shapes", () => {
  test("accepted and refused", async () => {
    const ok: string[][] = [
      ["ls-files", "-z"],
      ["ls-files", "-z", "--others", "--exclude-standard"],
      ["log", "--since=30.days", "--name-only", "--format=", "--no-renames", "--no-merges"],
      ["log", "-1", "--format=%ct"],
      ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"],
    ];
    const flags = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never"];
    for (const args of ok) {
      const f = fake("x");
      expect(await runAllowed(["git", ...flags, "-C", "/p", ...args], { spawn: f.spawn })).toBe("x");
    }
    const bad: string[][] = [["ls-files", "-z", "--others"], ["log", "--since=30.days", "--name-only"], ["log", "-p"], ["for-each-ref", "refs/heads"]];
    for (const args of bad) {
      const f = fake("x");
      expect(await runAllowed(["git", ...flags, "-C", "/p", ...args], { spawn: f.spawn })).toBeNull();
    }
  });
});
