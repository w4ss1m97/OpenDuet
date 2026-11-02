import { type FileHandle, lstat, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { classifyPath, parseUsageLine } from "./usage-parse";
import { USAGE_STORE_PATH, addToRow, emptyStore, loadStore, saveStore } from "./usage-store";
import type { UsageStatus, UsageStore } from "./usage-types";

/** Where Claude Code writes its transcripts. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

const READ_BYTES = 1 << 20;
const MAX_LINE_BYTES = 16 << 20;
const TAIL_SIZE = 64;
const SAVE_EVERY = 25;
const META_MAX_BYTES = 64 * 1024;
const DEFAULT_TZ = "Europe/Paris";

export type UsageIngest = {
  /** Resolves once the saved store is loaded (never waits for a backfill). */
  ready(): Promise<void>;
  /** Reads what was appended to every transcript; callers during a pass share it. Never rejects. */
  runOnce(): Promise<void>;
  store(): UsageStore;
  status(): UsageStatus;
};

const metaSchema = z.object({ agentType: z.string().max(60).optional(), description: z.string().max(5000).optional() });

type Candidate = { path: string; mtimeMs: number; size: number; ino: number };

async function subdirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Regular `.jsonl` transcripts under the projects folder; symlinks are never followed. */
async function listTranscripts(root: string): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const add = async (path: string) => {
    if (!classifyPath(root, path)) return;
    try {
      const info = await lstat(path);
      if (info.isFile()) found.push({ path, mtimeMs: info.mtimeMs, size: info.size, ino: info.ino });
    } catch {
      // vanished while listing
    }
  };
  for (const dir of await subdirs(root)) {
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) await add(join(root, dir, e.name));
      else if (e.isDirectory()) {
        try {
          for (const sub of await readdir(join(root, dir, e.name, "subagents"), { withFileTypes: true })) {
            if (sub.isFile() && sub.name.startsWith("agent-") && sub.name.endsWith(".jsonl")) await add(join(root, dir, e.name, "subagents", sub.name));
          }
        } catch {
          // no subagents folder
        }
      }
    }
  }
  return found;
}

async function readMeta(path: string): Promise<{ agent: string; description: string }> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > META_MAX_BYTES) return { agent: "subagent", description: "" };
    const parsed = metaSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    if (!parsed.success) return { agent: "subagent", description: "" };
    return { agent: parsed.data.agentType || "subagent", description: (parsed.data.description ?? "").slice(0, 200) };
  } catch {
    return { agent: "subagent", description: "" };
  }
}

/**
 * Calls `onLine` for each full line from `offset`, reading 1 MiB at a time. A line over `maxLine` bytes is
 * dropped (counted in `skipped` once it ends). Returns the offset just past the last full line.
 */
async function readLines(handle: FileHandle, offset: number, size: number, maxLine: number, onLine: (line: string) => void, skipped: { n: number }): Promise<number> {
  const buffer = Buffer.alloc(READ_BYTES);
  let pos = offset;
  let consumed = offset;
  let carry: Buffer[] = [];
  let carryLen = 0;
  let dropping = false;
  while (pos < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_BYTES, size - pos), pos);
    if (bytesRead === 0) break;
    const filled = buffer.subarray(0, bytesRead);
    let start = 0;
    while (start < bytesRead) {
      const nl = filled.indexOf(10, start);
      const end = nl < 0 ? bytesRead : nl;
      const len = end - start;
      if (!dropping) {
        if (carryLen + len > maxLine) {
          dropping = true;
          carry = [];
        } else {
          carry.push(Buffer.from(buffer.subarray(start, end)));
          carryLen += len;
        }
      }
      if (nl < 0) break;
      if (dropping) skipped.n += 1;
      else if (carryLen > 0) onLine(Buffer.concat(carry).toString("utf8"));
      consumed = pos + nl + 1;
      carry = [];
      carryLen = 0;
      dropping = false;
      start = nl + 1;
    }
    pos += bytesRead;
  }
  return consumed;
}

/** Reads Claude Code transcripts into a store that is saved to disk; everything the disk offers is async and the folder is only read. */
export function createUsageIngest(options: {
  projectsDir?: string;
  storePath?: string;
  tz?: string;
  maxLineBytes?: number;
} = {}): UsageIngest {
  const root = options.projectsDir ?? CLAUDE_PROJECTS_DIR;
  const storePath = options.storePath ?? USAGE_STORE_PATH;
  const tz = options.tz ?? DEFAULT_TZ;
  const maxLine = options.maxLineBytes ?? MAX_LINE_BYTES;
  let store = emptyStore();
  const status: UsageStatus = { backfilling: false, filesDone: 0, filesTotal: 0, skippedLines: 0, lastError: null };
  let loading: Promise<void> | null = null;
  let running: Promise<void> | null = null;

  const ready = () =>
    (loading ??= loadStore(storePath).then((loaded) => {
      store = loaded.store;
      if (loaded.error) status.lastError = loaded.error;
    }));

  async function ingestFile(file: Candidate): Promise<void> {
    const where = classifyPath(root, file.path);
    if (!where) return;
    const known = store.files[file.path];
    if (known && (known.ino !== file.ino || file.size < known.offset)) {
      // Rewritten or replaced: what is there now is not new, so never recount it.
      store.files[file.path] = { offset: file.size, size: file.size, ino: file.ino, tail: [] };
      return;
    }
    const offset = known?.offset ?? 0;
    if (file.size === offset) {
      if (known) known.size = file.size;
      else store.files[file.path] = { offset, size: file.size, ino: file.ino, tail: [] };
      return;
    }
    const meta = where.metaPath ? await readMeta(where.metaPath) : null;
    const agent = meta?.agent ?? "main";
    const seen = new Map<string, number>(known?.tail ?? []);
    const rows: UsageStore["rows"] = {};
    let title: string | null = null;
    let cwd = "";
    let first = Number.POSITIVE_INFINITY;
    let last = 0;
    const skipped = { n: 0 };
    const handle = await open(file.path, "r");
    let end: number;
    try {
      end = await readLines(handle, offset, file.size, maxLine, (line) => {
        const parsed = parseUsageLine(line, tz);
        if (!parsed) return;
        if (parsed.kind === "title") {
          if (agent === "main") title = parsed.title;
          return;
        }
        let tok = { ...parsed.tok, requests: 1 };
        if (parsed.id !== null && seen.has(parsed.id)) {
          const before = seen.get(parsed.id)!;
          seen.set(parsed.id, Math.max(before, parsed.tok.output));
          tok = { input: 0, cw5: 0, cw1h: 0, cr: 0, output: Math.max(0, parsed.tok.output - before), requests: 0 };
        } else if (parsed.id !== null) {
          seen.set(parsed.id, parsed.tok.output);
          if (seen.size > TAIL_SIZE) seen.delete(seen.keys().next().value as string);
        }
        addToRow(rows, { day: parsed.day, hour: parsed.hour, session: where.session, model: parsed.model, agent, agentId: where.agentId }, tok);
        if (!cwd) cwd = parsed.cwd;
        first = Math.min(first, parsed.t);
        last = Math.max(last, parsed.t);
      }, skipped);
    } finally {
      await handle.close();
    }
    // Merged only now: a failure above leaves the offset and the counts as they were.
    for (const row of Object.values(rows)) addToRow(store.rows, row, row);
    status.skippedLines += skipped.n;
    if (where.metaPath && meta) {
      store.subagents[`${where.session}|${where.agentId}`] = { session: where.session, agentId: where.agentId, agent: meta.agent, description: meta.description };
    }
    const session = store.sessions[where.session];
    if (session) {
      if (!session.cwd) session.cwd = cwd;
      if (title) session.name = title;
      if (last) {
        session.first = Math.min(session.first || first, first);
        session.last = Math.max(session.last, last);
      }
    } else if (last || title) {
      store.sessions[where.session] = { id: where.session, name: title, dir: where.dir, cwd, first: last ? first : 0, last };
    }
    store.files[file.path] = { offset: end, size: file.size, ino: file.ino, tail: [...seen.entries()] };
  }

  async function pass(): Promise<void> {
    await ready();
    const files = await listTranscripts(root);
    const todo = files.filter((f) => store.files[f.path]?.offset !== f.size || store.files[f.path]?.ino !== f.ino).sort((a, b) => b.mtimeMs - a.mtimeMs);
    status.backfilling = Object.keys(store.files).length === 0 && todo.length > 3;
    status.filesTotal = todo.length;
    status.filesDone = 0;
    let unsaved = 0;
    const save = async () => {
      try {
        await saveStore(storePath, store);
        unsaved = 0;
      } catch (error) {
        status.lastError = `usage store could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    for (const file of todo) {
      try {
        await ingestFile(file);
        unsaved += 1;
      } catch (error) {
        status.lastError = `${basename(file.path)}: ${error instanceof Error ? error.message : String(error)}`;
      }
      status.filesDone += 1;
      if (unsaved >= SAVE_EVERY) await save();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (unsaved > 0) await save();
    status.backfilling = false;
  }

  return {
    ready,
    runOnce() {
      if (running) return running;
      const current = pass()
        .catch((error: unknown) => {
          status.lastError = error instanceof Error ? error.message : String(error);
          status.backfilling = false;
        })
        .finally(() => {
          running = null;
        });
      running = current;
      return current;
    },
    store: () => store,
    status: () => ({ ...status }),
  };
}
