import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSmallFile, scanWorkingTree } from "../src/openduet/cockpit/quality-files";

const AKIA = `${"AKIA"}${"A".repeat(16)}`;
let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "q-files-"));
  outside = await mkdtemp(join(tmpdir(), "q-out-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const put = async (rel: string, text: string | Uint8Array) => {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), text);
};

describe("working tree scan", () => {
  test("finds secrets with file:line:type and code stats, no match text", async () => {
    await put("src/a.ts", `// TODO\nconst k = "${AKIA}";\n`);
    await put("README.md", "hello\n");
    const r = await scanWorkingTree(root, ["src/a.ts", "README.md"]);
    expect(r.secrets).toEqual([{ file: "src/a.ts", line: 2, type: "AWS access key id", severity: "high" }]);
    expect(JSON.stringify(r)).not.toContain(AKIA);
    expect(r.stats.map((s) => s.rel)).toEqual(["src/a.ts"]);
    expect(r.stats[0]!.todo).toEqual({ TODO: 1 });
  });

  test("symlinks, symlinked dirs, big files and binaries are skipped", async () => {
    await writeFile(join(outside, "x.ts"), `${AKIA}\n`);
    await symlink(join(outside, "x.ts"), join(root, "link.ts"));
    await symlink(outside, join(root, "linkdir"));
    await put("big.ts", `${AKIA}\n${"a".repeat(1024 * 1024)}`);
    await put("bin.ts", new Uint8Array([65, 0, 66, ...new TextEncoder().encode(AKIA)]));
    const r = await scanWorkingTree(root, ["link.ts", "linkdir/x.ts", "big.ts", "bin.ts", "missing.ts"]);
    expect(r.secrets).toEqual([]);
    expect(r.stats).toEqual([]);
  });

  test("isNeverRead files are never opened; .env is a finding, .env.example is nothing", async () => {
    await put(".env", `K=${AKIA}\n`);
    await put(".env.example", `K=${AKIA}\n`);
    await put("id_rsa", "x");
    await put("ok.txt", "fine\n");
    const opened: string[] = [];
    const spy = ((path: string, flags?: number) => {
      opened.push(String(path));
      return open(path, flags);
    }) as typeof open;
    const r = await scanWorkingTree(root, [".env", ".env.example", "id_rsa", "ok.txt"], { open: spy });
    expect(opened).toEqual([join(root, "ok.txt")]);
    expect(r.secrets).toEqual([
      { file: ".env", line: 0, type: "tracked sensitive file", severity: "high" },
      { file: "id_rsa", line: 0, type: "tracked sensitive file", severity: "high" },
    ]);
  });

  test("at most 4,000 files are looked at; findings capped at 60", async () => {
    const rels: string[] = [];
    for (let i = 0; i < 4005; i++) rels.push(`many/f${i}.txt`);
    await mkdir(join(root, "many"), { recursive: true });
    await Promise.all(rels.map((rel, i) => writeFile(join(root, rel), i === 0 || i === 4002 ? `${AKIA}\n` : "x\n")));
    const r = await scanWorkingTree(root, rels);
    expect(r.secrets.map((s) => s.file)).toEqual(["many/f0.txt"]);
    expect(r.filesRead).toBe(4000);
    await put("lots.txt", `${`${AKIA}\n`.repeat(100)}`);
    expect((await scanWorkingTree(root, ["lots.txt"])).secrets).toHaveLength(60);
  });

  test("total byte budget stops reading", async () => {
    await put("t1.txt", "a".repeat(600));
    await put("t2.txt", "b".repeat(600));
    const r = await scanWorkingTree(root, ["t1.txt", "t2.txt"], { maxTotalBytes: 1000 });
    expect(r.filesRead).toBe(1);
    expect(r.truncated).toBe(true);
  });
});

describe("readSmallFile", () => {
  test("reads a regular file under the root, nothing else", async () => {
    await put("CLAUDE.md", "one two");
    expect(await readSmallFile(root, "CLAUDE.md", 1000)).toBe("one two");
    expect(await readSmallFile(root, "nope.md", 1000)).toBeNull();
    expect(await readSmallFile(root, "link.ts", 1000)).toBeNull();
    expect(await readSmallFile(root, "linkdir/x.ts", 1000)).toBeNull();
    expect(await readSmallFile(root, "CLAUDE.md", 3)).toBeNull();
    expect(await readSmallFile(root, "../x", 1000)).toBeNull();
  });
});

describe("tracked sensitive files vs source code, secrets in tests", () => {
  test("a never-read path with a code or doc extension gives no finding; keys and env still do", async () => {
    const r = await scanWorkingTree(root, ["src/credentials.ts", "docs/secrets.md", "tools/service-account.py", "deploy/.env", "keys/server.pem", "credentials.json", "infra/x.tfstate"]);
    expect(r.secrets.map((s) => s.file)).toEqual(["deploy/.env", "keys/server.pem", "credentials.json", "infra/x.tfstate"]);
    expect(r.secrets.every((s) => s.type === "tracked sensitive file" && s.severity === "high")).toBe(true);
  });

  test("a secret pattern inside a test file is medium, in source it stays high", async () => {
    await put("src/App.test.tsx", `const k = "${AKIA}";\n`);
    await put("pkg/__tests__/x.ts", `const k = "${AKIA}";\n`);
    await put("tests/fixtures/a.json", `{"k":"${AKIA}"}\n`);
    await put("src/real.ts", `const k = "${AKIA}";\n`);
    const r = await scanWorkingTree(root, ["src/App.test.tsx", "pkg/__tests__/x.ts", "tests/fixtures/a.json", "src/real.ts"]);
    const sev = Object.fromEntries(r.secrets.map((s) => [s.file, s.severity]));
    expect(sev).toEqual({ "src/App.test.tsx": "medium", "pkg/__tests__/x.ts": "medium", "tests/fixtures/a.json": "medium", "src/real.ts": "high" });
  });
});
