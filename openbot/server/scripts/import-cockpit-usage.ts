/**
 * One-time import of Cockpit's older usage history (runner-dashboard/usage.db, opened read-only) into
 * ~/.config/openduet/cockpit/usage-history.json. Rows before the first day the live store knows become
 * synthetic per-project sessions. The server reads that file; it never touches usage-store.json from here.
 *
 *   bun scripts/import-cockpit-usage.ts [--db <path>] [--out <path>] [--before YYYY-MM-DD] [--dry-run]
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { USAGE_HISTORY_PATH, type UsageHistory } from "../src/openduet/cockpit/usage-history";
import { USAGE_STORE_PATH } from "../src/openduet/cockpit/usage-store";

export const COCKPIT_DB_PATH = join(homedir(), "Desktop", "runner-dashboard", "usage.db");

export type ImportResult = { before: string; rows: number; sessions: number; firstDay: string | null; lastDay: string | null; written: boolean };

const slug = (project: string) => project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The first day with a row in the live store file, or null when there is none. */
export function firstLiveDay(storePath: string): string | null {
  if (!existsSync(storePath)) return null;
  const rows = Object.values((JSON.parse(readFileSync(storePath, "utf8")).rows ?? {}) as Record<string, { day: string }>);
  return rows.reduce<string | null>((min, r) => (min === null || r.day < min ? r.day : min), null);
}

type DbRow = { day: string; hour: number; project: string | null; model: string; agent: string; agent_id: string | null; input: number; cw5: number; cw1h: number; cr: number; output: number; requests: number };

/** Read-only; a WAL database with no -shm file cannot be opened that way by Bun, so retry as an immutable snapshot (still read-only). */
function openReadOnly(path: string): Database {
  try {
    const db = new Database(path, { readonly: true });
    db.query("select 1 from usage limit 1").get();
    return db;
  } catch {
    return new Database(`file:${encodeURI(path)}?mode=ro&immutable=1`);
  }
}

/** Reads the days strictly before `before` and (unless dry-run) writes the history file atomically (file 0600, folder 0700). */
export function importHistory(options: { db: string; out: string; before: string; dryRun?: boolean; projectPaths?: Record<string, string> }): ImportResult {
  const db = openReadOnly(options.db);
  let found: DbRow[];
  try {
    found = db.query("select day, hour, project, model, agent, agent_id, input, cw5, cw1h, cr, output, requests from usage where day < ? order by day, hour").all(options.before) as DbRow[];
  } finally {
    db.close();
  }
  const history: UsageHistory = { version: 1, rows: [], sessions: {} };
  const merged = new Map<string, UsageHistory["rows"][number]>();
  for (const r of found) {
    const project = r.project || "(unknown)";
    const session = `history-${slug(project)}`;
    const key = `${r.day}|${r.hour}|${session}|${r.model}|${r.agent}|${r.agent_id ?? ""}`;
    const row = merged.get(key) ?? { day: r.day, hour: r.hour, session, model: r.model, agent: r.agent, agentId: r.agent_id ?? "", input: 0, cw5: 0, cw1h: 0, cr: 0, output: 0, requests: 0 };
    for (const f of ["input", "cw5", "cw1h", "cr", "output", "requests"] as const) row[f] += r[f] ?? 0;
    merged.set(key, row);
    const meta = history.sessions[session];
    const t = dayMs(r.day);
    if (meta) {
      meta.first = Math.min(meta.first, t);
      meta.last = Math.max(meta.last, t);
    } else {
      history.sessions[session] = { id: session, name: `${project} (Cockpit history)`, dir: "", cwd: options.projectPaths?.[project] ?? null, project, first: t, last: t };
    }
  }
  history.rows = [...merged.values()];
  const days = history.rows.map((r) => r.day).sort();
  const result: ImportResult = { before: options.before, rows: history.rows.length, sessions: Object.keys(history.sessions).length, firstDay: days[0] ?? null, lastDay: days.at(-1) ?? null, written: false };
  if (options.dryRun) return result;
  const dir = dirname(options.out);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = `${options.out}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(history), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, options.out);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { ...result, written: true };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const before = flag("--before") ?? firstLiveDay(USAGE_STORE_PATH);
  if (!before || !/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    console.error("No usage-store.json to find the cut-off day in: pass --before YYYY-MM-DD");
    process.exit(1);
  }
  const result = importHistory({ db: flag("--db") ?? COCKPIT_DB_PATH, out: flag("--out") ?? USAGE_HISTORY_PATH, before, dryRun: args.includes("--dry-run") });
  console.log(JSON.stringify(result));
}
