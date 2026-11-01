import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { COCKPIT_DATA_DIR } from "./usage-prices";
import type { SessionMeta, UsageRow, UsageStore } from "./usage-types";

/** Where the one-time Cockpit import writes; the server only reads it. */
export const USAGE_HISTORY_PATH = join(COCKPIT_DATA_DIR, "usage-history.json");

const count = z.number().int().min(0);
const historySchema = z.object({
  version: z.literal(1),
  rows: z.array(
    z.object({
      day: z.string(), hour: z.number().int().min(0).max(23), session: z.string(), model: z.string(), agent: z.string(), agentId: z.string(),
      input: count, cw5: count, cw1h: count, cr: count, output: count, requests: count,
    }),
  ),
  sessions: z.record(
    z.string(),
    z.object({ id: z.string(), name: z.string().nullable(), dir: z.string(), cwd: z.string().nullable(), project: z.string(), first: z.number(), last: z.number() }),
  ),
});

export type UsageHistory = z.infer<typeof historySchema>;

/** The history file; missing is no history, unreadable or invalid is no history with a note. */
export async function loadHistory(path: string = USAGE_HISTORY_PATH): Promise<{ history: UsageHistory | null; note: string | null }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { history: null, note: (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "usage history could not be read; ignored" };
  }
  try {
    const parsed = historySchema.safeParse(JSON.parse(text));
    if (parsed.success) return { history: parsed.data, note: null };
  } catch {
    // same answer as an invalid shape
  }
  return { history: null, note: "usage history was invalid; ignored" };
}

/** A copy of the store with the history's rows and sessions added (never written back). A live session of the same id wins. */
export function mergeHistory(store: UsageStore, history: UsageHistory | null): UsageStore {
  if (!history) return store;
  const rows: Record<string, UsageRow> = {};
  for (const r of history.rows) rows[`${r.day}|${r.hour}|${r.session}|${r.model}|${r.agent}|${r.agentId}`] = r;
  const sessions: Record<string, SessionMeta> = {};
  for (const [id, s] of Object.entries(history.sessions)) sessions[id] = { id: s.id, name: s.name, dir: s.dir, cwd: s.cwd ?? "", first: s.first, last: s.last, label: s.project };
  return { ...store, rows: { ...rows, ...store.rows }, sessions: { ...sessions, ...store.sessions } };
}
