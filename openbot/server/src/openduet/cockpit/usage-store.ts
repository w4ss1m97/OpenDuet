import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { COCKPIT_DATA_DIR } from "./usage-prices";
import type { Tok, UsageRow, UsageStore } from "./usage-types";

/** Where the store lives unless a caller injects another place. */
export const USAGE_STORE_PATH = join(COCKPIT_DATA_DIR, "usage-store.json");

/** A store with nothing in it. */
export function emptyStore(): UsageStore {
  return { version: 1, files: {}, rows: {}, sessions: {}, subagents: {} };
}

const count = z.number().int().min(0);
const storeSchema = z.object({
  version: z.literal(1),
  files: z.record(z.string(), z.object({ offset: count, size: count, ino: z.number(), tail: z.array(z.tuple([z.string(), count])).max(64) })),
  rows: z.record(
    z.string(),
    z.object({
      day: z.string(), hour: z.number().int().min(0).max(23), session: z.string(), model: z.string(), agent: z.string(), agentId: z.string(),
      input: count, cw5: count, cw1h: count, cr: count, output: count, requests: count,
    }),
  ),
  sessions: z.record(z.string(), z.object({ id: z.string(), name: z.string().nullable(), dir: z.string(), cwd: z.string(), first: z.number(), last: z.number() })),
  subagents: z.record(z.string(), z.object({ session: z.string(), agentId: z.string(), agent: z.string(), description: z.string() })),
});

/** The saved store; a missing file is an empty store, an unreadable or invalid one is empty with the reason. */
export async function loadStore(path: string = USAGE_STORE_PATH): Promise<{ store: UsageStore; error: string | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { store: emptyStore(), error: null }
      : { store: emptyStore(), error: "usage store could not be read; rebuilding it" };
  }
  try {
    const parsed = storeSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { store: parsed.data, error: null };
  } catch {
    // falls through to the same answer as an invalid shape
  }
  return { store: emptyStore(), error: "usage store was invalid; rebuilding it" };
}

/** Writes the store next to its final name (file 0600, folder 0700), then renames it over: a reader never sees half a file. */
export async function saveStore(path: string, store: UsageStore): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(store));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export const rowKey = (r: Pick<UsageRow, "day" | "hour" | "session" | "model" | "agent" | "agentId">) =>
  `${r.day}|${r.hour}|${r.session}|${r.model}|${r.agent}|${r.agentId}`;

/** Adds tokens to the row for these coordinates, creating it when it is new. */
export function addToRow(rows: Record<string, UsageRow>, at: Pick<UsageRow, "day" | "hour" | "session" | "model" | "agent" | "agentId">, tok: Tok): void {
  const key = rowKey(at);
  const row = rows[key] ?? (rows[key] = { ...at, input: 0, cw5: 0, cw1h: 0, cr: 0, output: 0, requests: 0 });
  row.input += tok.input;
  row.cw5 += tok.cw5;
  row.cw1h += tok.cw1h;
  row.cr += tok.cr;
  row.output += tok.output;
  row.requests += tok.requests;
}
