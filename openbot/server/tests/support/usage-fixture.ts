import { DEFAULT_CONFIG } from "../../src/openduet/cockpit/usage-prices";
import { emptyStore, rowKey } from "../../src/openduet/cockpit/usage-store";
import type { UsageConfig, UsageRow, UsageStore } from "../../src/openduet/cockpit/usage-types";

export const HOME = "/Users/me";
export const PROJECTS = [{ name: "Alpha", path: "/Users/me/alpha" }];

/** A row with every count zero unless given. */
export function row(over: Partial<UsageRow> = {}): UsageRow {
  return { day: "2026-10-28", hour: 10, session: "s1", model: "sonnet-4-5", agent: "main", agentId: "", input: 0, cw5: 0, cw1h: 0, cr: 0, output: 0, requests: 0, ...over };
}

/** A store holding these rows and sessions (a session is `[id, dir, cwd, name?]`). */
export function storeWith(rows: UsageRow[], sessions: Array<[string, string, string, (string | null)?]> = []): UsageStore {
  const store = emptyStore();
  for (const r of rows) store.rows[rowKey(r)] = r;
  for (const [id, dir, cwd, name] of sessions) store.sessions[id] = { id, name: name ?? null, dir, cwd, first: 1, last: 2 };
  return store;
}

export const config = (over: Partial<UsageConfig> = {}): UsageConfig => ({ ...DEFAULT_CONFIG, ...over });
