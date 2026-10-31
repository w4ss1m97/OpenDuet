import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { HostRunner } from "./notes-scanner";
import { NOTES_JXA, NOTES_OSASCRIPT } from "./notes-scanner";

/**
 * Reads the Mac's own sources when the server runs on that Mac. The desktop bridge cannot: its
 * commands run in an offline Linux container, where neither Notes nor the person's home exists.
 *
 * NOT A SHELL. Three read-only shapes are recognised and run as argv, never through a shell: the
 * fixed Notes script, `cat <path>/.claude/session-notes.md`, and `git -C <path> log -1 --format=%s`.
 * Anything else is refused. Off unless OPENDUET_LOCAL_SOURCES=1 on macOS (see index.ts).
 */

const PATH = "([~\\w./-]+)";
const CAT_NOTES = new RegExp(`^cat ${PATH}/\\.claude/session-notes\\.md$`);
const GIT_LAST = new RegExp(`^git -C ${PATH} log -1 --format=%s$`);
const REFUSED = { ok: false, error: "Commande non autorisée." } as const;

function expand(path: string): string {
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

async function spawn(argv: string[]): Promise<{ ok: boolean; output?: string; error?: string }> {
  // Killed when a macOS permission prompt or an unmounted volume would keep it waiting.
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: 60_000, killSignal: "SIGKILL" });
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return code === 0
    ? { ok: true, output: output.trim() }
    : { ok: false, error: error.trim() || `exit ${code}` };
}

export function localHostRunner(): HostRunner {
  return async (command) => {
    try {
      if (command === NOTES_OSASCRIPT)
        return await spawn(["osascript", "-l", "JavaScript", "-e", NOTES_JXA]);
      const notes = command.match(CAT_NOTES)?.[1];
      if (notes && !notes.includes(".."))
        return { ok: true, output: await readFile(`${expand(notes)}/.claude/session-notes.md`, {
          encoding: "utf8",
          signal: AbortSignal.timeout(10_000),
        }) };
      const repo = command.match(GIT_LAST)?.[1];
      if (repo && !repo.includes(".."))
        return await spawn(["git", "-C", expand(repo), "log", "-1", "--format=%s"]);
      return REFUSED;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
