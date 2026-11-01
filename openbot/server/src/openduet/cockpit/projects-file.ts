import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { CockpitProject } from "./types";

const NAME = /^[\w .-]{1,40}$/;
const MAX_NOTES_BYTES = 64 * 1024;

/** Where the project list lives: `name|path|test command`, one per line (the test command is ignored). */
export const PROJECTS_FILE = join(homedir(), ".claude", "cockpit-projects.txt");

/** The real path of `candidate` when it exists and lies inside the real path of `root`; null otherwise. */
export function safeSubpath(root: string, candidate: string): string | null {
  if (candidate.includes("\0") || root.includes("\0")) return null;
  try {
    const base = realpathSync(root);
    const real = realpathSync(candidate.startsWith("/") ? candidate : join(root, candidate));
    return real === base || real.startsWith(base + sep) ? real : null;
  } catch {
    return null;
  }
}

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The projects in the list file that are safe to read: a valid name, an absolute path (`~` expanded)
 * whose real path is a git checkout inside the real home. Bad lines and repeats are skipped.
 */
export function loadCockpitProjects(
  options: { file?: string; home?: string } = {},
): CockpitProject[] {
  const home = options.home ?? homedir();
  let text: string;
  try {
    text = readFileSync(options.file ?? PROJECTS_FILE, "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  const projects: CockpitProject[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|");
    if (parts.length < 2) continue;
    const name = parts[0]!.trim();
    let path = parts[1]!.trim();
    if (!NAME.test(name) || path.includes("\0")) continue;
    if (path === "~" || path.startsWith("~/")) path = join(home, path.slice(1));
    if (!path.startsWith("/")) continue;
    const real = safeSubpath(home, path);
    if (!real || !isDirectory(join(real, ".git"))) continue;
    if (names.has(name) || paths.has(real)) continue;
    names.add(name);
    paths.add(real);
    projects.push({ name, path: real });
  }
  return projects;
}

/** The project's session notes: a regular file (not a link) inside the project, at most 64 KiB. */
export function readNotesFile(projectPath: string): { text: string; mtime: number } | null {
  try {
    const file = join(projectPath, ".claude", "session-notes.md");
    const info = lstatSync(file);
    if (!info.isFile() || info.size > MAX_NOTES_BYTES) return null;
    if (!safeSubpath(projectPath, file)) return null;
    return { text: readFileSync(file, "utf8"), mtime: info.mtimeMs / 1000 };
  } catch {
    return null;
  }
}

/** Where Claude Code writes one JSON file per running session. */
export const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

/** `*.json` files in a directory, never the `*.key` ones next to them. */
export function sessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}
