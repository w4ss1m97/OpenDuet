import { queryOptions } from "@tanstack/react-query";
import { BASE, CockpitOffError, read } from "./queries";

/*
 * Quality (C4): scores, findings and suggestions per project. Types mirror
 * server/src/openduet/cockpit/quality-parse.ts and quality-service.ts. The server never sends any matched
 * secret text: a finding is a file, a line and a type. Scans and dismissals are body-less POSTs the server
 * guards by Origin.
 */

export type Unavailable = { available: false; why: string };
export type RunRef = { conclusion: string | null; url: string; at: string; branch: string } | null;

export type CiSection =
  | Unavailable
  | {
      available: true;
      days: number;
      runs: number;
      passRate: number | null;
      avgSeconds: number;
      flaky: Array<{ workflow: string; sha: string; url: string; id: number; attempt1: boolean; jobs: string[] }>;
      workflows: Array<{ name: string; runs: number; passRate: number | null; avgSeconds: number | null; last: RunRef; lastBase: RunRef }>;
      coverage: { enforced: number | null; measured: number | null; source: string | null };
    };

export type NpmAudit = { critical: number; high: number; moderate: number; low: number } | { error: string };
export type NpmOutdated = { total: number; major: number; majorNames: string[] } | { error: string };

export type DepsSection = {
  dependabot:
    | Unavailable
    | {
        available: true;
        total: number;
        bySeverity: Record<string, number>;
        top: Array<{ package: string | null; severity: string | null; summary: string; url: string | null }>;
      }
    | null;
  npm: { audit: NpmAudit | null; outdated: NpmOutdated | null } | null;
  python: { skipped: string } | null;
  gradle: boolean;
};

export type SecretHit = { file: string; line: number; type: string; severity: string };

export type SecuritySection = {
  codeScanning: Unavailable | { available: true; total: number; bySeverity: Record<string, number> } | null;
  secretScanning: Unavailable | { available: true; total: number } | null;
  local: SecretHit[];
  gitignore: Array<{ file: string; why: string }>;
};

export type HealthSection = {
  loc: Record<string, number>;
  totalLoc: number;
  srcLoc: number;
  testLoc: number;
  testRatio: number | null;
  hasTests: boolean;
  largest: Array<{ file: string; lines: number; flag: boolean }>;
  todo: Record<string, number>;
  churn: Array<{ file: string; changes: number; lines: number | null }>;
};

export type HygieneSection = {
  readme: boolean;
  claudeMd: boolean;
  claudeWords: number;
  notes: boolean;
  notesAgeDays: number | null;
  notesLagDays: number | null;
  ci: boolean;
  branchProtection: { protected: boolean } | Unavailable | null;
  autoMerge: boolean | null;
  staleBranches: Array<{ branch: string; days: number }>;
  worktrees: number;
};

export type Priority = "high" | "medium" | "low";
export type Suggestion = { id: string; key: string; priority: Priority; title: string; evidence: string; category: string };

export type QualityResult = {
  project: string;
  path: string;
  repo: string | null;
  default: string;
  scannedAt: number;
  files: number;
  ci: CiSection;
  deps: DepsSection;
  security: SecuritySection;
  health: HealthSection;
  hygiene: HygieneSection;
  score: number;
  grade: string;
  categories: Record<string, number | null>;
  why: Record<string, string[]>;
  suggestions: Suggestion[];
  highFindings: Array<{ key: string; text: string; severity: "high" }>;
};

export type TrendPoint = { day: string; score: number; grade: string };

export type QualityDetail = {
  result: QualityResult;
  trend: TrendPoint[];
  suggestions: Array<Suggestion & { dismissedUntil: number }>;
};

export type QualitySummary = {
  projects: Array<{ name: string; grade: string; score: number; scannedAt: number; high: QualityResult["highFindings"] }>;
  status: { scanning: string | null; queue: string[]; lastRun: number; lastError: string | null };
  configError: string | null;
  storeError: string | null;
};

// ---------- helpers ----------
export const gradeOf = (score: number): string =>
  score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

const WEIGHTS: Array<[string, string, number]> = [
  ["tests", "Tests and CI", 30],
  ["deps", "Dependencies", 20],
  ["security", "Security", 25],
  ["health", "Code health", 15],
  ["hygiene", "Hygiene", 10],
];

/** The five categories in weight order; a null score means the category does not apply to this project. */
export function weightedCategories(cats: Record<string, number | null>) {
  return WEIGHTS.map(([key, label, weight]) => ({ key, label, weight, score: cats[key] ?? null }));
}

/** SVG polyline points for a trend: days spread over the width, score 100 at the top. */
export function trendPoints(trend: TrendPoint[], width: number, height: number): string {
  if (trend.length === 0) return "";
  const round = (n: number) => Math.round(n * 100) / 100;
  return trend
    .map((p, i) => {
      const x = trend.length === 1 ? width / 2 : (i / (trend.length - 1)) * width;
      const y = height - (Math.min(100, Math.max(0, p.score)) / 100) * height;
      return `${round(x)},${round(y)}`;
    })
    .join(" ");
}

/** Score change from the first to the last day of the trend; null when there is nothing to compare. */
export function trendDelta(trend: TrendPoint[]): number | null {
  const first = trend[0];
  const last = trend[trend.length - 1];
  return trend.length < 2 || !first || !last ? null : last.score - first.score;
}

// ---------- queries and writes ----------
export const qualityKeys = {
  all: ["cockpit", "quality"] as const,
  detail: (name: string) => ["cockpit", "quality", name] as const,
};

export const qualityQueryOptions = () =>
  queryOptions({
    queryKey: qualityKeys.all,
    queryFn: ({ signal }): Promise<QualitySummary> => read("/api/cockpit/quality", signal),
    refetchInterval: 15_000,
    retry: false,
  });

export const qualityDetailQueryOptions = (name: string) =>
  queryOptions({
    queryKey: qualityKeys.detail(name),
    queryFn: ({ signal }): Promise<QualityDetail> => read(`/api/cockpit/quality/${encodeURIComponent(name)}`, signal),
    refetchInterval: 15_000,
    retry: false,
  });

/** A body-less POST (no Content-Type); the browser adds the Origin the server checks. Returns the status and message. */
export async function cockpitPost(path: string): Promise<{ ok: boolean; status: number; error: string | null; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { method: "POST", credentials: "omit" });
  } catch {
    throw new CockpitOffError();
  }
  const body: unknown = await response.json().catch(() => null);
  const error = (body as { error?: unknown } | null)?.error;
  return { ok: response.ok, status: response.status, error: typeof error === "string" ? error : response.ok ? null : "The cockpit refused that." , body };
}

/** Asks for a scan of one project or "all". Too-soon (429) comes back as a message, not a throw. */
export async function requestScan(target: string): Promise<{ ok: boolean; message: string | null }> {
  const r = await cockpitPost(`/api/cockpit/quality/scan?project=${encodeURIComponent(target)}`);
  if (r.ok) return { ok: true, message: null };
  return { ok: false, message: r.status === 429 ? "Scanning all projects was asked a moment ago; wait a few minutes." : r.error };
}

export async function dismissSuggestion(name: string, key: string): Promise<{ ok: boolean; message: string | null }> {
  const r = await cockpitPost(`/api/cockpit/quality/${encodeURIComponent(name)}/dismiss?key=${encodeURIComponent(key)}`);
  return { ok: r.ok, message: r.ok ? null : r.error };
}
