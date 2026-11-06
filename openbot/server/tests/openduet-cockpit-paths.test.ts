import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCockpitProjects,
  readNotesFile,
  safeSubpath,
} from "../src/openduet/cockpit/projects-file";

let root: string;
let home: string;
let outside: string;

function repo(dir: string) {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-paths-")));
  home = join(root, "home");
  outside = join(root, "outside");
  mkdirSync(home);
  mkdirSync(outside);
  repo(join(home, "good"));
  repo(join(home, "other"));
  repo(join(outside, "evil"));
  symlinkSync(join(outside, "evil"), join(home, "link-out"));
  mkdirSync(join(home, "plain")); // no .git
  writeFileSync(join(home, "afile"), "x");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const load = async (text: string) => {
  const file = join(root, "projects.txt");
  writeFileSync(file, text);
  return loadCockpitProjects({ file, home });
};

describe("loadCockpitProjects", () => {
  test("parses name|path|test, expands ~, ignores the test command and comments", async () => {
    const list = await load(`# c\n\nGood|${home}/good|npm test\nOther|${home}/other|\n`);
    expect(list.map((p) => p.name)).toEqual(["Good", "Other"]);
    expect(list[0]!.path).toBe(join(home, "good"));
  });

  test("~ is expanded against the given home", async () => {
    expect((await load("G|~/good|")).map((p) => p.name)).toEqual(["G"]);
  });

  test("bad lines are skipped, good ones kept", async () => {
    const list = await load(
      [
        "no-pipe-line",
        "|~/good|",
        `${"x".repeat(41)}|~/good|`,
        "bad;name|~/good|",
        "Rel|relative/path|",
        "NulName|~/go\0od|",
        "Missing|~/missing|",
        "File|~/afile|",
        "NoGit|~/plain|",
        "Ok|~/good|",
      ].join("\n"),
    );
    expect(list.map((p) => p.name)).toEqual(["Ok"]);
  });

  test("a symlink that leaves home is skipped", async () => {
    expect((await load("Link|~/link-out|\nOk|~/good|")).map((p) => p.name)).toEqual(["Ok"]);
  });

  test("a path outside home is skipped", async () => {
    expect(await load(`Out|${outside}/evil|`)).toEqual([]);
  });

  test("duplicate names and duplicate paths are dropped", async () => {
    const list = await load("A|~/good|\nA|~/other|\nB|~/good|\nC|~/other|");
    expect(list.map((p) => p.name)).toEqual(["A", "C"]);
  });

  test("a missing file gives an empty list", async () => {
    expect(await loadCockpitProjects({ file: join(root, "nope.txt"), home })).toEqual([]);
  });
});

describe("safeSubpath", () => {
  test("a real path inside the root is returned resolved", async () => {
    expect(await safeSubpath(home, join(home, "good"))).toBe(join(home, "good"));
  });
  test("outside, missing or dot-dot is null", async () => {
    expect(await safeSubpath(home, outside)).toBeNull();
    expect(await safeSubpath(home, join(home, "missing"))).toBeNull();
    expect(await safeSubpath(home, join(home, "good", "..", "..", "outside"))).toBeNull();
  });
  test("a symlink pointing out is null", async () => {
    expect(await safeSubpath(home, join(home, "link-out"))).toBeNull();
  });
  test("the root itself is allowed", async () => {
    expect(await safeSubpath(home, home)).toBe(home);
  });
});

describe("readNotesFile", () => {
  const proj = () => join(home, "good");
  test("reads a regular file", async () => {
    mkdirSync(join(proj(), ".claude"), { recursive: true });
    writeFileSync(join(proj(), ".claude", "session-notes.md"), "# T\n");
    const notes = await readNotesFile(proj());
    expect(notes?.text).toBe("# T\n");
    expect(typeof notes?.mtime).toBe("number");
  });
  test("a notes symlink pointing outside gives null", async () => {
    const p = join(home, "other");
    mkdirSync(join(p, ".claude"), { recursive: true });
    writeFileSync(join(outside, "secret.md"), "secret");
    symlinkSync(join(outside, "secret.md"), join(p, ".claude", "session-notes.md"));
    expect(await readNotesFile(p)).toBeNull();
  });
  test("missing notes give null", async () => {
    expect(await readNotesFile(join(home, "plain"))).toBeNull();
  });
  test("more than 64 KiB gives null", async () => {
    const p = join(home, "plain");
    mkdirSync(join(p, ".claude"), { recursive: true });
    writeFileSync(join(p, ".claude", "session-notes.md"), "a".repeat(64 * 1024 + 1));
    expect(await readNotesFile(p)).toBeNull();
  });
});

describe("event loop stays free", () => {
  // A FIFO with no writer blocks open(2) forever: a synchronous read would freeze the whole process
  // (as macOS does while it waits for a privacy answer); an async read only parks one libuv worker.
  test("a hung read of the projects file does not block timers", async () => {
    const fifo = join(root, "hung.fifo");
    execFileSync("mkfifo", [fifo]);
    let release: (() => void) | undefined;
    try {
      const pending = loadCockpitProjects({ file: fifo, home });
      const started = Date.now();
      const tick = await new Promise<number>((resolve) => setTimeout(() => resolve(Date.now() - started), 20));
      expect(tick).toBeLessThan(200);
      // open a writer so the pending read can finish and the worker is released
      const { openSync, closeSync } = await import("node:fs");
      release = () => closeSync(openSync(fifo, "w"));
      release();
      expect(await pending).toEqual([]);
    } finally {
      rmSync(fifo, { force: true });
    }
  });
});
