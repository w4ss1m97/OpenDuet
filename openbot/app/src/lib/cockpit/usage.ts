import { queryOptions } from "@tanstack/react-query";
import { BASE, read } from "./queries";

/*
 * Usage (C2): Claude Code tokens and API-equivalent cost read from the transcripts on this Mac, served by
 * the cockpit server on 127.0.0.1. Types mirror server/src/openduet/cockpit/usage-types.ts and usage-query.ts.
 * Days and hours are Europe/Paris. Tokens leave out cache reads; cost is what the API would have charged.
 */

export type Tok = {
  input: number;
  cw5: number;
  cw1h: number;
  cr: number;
  output: number;
  requests: number;
};
export type Priced = Tok & { cost: number; tokens: number };
export type DayRow = Priced & {
  day: string;
  project: string;
  model: string;
  agent: string;
};
export type HourRow = Priced & {
  day: string;
  hour: number;
  project: string;
  model: string;
};
export type SessionDayRow = Priced & {
  day: string;
  session: string;
  project: string;
  model: string;
};
export type UsageSession = {
  id: string;
  name: string | null;
  project: string;
  mainRequests: number;
  mainOpusRequests: number;
  subagents: number;
  first: string;
  last: string;
};
export type UsageFlag = {
  session: string;
  sessionName: string | null;
  agent: string;
  description: string;
  model: string;
  cost: number;
  requests: number;
};
export type UsageStatus = {
  backfilling: boolean;
  filesDone: number;
  filesTotal: number;
  skippedLines: number;
  lastError: string | null;
};
export type UsageReport = {
  from: string;
  to: string;
  days: DayRow[];
  hours: HourRow[];
  sessionDays: SessionDayRow[];
  sessions: UsageSession[];
  flags: UsageFlag[];
  burnPerHour: number;
  unknownModels: string[];
  firstDay: string | null;
  status: UsageStatus;
  configError: string | null;
};
export type SessionDetail = {
  id: string;
  name: string | null;
  project: string;
  /** Milliseconds since the epoch. */
  first: number;
  last: number;
  days: Array<Priced & { day: string; model: string; agent: string }>;
  agents: Array<
    Priced & {
      agentId: string;
      agent: string;
      model: string;
      description: string;
    }
  >;
};
export type BudgetState = {
  scope: string;
  unit: "usd" | "tokens";
  limit: number;
  used: number;
  /** A fraction: 0.5 is half. */
  pct: number;
};
export type BudgetReport = {
  weekStart: string;
  budgetPercent: number;
  budgets: BudgetState[];
  configError: string | null;
};
export type AdvisorTip = {
  key: string;
  kind: string;
  project: string;
  link: string;
  title: string;
  detail: string;
  numbers: Record<string, number>;
  saving: number | null;
};
export type AdvisorReport = {
  tips: AdvisorTip[];
  totalSaving: number;
  configError: string | null;
};

export type CsvView = "days" | "sessions" | "models" | "agents";
export type Range = { from: string; to: string };

export const usageKeys = {
  report: (r: Partial<Range>) => ["cockpit", "usage", r.from, r.to] as const,
  session: (id: string) => ["cockpit", "usage", "session", id] as const,
  budgets: ["cockpit", "usage", "budgets"] as const,
  advisor: ["cockpit", "usage", "advisor"] as const,
};

const REFRESH_MS = 30_000;
const query = (r: Partial<Range>) => {
  const p = new URLSearchParams();
  if (r.from) p.set("from", r.from);
  if (r.to) p.set("to", r.to);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const usageQueryOptions = (r: Partial<Range>) =>
  queryOptions({
    queryKey: usageKeys.report(r),
    queryFn: ({ signal }): Promise<UsageReport> =>
      read(`/api/cockpit/usage${query(r)}`, signal),
    // Faster while the first import runs, so the progress banner moves.
    refetchInterval: (q) =>
      q.state.data?.status.backfilling ? 3_000 : REFRESH_MS,
    retry: false,
  });

export const usageSessionQueryOptions = (id: string) =>
  queryOptions({
    queryKey: usageKeys.session(id),
    queryFn: ({ signal }): Promise<SessionDetail> =>
      read(`/api/cockpit/usage/sessions/${encodeURIComponent(id)}`, signal),
    refetchInterval: REFRESH_MS,
    retry: false,
  });

export const usageBudgetsQueryOptions = () =>
  queryOptions({
    queryKey: usageKeys.budgets,
    queryFn: ({ signal }): Promise<BudgetReport> =>
      read("/api/cockpit/usage/budgets", signal),
    refetchInterval: REFRESH_MS,
    retry: false,
  });

export const usageAdvisorQueryOptions = () =>
  queryOptions({
    queryKey: usageKeys.advisor,
    queryFn: ({ signal }): Promise<AdvisorReport> =>
      read("/api/cockpit/usage/advisor", signal),
    refetchInterval: REFRESH_MS,
    retry: false,
  });

/* ---------- ranges ---------- */

const DAY_MS = 86_400_000;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const shiftDay = (day: string, days: number) =>
  new Date(dayMs(day) + days * DAY_MS).toISOString().slice(0, 10);

/** Today in Paris, as YYYY-MM-DD. */
export function parisToday(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The last `n` Paris days, today included. */
export function lastDays(n: number, now = Date.now()): Range {
  const to = parisToday(now);
  return { from: shiftDay(to, -(n - 1)), to };
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from, i = 0; d <= to && i < 400; d = shiftDay(d, 1), i++) {
    out.push(d);
  }
  return out;
}

/* ---------- pivots ---------- */

export type Pivot = {
  days: string[];
  /** Series names, biggest total first. */
  keys: string[];
  cells: Record<string, Record<string, number>>;
  dayTotals: Record<string, number>;
  keyTotals: Record<string, number>;
  total: number;
};

/** Cost per day, split by `model` or `project`. Days with no spend are kept when a range is given. */
export function pivotDaily(
  rows: ReadonlyArray<{
    day: string;
    project: string;
    model: string;
    cost: number;
  }>,
  by: "model" | "project",
  range?: Range,
): Pivot {
  const cells: Pivot["cells"] = {};
  const dayTotals: Pivot["dayTotals"] = {};
  const keyTotals: Pivot["keyTotals"] = {};
  let total = 0;
  for (const r of rows) {
    const key = r[by];
    const day = cells[r.day] ?? {};
    cells[r.day] = day;
    day[key] = (day[key] ?? 0) + r.cost;
    dayTotals[r.day] = (dayTotals[r.day] ?? 0) + r.cost;
    keyTotals[key] = (keyTotals[key] ?? 0) + r.cost;
    total += r.cost;
  }
  const days = range
    ? daysBetween(range.from, range.to)
    : Object.keys(cells).sort();
  for (const d of days) {
    cells[d] ??= {};
    dayTotals[d] ??= 0;
  }
  const keys = Object.keys(keyTotals).sort(
    (a, b) => (keyTotals[b] ?? 0) - (keyTotals[a] ?? 0) || a.localeCompare(b),
  );
  return { days, keys, cells, dayTotals, keyTotals, total };
}

/** Monday 0 .. Sunday 6, for a YYYY-MM-DD (which already is a Paris day). */
export function weekdayIndex(day: string): number {
  return (new Date(dayMs(day)).getUTCDay() + 6) % 7;
}

/** A 7 x 24 grid (weekday x Paris hour) of cost. Every cell exists, zero when nothing was spent. */
export function hourHeatmap(
  rows: ReadonlyArray<{ day: string; hour: number; cost: number }>,
): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of rows) {
    if (!Number.isInteger(r.hour) || r.hour < 0 || r.hour > 23) continue;
    const row = grid[weekdayIndex(r.day)];
    if (row) row[r.hour] = (row[r.hour] ?? 0) + r.cost;
  }
  return grid;
}

export type Total = { cost: number; tokens: number; requests: number };
const zero = (): Total => ({ cost: 0, tokens: 0, requests: 0 });

export function totalOf(rows: ReadonlyArray<Total>): Total {
  const t = zero();
  for (const r of rows) {
    t.cost += r.cost;
    t.tokens += r.tokens;
    t.requests += r.requests;
  }
  return t;
}

/** Sum rows by a key, biggest cost first. */
export function groupTotals<T extends Total>(
  rows: ReadonlyArray<T>,
  key: (row: T) => string,
): Array<{ key: string } & Total> {
  const map = new Map<string, Total>();
  for (const r of rows) {
    const k = key(r);
    const t = map.get(k) ?? zero();
    t.cost += r.cost;
    t.tokens += r.tokens;
    t.requests += r.requests;
    map.set(k, t);
  }
  return [...map]
    .map(([key, t]) => ({ key, ...t }))
    .sort((a, b) => b.cost - a.cost);
}

export function usd(n: number): string {
  return `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;
}

export function compact(n: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

/* ---------- advisor dismissals ---------- */

export const DISMISS_KEY = "duet.cockpit.usage.dismissed";
export const DISMISS_MS = 7 * DAY_MS;

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/** Tip key -> when it was dismissed (ms). Anything unreadable or older than 7 days is dropped. */
export function loadDismissed(
  store: KeyValueStore | null,
  now = Date.now(),
): Record<string, number> {
  try {
    const raw = store?.getItem(DISMISS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, t] of Object.entries(parsed)) {
      if (typeof t === "number" && now - t < DISMISS_MS) out[k] = t;
    }
    return out;
  } catch {
    return {};
  }
}

export function dismissTip(
  store: KeyValueStore | null,
  key: string,
  now = Date.now(),
): Record<string, number> {
  const next = { ...loadDismissed(store, now), [key]: now };
  try {
    store?.setItem(DISMISS_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: the tip is hidden for this visit only.
  }
  return next;
}

export function visibleTips(
  tips: ReadonlyArray<AdvisorTip>,
  dismissed: Record<string, number>,
  now = Date.now(),
): AdvisorTip[] {
  return tips.filter((t) => {
    const at = dismissed[t.key];
    return at === undefined || now - at >= DISMISS_MS;
  });
}

export function localStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/* ---------- CSV ---------- */

export type CsvIo = {
  fetchText: (url: string) => Promise<string>;
  /** Saves through a Blob and a download link. May throw (a webview can block it). */
  save: (text: string, filename: string) => void;
  copy: (text: string) => Promise<void>;
};

export const csvUrl = (view: CsvView, r: Partial<Range>) =>
  `${BASE}/api/cockpit/usage/export.csv${query(r) ? `${query(r)}&` : "?"}view=${view}`;

export const defaultCsvIo: CsvIo = {
  fetchText: async (url) => {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) throw new Error("Couldn't export the CSV.");
    return res.text();
  },
  save: (text, filename) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  },
  copy: (text) => navigator.clipboard.writeText(text),
};

/** Downloads the CSV; when the download throws, copies it to the clipboard instead and says so. */
export async function downloadCsv(
  view: CsvView,
  r: Partial<Range>,
  io: CsvIo = defaultCsvIo,
): Promise<"downloaded" | "copied"> {
  const text = await io.fetchText(csvUrl(view, r));
  try {
    io.save(text, `usage-${view}.csv`);
    return "downloaded";
  } catch {
    await io.copy(text);
    return "copied";
  }
}

export async function copyCsv(
  view: CsvView,
  r: Partial<Range>,
  io: CsvIo = defaultCsvIo,
): Promise<void> {
  await io.copy(await io.fetchText(csvUrl(view, r)));
}
