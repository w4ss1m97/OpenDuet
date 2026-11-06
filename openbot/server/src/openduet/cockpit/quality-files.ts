/*
 * The quality scan's only file reader: async, one file at a time, on the working tree of a project.
 * A file is read only when it is a plain file (no link, not behind a linked folder), small enough, not
 * binary, and not on the never-read list. Secrets leave here as file:line:type, never as text.
 */
import { constants } from "node:fs";
import { lstat, open as fsOpen, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { type FileStat, SAFE_ENV, codeStats, isTestFile } from "./quality-parse";
import type { SecretHit } from "./quality-parse";
import { findSecretLines, isNeverRead } from "./secrets";

export const MAX_FILES = 4000;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_HITS = 60;
const BINARY_CHECK_BYTES = 4096;
const YIELD_EVERY = 25;

export type FileDeps = { open?: typeof fsOpen };
export type ScanLimits = FileDeps & { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number };
export type TreeScan = { secrets: SecretHit[]; stats: FileStat[]; filesRead: number; truncated: boolean };

const underRoot = (rootReal: string, real: string) => real === rootReal || real.startsWith(rootReal + sep);
/** Source and docs: a name like credentials.ts is code about secrets, not a secret. Still never read. */
const SOURCE_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "swift", "kt", "java", "rb", "md"]);
const FIXTURE_DIRS = new Set(["fixtures", "__fixtures__", "__mocks__"]);
const isSourceName = (rel: string) => SOURCE_EXT.has(rel.slice(rel.lastIndexOf(".") + 1).toLowerCase()) && rel.lastIndexOf(".") > rel.lastIndexOf("/") + 1;
const inTests = (rel: string) => isTestFile(rel) || rel.split("/").slice(0, -1).some((p) => FIXTURE_DIRS.has(p));
const plainRel = (rel: string) => rel !== "" && !rel.includes("\0") && !rel.startsWith("/") && !rel.split("/").includes("..");

/** Reads the file when every guard passes; null otherwise (and for any error). */
async function guardedRead(root: string, rootReal: string, rel: string, maxBytes: number, open: typeof fsOpen, dirOk: Map<string, boolean>): Promise<{ buf: Buffer; size: number } | null> {
  if (!plainRel(rel)) return null;
  const full = join(root, rel);
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return null;
    const dir = dirname(full);
    let ok = dirOk.get(dir);
    if (ok === undefined) {
      ok = underRoot(rootReal, await realpath(dir));
      dirOk.set(dir, ok);
    }
    if (!ok) return null;
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buf = await handle.readFile();
      return buf.length > maxBytes ? null : { buf, size: info.size };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** A small project file (CLAUDE.md, .gitignore, a coverage report) as text, or null. */
export async function readSmallFile(root: string, rel: string, maxBytes: number, deps: FileDeps = {}): Promise<string | null> {
  try {
    const rootReal = await realpath(root);
    const got = await guardedRead(root, rootReal, rel, maxBytes, deps.open ?? fsOpen, new Map());
    return got ? got.buf.toString("utf8") : null;
  } catch {
    return null;
  }
}

/** Secrets and code statistics from the tracked files of a project, in one pass over at most 4,000 of them. */
export async function scanWorkingTree(root: string, rels: string[], limits: ScanLimits = {}): Promise<TreeScan> {
  const out: TreeScan = { secrets: [], stats: [], filesRead: 0, truncated: false };
  const open = limits.open ?? fsOpen;
  const maxFile = limits.maxFileBytes ?? MAX_FILE_BYTES;
  const maxTotal = limits.maxTotalBytes ?? MAX_TOTAL_BYTES;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return out;
  }
  const dirOk = new Map<string, boolean>();
  let total = 0;
  const considered = rels.slice(0, limits.maxFiles ?? MAX_FILES);
  for (let i = 0; i < considered.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const rel = considered[i]!;
    if (isNeverRead(rel)) {
      // Named, never opened. Templates such as .env.example are not findings.
      if (!SAFE_ENV.test(basename(rel)) && !isSourceName(rel) && out.secrets.length < MAX_HITS) {
        out.secrets.push({ file: rel, line: 0, type: "tracked sensitive file", severity: "high" });
      }
      continue;
    }
    const got = await guardedRead(root, rootReal, rel, maxFile, open, dirOk);
    if (!got) continue;
    if (total + got.size > maxTotal) {
      out.truncated = true;
      break;
    }
    total += got.size;
    out.filesRead++;
    if (got.buf.subarray(0, BINARY_CHECK_BYTES).includes(0)) continue;
    const text = got.buf.toString("utf8");
    for (const hit of findSecretLines(text)) {
      if (out.secrets.length >= MAX_HITS) break;
      // test fixtures hold fake keys on purpose: they are listed, never raised as attention
      out.secrets.push({ file: rel, line: hit.line, type: hit.type, severity: inTests(rel) ? "medium" : hit.severity });
    }
    const stat = codeStats(rel, text);
    if (stat) out.stats.push(stat);
  }
  return out;
}
