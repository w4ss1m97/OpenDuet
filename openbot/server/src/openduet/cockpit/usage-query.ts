import { sep } from "node:path";
import { toCsv } from "./csv";
import { localDayHour } from "./usage-parse";
import { costOf, priceFor } from "./usage-prices";
import type { AttentionItem, CockpitProject } from "./types";
import type { Budget, Tok, UsageConfig, UsageRow, UsageStore } from "./usage-types";

/** What every query needs: the store, the config in force, the current project list, and a clock. */
export type UsageContext = {
  store: UsageStore;
  config: UsageConfig;
  projects: CockpitProject[];
  tz: string;
  /** Milliseconds since the epoch. */
  now: number;
  /** The home folder, to read the encoded transcript folder names. */
  home: string;
};

const DAY_MS = 86_400_000;
const SEARCH_AGENTS = new Set(["explore", "explorer"]);
const SEARCH_WORDS = /search|find|locate|explor|grep|survey|scan|look ?up|inventory|list/i;
const MAX_SPAN_DAYS = 400;
const DEFAULT_SPAN_DAYS = 30;

const encode = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** `-Users-me-Desktop-Barber--claude-worktrees-x` -> `Barber (worktree)`. */
export function projectLabel(dir: string, home: string): string {
  const homeEnc = encode(home);
  let name = dir === homeEnc || dir.startsWith(`${homeEnc}-`) ? dir.slice(homeEnc.length).replace(/^-+/, "") : dir;
  const worktree = name.includes("--claude-worktrees-");
  name = name.split("--claude-worktrees-")[0]!;
  for (const prefix of ["Desktop-", "Documents-", "code-"]) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
  }
  if (name.includes("scratch-workspaces")) name = "(no folder)";
  return (name || "~") + (worktree ? " (worktree)" : "");
}

/**
 * The project a session belongs to: its first cwd inside a listed project (or one of its worktrees), else its
 * transcript folder named like a listed project, else a readable label of that folder.
 */
export function resolveProject(meta: { dir: string; cwd: string; label?: string } | undefined, projects: CockpitProject[], home: string): string {
  if (!meta) return "(unknown)";
  const longest = (matches: CockpitProject[]) => matches.sort((a, b) => b.path.length - a.path.length)[0];
  const byCwd = meta.cwd ? longest(projects.filter((p) => meta.cwd === p.path || meta.cwd.startsWith(p.path + sep))) : undefined;
  if (byCwd) return byCwd.name;
  if (meta.label) return meta.label;
  const byDir = longest(projects.filter((p) => meta.dir === encode(p.path) || meta.dir.startsWith(`${encode(p.path)}--claude-worktrees-`)));
  return byDir?.name ?? projectLabel(meta.dir, home);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const validDay = (day: string) => ISO_DAY.test(day) && Number.isFinite(dayMs(day)) && new Date(dayMs(day)).toISOString().slice(0, 10) === day;
const shiftDay = (day: string, days: number) => new Date(dayMs(day) + days * DAY_MS).toISOString().slice(0, 10);

/** The Monday (`YYYY-MM-DD`) that starts the week containing `now` in `tz`. */
export function weekStart(now: number, tz: string): string {
  const today = localDayHour(now, tz).day;
  const weekday = new Date(dayMs(today)).getUTCDay();
  return shiftDay(today, -((weekday + 6) % 7));
}

/** The `from`/`to` of a request: both optional (default the last 30 days), valid, in order, at most 400 days. */
export function resolveRange(from: string | undefined, to: string | undefined, now: number, tz: string): { from: string; to: string } | { error: string } {
  const today = localDayHour(now, tz).day;
  const end = to ?? today;
  if (!validDay(end) || (from !== undefined && !validDay(from))) return { error: "from and to must be dates like 2026-10-31" };
  const start = from ?? shiftDay(end, -(DEFAULT_SPAN_DAYS - 1));
  if (!validDay(start)) return { error: "from and to must be dates like 2026-10-31" };
  if (start > end) return { error: "from must not be after to" };
  if ((dayMs(end) - dayMs(start)) / DAY_MS + 1 > MAX_SPAN_DAYS) return { error: `the range is limited to ${MAX_SPAN_DAYS} days` };
  return { from: start, to: end };
}

type Priced = Tok & { cost: number; tokens: number };

const EMPTY: Tok = { input: 0, cw5: 0, cw1h: 0, cr: 0, output: 0, requests: 0 };
const addTok = (into: Tok, tok: Tok) => {
  into.input += tok.input;
  into.cw5 += tok.cw5;
  into.cw1h += tok.cw1h;
  into.cr += tok.cr;
  into.output += tok.output;
  into.requests += tok.requests;
};
/** Cache reads are counted apart from tokens. */
const tokensOf = (t: Tok) => t.input + t.cw5 + t.cw1h + t.output;

/** Prices rows at query time; remembers the models that fell back to the fallback price. */
function pricer(config: UsageConfig) {
  const unknown = new Set<string>();
  const costFor = (model: string, tok: Tok) => {
    const { price, known } = priceFor(model, config.prices, config.fallbackPrice);
    if (!known) unknown.add(model);
    return costOf(tok, price);
  };
  return { unknown, costFor };
}

/** Sums rows that share a key; groups come out sorted by key. Each group keeps the fields `make` gives it. */
function group<K extends object>(rows: UsageRow[], keyOf: (r: UsageRow) => string, make: (r: UsageRow) => K): Array<K & Tok & { model: string }> {
  const groups = new Map<string, K & Tok & { model: string }>();
  for (const r of rows) {
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ...make(r), model: r.model, ...EMPTY }));
    addTok(g, r);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, g]) => g);
}

export type DayRow = Priced & { day: string; project: string; model: string; agent: string };
export type HourRow = Priced & { day: string; hour: number; project: string; model: string };
export type SessionDayRow = Priced & { day: string; session: string; project: string; model: string };
export type SessionRow = {
  id: string;
  name: string;
  project: string;
  mainRequests: number;
  mainOpusRequests: number;
  subagents: number;
  /** First and last day with usage inside the range. */
  first: string;
  last: string;
};
export type SearchFlag = { session: string; sessionName: string; agent: string; description: string; model: string; cost: number; requests: number };
export type UsageSummary = {
  from: string;
  to: string;
  days: DayRow[];
  hours: HourRow[];
  sessionDays: SessionDayRow[];
  sessions: SessionRow[];
  flags: SearchFlag[];
  burnPerHour: number;
  unknownModels: string[];
  firstDay: string | null;
};

const sessionName = (store: UsageStore, id: string) => store.sessions[id]?.name || `session ${id.slice(0, 8)}`;

/** Everything the Usage page draws for the Paris dates [from, to] inclusive; the page does the pivots. */
export function summarize(ctx: UsageContext, from: string, to: string): UsageSummary {
  const { store, config } = ctx;
  const { unknown, costFor } = pricer(config);
  const projectCache = new Map<string, string>();
  const projectOf = (session: string) => {
    let name = projectCache.get(session);
    if (name === undefined) projectCache.set(session, (name = resolveProject(store.sessions[session], ctx.projects, ctx.home)));
    return name;
  };
  const price = <T extends Tok & { model: string }>(g: T): T & { cost: number; tokens: number } => ({ ...g, cost: round(costFor(g.model, g), 6), tokens: tokensOf(g) });

  const all = Object.values(store.rows);
  const rows = all.filter((r) => r.day >= from && r.day <= to);
  const days = group(rows, (r) => `${r.day}|${projectOf(r.session)}|${r.model}|${r.agent}`, (r) => ({ day: r.day, project: projectOf(r.session), agent: r.agent })).map(price);
  const hours = group(rows, (r) => `${r.day}|${String(r.hour).padStart(2, "0")}|${projectOf(r.session)}|${r.model}`, (r) => ({ day: r.day, hour: r.hour, project: projectOf(r.session) })).map(price);
  const sessionDays = group(rows, (r) => `${r.day}|${r.session}|${r.model}`, (r) => ({ day: r.day, session: r.session, project: projectOf(r.session) })).map(price);

  const perSession = new Map<string, SessionRow & { agentIds: Set<string> }>();
  for (const r of rows) {
    let s = perSession.get(r.session);
    if (!s) {
      s = { id: r.session, name: sessionName(store, r.session), project: projectOf(r.session), mainRequests: 0, mainOpusRequests: 0, subagents: 0, first: r.day, last: r.day, agentIds: new Set() };
      perSession.set(r.session, s);
    }
    if (r.agent === "main") {
      s.mainRequests += r.requests;
      if (r.model.startsWith("opus")) s.mainOpusRequests += r.requests;
    } else s.agentIds.add(r.agentId);
    if (r.day < s.first) s.first = r.day;
    if (r.day > s.last) s.last = r.day;
  }
  const sessions = [...perSession.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map(({ agentIds, ...s }) => ({ ...s, subagents: agentIds.size }));

  const flags: SearchFlag[] = [];
  const opusSubs = rows.filter((r) => r.agent !== "main" && r.model.startsWith("opus"));
  for (const g of group(opusSubs, (r) => `${r.session}|${r.agentId}|${r.model}`, (r) => ({ session: r.session, agent: r.agent, agentId: r.agentId }))) {
    const description = store.subagents[`${g.session}|${g.agentId}`]?.description ?? "";
    if (SEARCH_AGENTS.has(g.agent.toLowerCase()) || SEARCH_WORDS.test(description)) {
      flags.push({ session: g.session, sessionName: sessionName(store, g.session), agent: g.agent, description, model: g.model, cost: round(costFor(g.model, g), 6), requests: g.requests });
    }
  }
  flags.sort((a, b) => b.cost - a.cost);

  const cut = localDayHour(ctx.now - 3 * 3600_000, ctx.tz);
  let recent = 0;
  for (const r of all) {
    if (r.day > cut.day || (r.day === cut.day && r.hour >= cut.hour)) recent += costFor(r.model, r);
  }
  const firstDay = all.reduce<string | null>((min, r) => (min === null || r.day < min ? r.day : min), null);
  return { from, to, days, hours, sessionDays, sessions, flags: flags.slice(0, 30), burnPerHour: round(recent / 3, 4), unknownModels: [...unknown].sort(), firstDay };
}

export type SessionDetail = {
  id: string;
  name: string | null;
  project: string;
  /** Milliseconds since the epoch, from the first and last usage line read. */
  first: number | null;
  last: number | null;
  days: Array<Priced & { day: string; model: string; agent: string }>;
  agents: Array<Priced & { agentId: string; agent: string; model: string; description: string }>;
};

/** One session's days and agents, or null when the store has nothing for it. */
export function sessionDetail(ctx: UsageContext, id: string): SessionDetail | null {
  const meta = ctx.store.sessions[id];
  const rows = Object.values(ctx.store.rows).filter((r) => r.session === id);
  if (!meta && rows.length === 0) return null;
  const { costFor } = pricer(ctx.config);
  const price = <T extends Tok & { model: string }>(g: T): T & { cost: number; tokens: number } => ({ ...g, cost: round(costFor(g.model, g), 6), tokens: tokensOf(g) });
  return {
    id,
    name: meta?.name ?? null,
    project: resolveProject(meta, ctx.projects, ctx.home),
    first: meta?.first ?? null,
    last: meta?.last ?? null,
    days: group(rows, (r) => `${r.day}|${r.model}|${r.agent}`, (r) => ({ day: r.day, agent: r.agent })).map(price),
    agents: group(rows, (r) => `${r.agentId}|${r.model}`, (r) => ({ agentId: r.agentId, agent: r.agent, description: ctx.store.subagents[`${id}|${r.agentId}`]?.description ?? "" })).map(price),
  };
}

export type BudgetStatus = Budget & { used: number; pct: number };

/** Weekly budgets (Monday 00:00 Paris to now): used dollars (API-equivalent) or tokens, and used / limit. A limit of 0 is ignored. */
export function budgetStatus(ctx: UsageContext): BudgetStatus[] {
  const budgets = ctx.config.budgets.filter((b) => b.limit > 0);
  if (budgets.length === 0) return [];
  const monday = weekStart(ctx.now, ctx.tz);
  const byProject = new Map<string, { usd: number; tokens: number }>();
  const { costFor } = pricer(ctx.config);
  const projectCache = new Map<string, string>();
  for (const r of Object.values(ctx.store.rows)) {
    if (r.day < monday) continue;
    let name = projectCache.get(r.session);
    if (name === undefined) projectCache.set(r.session, (name = resolveProject(ctx.store.sessions[r.session], ctx.projects, ctx.home)));
    const total = byProject.get(name) ?? { usd: 0, tokens: 0 };
    total.usd += costFor(r.model, r);
    total.tokens += tokensOf(r);
    byProject.set(name, total);
  }
  return budgets.map((b) => {
    const picks = b.scope === "overall" ? [...byProject.values()] : byProject.has(b.scope) ? [byProject.get(b.scope)!] : [];
    const used = picks.reduce((sum, p) => sum + (b.unit === "usd" ? p.usd : p.tokens), 0);
    return { ...b, used: round(used, 4), pct: used / b.limit };
  });
}

/** Budgets at `percent` of their limit or more as attention lines: medium, high from 100%. */
export function budgetAttention(statuses: BudgetStatus[], percent: number): AttentionItem[] {
  return statuses
    .filter((b) => b.pct >= percent / 100)
    .map((b) => ({
      project: b.scope,
      severity: b.pct >= 1 ? ("high" as const) : ("medium" as const),
      message: `Weekly budget at ${Math.round(b.pct * 100)}%: ${Number(b.used.toPrecision(4))} of ${b.limit} ${b.unit === "usd" ? "$ (API-equivalent)" : "tokens"}`,
      link: null,
    }));
}

export type CsvView = "days" | "sessions" | "models" | "agents";
export const CSV_VIEWS: readonly CsvView[] = ["days", "sessions", "models", "agents"];

const TOKEN_HEADER = ["input", "cache_write_5m", "cache_write_1h", "cache_read", "output", "requests", "tokens", "cost_usd"];
const tokenCells = (t: Priced) => [t.input, t.cw5, t.cw1h, t.cr, t.output, t.requests, t.tokens, t.cost];

function total<T extends Priced>(items: T[], keyOf: (item: T) => string): Map<string, Priced> {
  const sums = new Map<string, Priced>();
  for (const item of items) {
    const sum = sums.get(keyOf(item)) ?? { ...EMPTY, cost: 0, tokens: 0 };
    addTok(sum, item);
    sum.cost += item.cost;
    sum.tokens += item.tokens;
    sums.set(keyOf(item), sum);
  }
  return sums;
}

/** One summary as a CSV, by day, session, model or agent. */
export function csvFor(view: CsvView, summary: UsageSummary): string {
  switch (view) {
    case "days":
      return toCsv(["day", "project", "model", "agent", ...TOKEN_HEADER], summary.days.map((d) => [d.day, d.project, d.model, d.agent, ...tokenCells(d)]));
    case "models":
      return toCsv(["model", ...TOKEN_HEADER], [...total(summary.days, (d) => d.model)].map(([model, t]) => [model, ...tokenCells(t)]));
    case "agents":
      return toCsv(["agent", ...TOKEN_HEADER], [...total(summary.days, (d) => d.agent)].map(([agent, t]) => [agent, ...tokenCells(t)]));
    default: {
      const sums = total(summary.sessionDays, (d) => d.session);
      return toCsv(
        ["session", "name", "project", "first_day", "last_day", "subagents", ...TOKEN_HEADER],
        summary.sessions.map((s) => [s.id, s.name, s.project, s.first, s.last, s.subagents, ...tokenCells(sums.get(s.id) ?? { ...EMPTY, cost: 0, tokens: 0 })]),
      );
    }
  }
}
