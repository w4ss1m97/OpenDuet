import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exploreProject } from "../src/openduet/cockpit/explore";
import { containsSecret, isNeverRead } from "../src/openduet/cockpit/secrets";
import type { Spawn } from "../src/openduet/cockpit/run";

const sh = (cwd: string, ...args: string[]) => shEnv(cwd, {}, ...args);
const shEnv = (cwd: string, env: Record<string, string>, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

const roots: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "explore-"));
  roots.push(dir);
  return dir;
};
const put = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
/** Real spawn that remembers every argv, to check what was asked of git. */
function recorder() {
  const argvs: string[][] = [];
  const spawn: Spawn = (argv, { env }) => {
    argvs.push(argv);
    return Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  };
  return { argvs, run: { spawn } };
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const KEY_HEADER = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");

describe("secrets", () => {
  test("never-read names", () => {
    for (const p of [".env", ".env.example", "a/.env.local", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_rsa.pub", "x/id_ed25519",
      "a.pem", "a.KEY", "a.p12", "a.pfx", "a.jks", "a.keystore", "a.crt", "a.cer", "a.der", "a.mobileprovision", "infra/terraform.tfstate", "x.tfstate.backup",
      "credentials.json", "secrets.yaml", "service-account-prod.json", "google-services.json", "GoogleService-Info.plist", ".ssh/config", "home/.aws/config", ".gnupg/x"]) {
      expect(isNeverRead(p)).toBe(true);
    }
    for (const p of ["README.md", "src/index.ts", "package.json", "docs/env.md", "src/keys.ts"]) expect(isNeverRead(p)).toBe(false);
  });
  test("content patterns", () => {
    expect(containsSecret(KEY_HEADER)).toBe(true);
    expect(containsSecret(`k=${"AKIA"}${"A".repeat(16)}`)).toBe(true);
    expect(containsSecret(`${"ghp"}_${"a".repeat(30)}`)).toBe(true);
    expect(containsSecret(`${"github_pat"}_${"a".repeat(30)}`)).toBe(true);
    expect(containsSecret(`${"sk-ant"}-${"a".repeat(20)}`)).toBe(true);
    expect(containsSecret(`${"sk"}-${"a".repeat(30)}`)).toBe(true);
    expect(containsSecret(`${"xoxb"}-${"1".repeat(12)}`)).toBe(true);
    expect(containsSecret(`${"AIza"}${"a".repeat(35)}`)).toBe(true);
    expect(containsSecret("just a readme about sk-learn")).toBe(false);
  });
});

describe("exploreProject", () => {
  let repo: string;
  let envOid: string;
  let keyOid: string;
  const rec = recorder();

  beforeAll(() => {
    repo = tmp();
    sh(repo, "init", "-q", "-b", "main");
    put(repo, "README.md", "# Demo\nA demo project.\n");
    put(repo, "package.json", JSON.stringify({ name: "demo", version: "1.2.3", dependencies: { hono: "^4", zod: "^4" }, devDependencies: { typescript: "^5" }, scripts: { test: "bun test", build: "tsc" } }));
    put(repo, "src/index.ts", "export const a = 1;\nexport const b = 2;\n");
    put(repo, "src/util.ts", "export const c = 3;\n");
    put(repo, "tools/run.py", "print('hi')\nprint('there')\n");
    put(repo, "pyproject.toml", '[project]\nname = "pydemo"\nversion = "0.3.0"\ndependencies = ["requests>=2", "pydantic"]\n');
    put(repo, "Cargo.toml", '[package]\nname = "rs"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n');
    put(repo, "go.mod", "module example.com/demo\n\ngo 1.22\n\nrequire github.com/x/y v1.0.0\n");
    put(repo, ".github/workflows/ci.yml", "name: CI\non:\n  push:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n  lint:\n    runs-on: ubuntu-latest\n");
    put(repo, "docs/guide.md", "intro\n\n# The Guide\ntext\n");
    put(repo, "docs/leak.md", `# Leak\n${KEY_HEADER}\nabc\n`);
    put(repo, ".env", "TOKEN=abc\n");
    put(repo, ".env.example", "TOKEN=\n");
    put(repo, "certs/id_rsa", "x\n");
    put(repo, "certs/server.pem", "x\n");
    put(repo, "notes/secret-note.md", `# Note\n${"ghp"}_${"a".repeat(30)}\n`);
    put(repo, "ignored-by-git.txt", "untracked\n");
    sh(repo, "add", "-A", "--", ".", ":!ignored-by-git.txt");
    envOid = sh(repo, "hash-object", ".env");
    keyOid = sh(repo, "hash-object", "docs/leak.md");
    symlinkSync("README.md", join(repo, "link.md"));
    sh(repo, "add", "link.md");
    sh(repo, "commit", "-q", "-m", "first");
    sh(repo, "tag", "-a", "v0.1.0", "-m", "one");
    put(repo, "src/more.ts", "export const d = 4;\n");
    sh(repo, "add", "src/more.ts");
    sh(repo, "commit", "-q", "-m", "second");
    shEnv(repo, { GIT_COMMITTER_DATE: "2031-01-01T00:00:00Z" }, "tag", "-a", "v0.2.0", "-m", "two");
    put(repo, "untracked.ts", "export const u = 1;\n");
  });

  test("per-language counts from the committed tree, untracked files ignored", async () => {
    const out = (await exploreProject(repo, { run: rec.run }))!;
    const ts = out.facts.languages.find((l) => l.name === "TypeScript")!;
    expect(ts.files).toBe(3);
    expect(ts.lines).toBe(4);
    expect(out.facts.languages.find((l) => l.name === "Python")!.files).toBe(1);
    expect(out.facts.head).toBe(sh(repo, "rev-parse", "HEAD"));
    expect(JSON.stringify(out.facts)).not.toContain("untracked.ts");
    expect(JSON.stringify(out.facts)).not.toContain("ignored-by-git");
  });

  test("secret-named files are never cat-file'd and never listed", async () => {
    const out = (await exploreProject(repo, { run: rec.run }))!;
    const asked = rec.argvs.filter((a) => a.includes("cat-file")).map((a) => a[a.length - 1]);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain(envOid);
    const names = out.facts.tree.map((n) => n.path);
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".env.example");
    expect(names).not.toContain("certs/id_rsa");
    expect(names).not.toContain("certs/server.pem");
  });

  test("a file with a private key or token is dropped from facts and excerpts", async () => {
    const out = (await exploreProject(repo, { run: rec.run }))!;
    expect(out.facts.docs.map((d) => d.path)).toEqual(["docs/guide.md"]);
    expect(out.excerpts.map((e) => e.path)).not.toContain("docs/leak.md");
    expect(JSON.stringify(out)).not.toContain("PRIVATE KEY");
    expect(rec.argvs.filter((a) => a.includes("cat-file")).map((a) => a[a.length - 1])).toContain(keyOid);
  });

  test("symlinks and submodules are skipped", async () => {
    const out = (await exploreProject(repo, { run: rec.run }))!;
    expect(out.facts.tree.map((n) => n.path)).not.toContain("link.md");
    const sub = tmp();
    sh(sub, "init", "-q", "-b", "main");
    put(sub, "a.ts", "x\n");
    sh(sub, "add", "-A");
    sh(sub, "commit", "-q", "-m", "s");
    const inner = sh(sub, "rev-parse", "HEAD");
    sh(sub, "update-index", "--add", "--cacheinfo", `160000,${inner},vendor/lib`);
    sh(sub, "commit", "-q", "-m", "sm");
    const res = (await exploreProject(sub))!;
    expect(res.facts.tree.map((n) => n.path)).not.toContain("vendor/lib");
    expect(res.facts.files).toBe(1);
  });

  test("manifests, workflows, docs and entry points are parsed", async () => {
    const f = (await exploreProject(repo))!.facts;
    const npm = f.manifests.find((m) => m.path === "package.json")!;
    expect(npm).toMatchObject({ kind: "npm", name: "demo", version: "1.2.3" });
    expect(npm.dependencies).toEqual(["hono", "typescript", "zod"]);
    expect(npm.scripts).toEqual(["build", "test"]);
    expect(f.manifests.find((m) => m.path === "pyproject.toml")).toMatchObject({ kind: "python", name: "pydemo", version: "0.3.0", dependencies: ["pydantic", "requests"] });
    expect(f.manifests.find((m) => m.path === "Cargo.toml")).toMatchObject({ kind: "rust", name: "rs", dependencies: ["serde"] });
    expect(f.manifests.find((m) => m.path === "go.mod")).toMatchObject({ kind: "go", name: "example.com/demo" });
    expect(f.workflows).toEqual([{ path: ".github/workflows/ci.yml", name: "CI", triggers: ["pull_request", "push"], jobs: ["lint", "test"] }]);
    expect(f.docs[0]).toMatchObject({ path: "docs/guide.md", title: "The Guide" });
    expect(f.entryPoints).toEqual(["src/index.ts"]);
  });

  test("tags newest first, releases null without a remote", async () => {
    const f = (await exploreProject(repo))!.facts;
    expect(f.tags.map((t) => t.name)).toEqual(["v0.2.0", "v0.1.0"]);
    expect(f.releases).toBeNull();
  });

  test("releases come from gh when the remote is on GitHub", async () => {
    const r = tmp();
    sh(r, "init", "-q", "-b", "main");
    sh(r, "remote", "add", "origin", "https://github.com/acme/demo.git");
    put(r, "a.ts", "x\n");
    sh(r, "add", "-A");
    sh(r, "commit", "-q", "-m", "a");
    const body = JSON.stringify([{ tag_name: "v1", name: "One", published_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/acme/demo/releases/v1", prerelease: false }]);
    const calls: string[][] = [];
    const out = (await exploreProject(r, {
      run: {
        spawn: (argv, { env }) => {
          if (argv[0] === "gh") {
            calls.push(argv);
            return { stdout: new Response(body).body!, exited: Promise.resolve(0), kill() {} };
          }
          return Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        },
      },
    }))!;
    expect(calls).toEqual([["gh", "api", "repos/acme/demo/releases?per_page=20"]]);
    expect(out.facts.releases).toEqual([{ tag: "v1", name: "One", t: Date.parse("2026-01-02T00:00:00Z") / 1000, url: "https://github.com/acme/demo/releases/v1", prerelease: false }]);
  });

  test("the tree stops at depth 3 and 400 nodes, flagged truncated", async () => {
    const r = tmp();
    sh(r, "init", "-q", "-b", "main");
    for (let i = 0; i < 450; i++) put(r, `d${String(i).padStart(3, "0")}/f.ts`, "x\n");
    put(r, "a/b/c/d/deep.ts", "x\n");
    sh(r, "add", "-A");
    sh(r, "commit", "-q", "-m", "many");
    const f = (await exploreProject(r))!.facts;
    expect(f.tree.length).toBe(400);
    expect(f.treeTruncated).toBe(true);
    expect(f.tree.every((n) => n.path.split("/").length <= 3)).toBe(true);
    expect(f.files).toBe(451);
  });

  test("an empty repo has head null and empty facts", async () => {
    const r = tmp();
    sh(r, "init", "-q", "-b", "main");
    const f = (await exploreProject(r))!.facts;
    expect(f.head).toBeNull();
    expect(f.files).toBe(0);
    expect(f.tree).toEqual([]);
    expect(f.tags).toEqual([]);
  });

  test("not a git repository gives null", async () => {
    expect(await exploreProject(tmp())).toBeNull();
  });
});
