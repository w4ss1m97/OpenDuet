import { homedir } from "node:os";
import type { AttentionItem, CockpitProject } from "./types";
import { type AdvisorResult, buildTips } from "./usage-advisor";
import type { UsageIngest } from "./usage-ingest";
import { type UsageHistory, USAGE_HISTORY_PATH, loadHistory, mergeHistory } from "./usage-history";
import { localDayHour } from "./usage-parse";
import type { UsageConfigSource } from "./usage-prices";
import {
  type BudgetStatus, CSV_VIEWS, type CsvView, type SessionDetail, type UsageContext, type UsageSummary,
  budgetAttention, budgetStatus, csvFor, resolveRange, sessionDetail, summarize, weekStart,
} from "./usage-query";
import type { UsageStatus } from "./usage-types";

/** `GET /api/cockpit/usage`: the summary of a range, how far the background read is, and a config problem if there is one. */
export type UsageResponse = UsageSummary & { status: UsageStatus; configError: string | null };
/** `GET /api/cockpit/usage/budgets`. */
export type BudgetsResponse = { weekStart: string; budgetPercent: number; budgets: BudgetStatus[]; configError: string | null };
/** `GET /api/cockpit/usage/advisor`. */
export type AdvisorResponse = AdvisorResult & { configError: string | null };

export type UsageService = {
  summary(from?: string, to?: string): Promise<{ ok: true; body: UsageResponse } | { ok: false; error: string }>;
  session(id: string): Promise<SessionDetail | null>;
  budgets(): Promise<BudgetsResponse>;
  advisor(): Promise<AdvisorResponse>;
  csv(view: string | undefined, from?: string, to?: string): Promise<{ ok: true; filename: string; text: string } | { ok: false; error: string }>;
  /** Budget lines for the projects snapshot. */
  attention(): Promise<AttentionItem[]>;
  /** Starts the background read: once now, then every interval (30 s). Returns the function that stops it. */
  start(): () => void;
};

const POLL_MS = 30_000;
const DEFAULT_TZ = "Europe/Paris";

/** The usage routes' brain: loads the config, lists projects, queries what the ingest has stored. A GET never waits for a read pass. */
export function createUsageService(options: {
  ingest: UsageIngest;
  config: UsageConfigSource;
  listProjects: () => CockpitProject[] | Promise<CockpitProject[]>;
  tz?: string;
  now?: () => number;
  home?: string;
  /** Where the imported Cockpit history is read from (never written). */
  historyPath?: string;
  intervalMs?: number;
}): UsageService {
  const tz = options.tz ?? DEFAULT_TZ;
  const now = options.now ?? Date.now;
  const home = options.home ?? homedir();

  const historyPath = options.historyPath ?? USAGE_HISTORY_PATH;
  let history: Promise<UsageHistory | null> | undefined;
  const loadOnce = () => (history ??= loadHistory(historyPath).then((r) => r.history));

  const context = async () => {
    await options.ingest.ready();
    const [{ config, error }, projects, hist] = await Promise.all([options.config.get(), options.listProjects(), loadOnce()]);
    const ctx: UsageContext = { store: mergeHistory(options.ingest.store(), hist), config, projects, tz, now: now(), home };
    return { ctx, error };
  };

  return {
    async summary(from, to) {
      const range = resolveRange(from, to, now(), tz);
      if ("error" in range) return { ok: false, error: range.error };
      const { ctx, error } = await context();
      return { ok: true, body: { ...summarize(ctx, range.from, range.to), status: options.ingest.status(), configError: error } };
    },
    async session(id) {
      return sessionDetail((await context()).ctx, id);
    },
    async budgets() {
      const { ctx, error } = await context();
      return { weekStart: weekStart(ctx.now, tz), budgetPercent: ctx.config.budgetPercent, budgets: budgetStatus(ctx), configError: error };
    },
    async advisor() {
      const { ctx, error } = await context();
      return { ...buildTips(ctx), configError: error };
    },
    async csv(view, from, to) {
      if (!view || !CSV_VIEWS.includes(view as CsvView)) return { ok: false, error: `view must be one of ${CSV_VIEWS.join(", ")}` };
      const range = resolveRange(from, to, now(), tz);
      if ("error" in range) return { ok: false, error: range.error };
      const { ctx } = await context();
      return { ok: true, filename: `duet-usage-${view}-${range.from}-${range.to}.csv`, text: csvFor(view as CsvView, summarize(ctx, range.from, range.to)) };
    },
    async attention() {
      const { ctx } = await context();
      return budgetAttention(budgetStatus(ctx), ctx.config.budgetPercent);
    },
    start() {
      const tick = () => {
        try {
          options.ingest.runOnce().catch(() => undefined);
        } catch {
          // a pass records its own errors; nothing escapes the timer
        }
      };
      tick();
      const timer = setInterval(tick, options.intervalMs ?? POLL_MS);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
