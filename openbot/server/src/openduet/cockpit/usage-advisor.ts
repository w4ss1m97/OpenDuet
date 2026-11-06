import { costOf, priceFor } from "./usage-prices";
import { type UsageContext, resolveProject } from "./usage-query";
import { localDayHour } from "./usage-parse";
import type { Tok, UsageRow } from "./usage-types";

const SEARCH_AGENTS = new Set(["explore", "explorer"]);
const SEARCH_WORDS = /search|find|locate|explor|grep|survey|scan|look ?up|inventory/i;
const BIG_CONTEXT_MIN_REQUESTS = 30;

export type TipKind = "opus-short" | "big-context" | "opus-search";

/** A saving tip with the numbers behind it. `link` is an app path; `saving` is dollars, null when no model switch is proposed. */
export type Tip = {
  key: string;
  kind: TipKind;
  project: string;
  link: string;
  title: string;
  detail: string;
  numbers: Record<string, number>;
  saving: number | null;
};

export type AdvisorResult = { tips: Tip[]; totalSaving: number };

const round2 = (value: number) => Math.round(value * 100) / 100;
const zero = (): Tok => ({ input: 0, cw5: 0, cw1h: 0, cr: 0, output: 0, requests: 0 });
const add = (into: Tok, r: Tok) => {
  into.input += r.input;
  into.cw5 += r.cw5;
  into.cw1h += r.cw1h;
  into.cr += r.cr;
  into.output += r.output;
  into.requests += r.requests;
};
const family = (priceKey: string) => {
  const name = priceKey.split("-")[0] ?? priceKey;
  return name.charAt(0).toUpperCase() + name.slice(1);
};
const sinceDay = (ctx: UsageContext, days: number) => localDayHour(ctx.now - days * 86_400_000, ctx.tz).day;

/** Tips from the stored usage: Opus on short turns, huge contexts, Opus search subagents. Idle sessions and stale notes live in attention. */
export function buildTips(ctx: UsageContext): AdvisorResult {
  const { store, config } = ctx;
  const th = config.advisor;
  const priceOf = (model: string) => priceFor(model, config.prices, config.fallbackPrice).price;
  const costByModel = (rows: UsageRow[], only?: (r: UsageRow) => Tok) =>
    rows.reduce((sum, r) => sum + costOf(only ? only(r) : r, priceOf(r.model)), 0);
  const recost = (tok: Tok, priceKey: string) => costOf(tok, config.prices[priceKey] ?? config.fallbackPrice);
  const name = (id: string) => store.sessions[id]?.name || `session ${id.slice(0, 8)}`;
  const projectOf = (id: string) => resolveProject(store.sessions[id], ctx.projects, ctx.home);
  const week = Object.values(store.rows).filter((r) => r.day >= sinceDay(ctx, 7));
  const bySession = (rows: UsageRow[]) => {
    const map = new Map<string, UsageRow[]>();
    for (const r of rows) map.set(r.session, [...(map.get(r.session) ?? []), r]);
    return map;
  };
  const tips: Tip[] = [];

  for (const [session, rows] of bySession(week.filter((r) => r.agent === "main" && r.model.startsWith("opus")))) {
    const sum = zero();
    for (const r of rows) add(sum, r);
    if (sum.requests < th.opusShortMinRequests || sum.requests === 0) continue;
    const avgOut = sum.output / sum.requests;
    if (avgOut >= th.opusShortMaxOutput) continue;
    const now = costByModel(rows);
    const alt = recost(sum, th.cheaperMain);
    tips.push({
      key: `opus-short:${session}`, kind: "opus-short", project: projectOf(session), link: `/cockpit/usage/session/${session}`,
      title: `Use ${family(th.cheaperMain)} for «${name(session)}» (${session.slice(0, 6)})`,
      detail: `${sum.requests} Opus requests this week, only ${Math.round(avgOut)} output tokens each on average: short turns rarely need Opus.`,
      numbers: { requests: sum.requests, avgOutputTokens: Math.round(avgOut), opusCost: round2(now), cheaperCost: round2(alt) },
      saving: round2(Math.max(0, now - alt)),
    });
  }

  for (const [session, rows] of bySession(week.filter((r) => r.agent === "main"))) {
    const sum = zero();
    for (const r of rows) add(sum, r);
    if (sum.requests < BIG_CONTEXT_MIN_REQUESTS) continue;
    const avgCr = sum.cr / sum.requests;
    if (avgCr < th.bigContextTokens) continue;
    const cacheReadCost = costByModel(rows, (r) => ({ ...zero(), cr: r.cr }));
    tips.push({
      key: `big-context:${session}`, kind: "big-context", project: projectOf(session), link: `/cockpit/usage/session/${session}`,
      title: `Run /compact or /clear in «${name(session)}» (${session.slice(0, 6)})`,
      detail: `Every turn re-reads about ${Math.round(avgCr / 1000)}k cached tokens. Past a task boundary, /compact (keep the plan) or /clear (start clean) shrinks that.`,
      numbers: { requests: sum.requests, avgCacheReadTokens: Math.round(avgCr), cacheReadCost: round2(cacheReadCost) },
      saving: null,
    });
  }

  const subs = new Map<string, UsageRow[]>();
  const since30 = sinceDay(ctx, 30);
  for (const r of Object.values(store.rows)) {
    if (r.agent === "main" || !r.model.startsWith("opus") || r.day < since30) continue;
    const key = `${r.session}|${r.agentId}|${r.model}`;
    subs.set(key, [...(subs.get(key) ?? []), r]);
  }
  const hits = [...subs.values()].filter((rows) => {
    const first = rows[0]!;
    return SEARCH_AGENTS.has(first.agent.toLowerCase()) || SEARCH_WORDS.test(store.subagents[`${first.session}|${first.agentId}`]?.description ?? "");
  });
  if (hits.length) {
    const now = hits.reduce((sum, rows) => sum + costByModel(rows), 0);
    const alt = hits.reduce((sum, rows) => {
      const t = zero();
      for (const r of rows) add(t, r);
      return sum + recost(t, th.cheaperSearch);
    }, 0);
    tips.push({
      key: "opus-search-subagents", kind: "opus-search", project: "", link: "/cockpit/usage",
      title: `Run search subagents on ${family(th.cheaperSearch)} (the explorer agent)`,
      detail: `${hits.length} Opus subagent run(s) in the last 30 days were search or exploration work. Reading files and grepping does not need Opus.`,
      numbers: { runs: hits.length, opusCost: round2(now), cheaperCost: round2(alt) },
      saving: round2(Math.max(0, now - alt)),
    });
  }

  const weight = (t: Tip) => (t.saving ?? 0) + (t.numbers.cacheReadCost ?? 0);
  tips.sort((a, b) => weight(b) - weight(a));
  const perKind = new Map<TipKind, number>();
  const kept = tips.filter((t) => {
    const n = (perKind.get(t.kind) ?? 0) + 1;
    perKind.set(t.kind, n);
    return n <= th.maxPerKind;
  });
  return { tips: kept, totalSaving: round2(kept.reduce((sum, t) => sum + (t.saving ?? 0), 0)) };
}
