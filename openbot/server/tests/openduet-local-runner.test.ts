import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localHostRunner } from "../src/openduet/items/local-runner";

/** The local runner runs three read-only shapes of command and refuses everything else. */

const run = localHostRunner();

test("refuses a command outside the allow-list", async () => {
  expect(await run("rm -rf ~")).toEqual({ ok: false, error: "Commande non autorisée." });
  expect(await run("cat /etc/passwd; rm x")).toEqual({ ok: false, error: "Commande non autorisée." });
  expect(await run("osascript -e 'tell app \"Finder\" to quit'")).toEqual({ ok: false, error: "Commande non autorisée." });
});

test("cat reads a session-notes file and nothing else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "duet-"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude/session-notes.md"), "## Exact next step\nShip");
  expect(await run(`cat ${dir}/.claude/session-notes.md`)).toEqual({ ok: true, output: "## Exact next step\nShip" });
  expect((await run(`cat ${dir}/secret.txt`)).ok).toBe(false);
});

test("a missing notes file is an error, not empty output", async () => {
  expect((await run("cat /nonexistent-duet/.claude/session-notes.md")).ok).toBe(false);
});

test("git log reads the last commit subject of a repository", async () => {
  const repo = join(import.meta.dir, "../..");
  const result = await run(`git -C ${repo} log -1 --format=%s`);
  expect(result.ok).toBe(true);
  expect(result.output?.length).toBeGreaterThan(0);
});
