import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { Chip } from "@/components/cockpit/parts";
import {
  DailyBars,
  HourHeatmap,
  Legend,
  ModelShare,
} from "@/components/cockpit/usage-charts";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  type AdvisorTip,
  type BudgetState,
  type CsvView,
  compact,
  copyCsv,
  dismissTip,
  downloadCsv,
  groupTotals,
  hourHeatmap,
  lastDays,
  loadDismissed,
  localStore,
  pivotDaily,
  type Range,
  type Total,
  totalOf,
  type UsageFlag,
  type UsageReport,
  type UsageSession,
  usd,
  visibleTips,
} from "@/lib/cockpit/usage";

export const COST_NOTE = "API-equivalent cost (you are on a subscription)";

/** What the page tells before its numbers: a bad config, models without a price, an import under way. */
export function UsageBanners({ report }: { report: UsageReport }) {
  const { status } = report;
  const notes: Array<{ key: string; tone: "warn" | "plain"; text: string }> =
    [];
  if (report.configError) {
    notes.push({
      key: "config",
      tone: "warn",
      text: `Usage config problem, defaults are in force: ${report.configError}`,
    });
  }
  if (report.unknownModels.length) {
    notes.push({
      key: "unknown",
      tone: "warn",
      text: `No price for ${report.unknownModels.join(", ")}; the fallback price is used, so those costs are rough.`,
    });
  }
  if (status.backfilling) {
    notes.push({
      key: "backfill",
      tone: "plain",
      text: `Importing transcripts: ${status.filesDone}/${status.filesTotal}`,
    });
  }
  if (status.lastError) {
    notes.push({
      key: "error",
      tone: "warn",
      text: `Last import error: ${status.lastError}`,
    });
  }
  return (
    <div className="mt-4 flex flex-col gap-2">
      {notes.map((n) => (
        <p
          className="type-sub rounded-lg border border-border px-3 py-2"
          key={n.key}
          role={n.tone === "warn" ? "alert" : "status"}
        >
          {n.text}
        </p>
      ))}
    </div>
  );
}

/** Download as a file; if the webview blocks that, the CSV is copied instead. "Copy CSV" always copies. */
export function CsvButtons({ view, range }: { view: CsvView; range: Range }) {
  const [say, setSay] = useState<string | null>(null);
  const run = (job: () => Promise<string>) => {
    job().then(setSay, (e: unknown) =>
      setSay(e instanceof Error ? e.message : "Couldn't export the CSV."),
    );
  };
  return (
    <span className="inline-flex items-center gap-2">
      {say ? (
        <span className="type-caption text-muted-foreground" role="status">
          {say}
        </span>
      ) : null}
      <Button
        onClick={() =>
          run(async () =>
            (await downloadCsv(view, range)) === "copied"
              ? "Download blocked, so the CSV was copied."
              : "Downloaded.",
          )
        }
        size="sm"
        type="button"
        variant="outline"
      >
        Download CSV
      </Button>
      <Button
        onClick={() =>
          run(async () => {
            await copyCsv(view, range);
            return "Copied.";
          })
        }
        size="sm"
        type="button"
        variant="outline"
      >
        Copy CSV
      </Button>
    </span>
  );
}

type Col = { head: string; right?: boolean };

function Table({
  cols,
  rows,
  empty,
}: {
  cols: Col[];
  rows: Array<{ key: string; cells: React.ReactNode[] }>;
  empty: string;
}) {
  if (!rows.length) return <PageEmpty>{empty}</PageEmpty>;
  return (
    <PageRows className="overflow-x-auto">
      <table className="type-sub w-full">
        <thead>
          <tr className="text-left text-muted-foreground">
            {cols.map((c) => (
              <th
                className={`px-4 py-2 font-medium ${c.right ? "text-right" : ""}`}
                key={c.head}
                scope="col"
              >
                {c.head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr className="border-border border-t" key={r.key}>
              {r.cells.map((cell, i) => (
                <td
                  className={`px-4 py-2 ${cols[i]?.right ? "text-right tabular-nums" : ""}`}
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are fixed
                  key={i}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </PageRows>
  );
}

const shortId = (id: string) => id.slice(0, 6);

export function SessionsTable({
  sessions,
  cost,
}: {
  sessions: UsageSession[];
  /** Cost per session id in the range. */
  cost: Map<string, number>;
}) {
  const rows = sessions
    .map((s) => ({ s, c: cost.get(s.id) ?? 0 }))
    .sort((a, b) => b.c - a.c)
    .slice(0, 50);
  return (
    <Table
      cols={[
        { head: "Session" },
        { head: "Project" },
        { head: "Last day" },
        { head: "Subagents", right: true },
        { head: "Cost", right: true },
      ]}
      empty="No sessions in this range."
      rows={rows.map(({ s, c }) => ({
        key: s.id,
        cells: [
          <Link
            className="underline-offset-2 hover:underline"
            key="n"
            params={{ id: s.id }}
            to="/cockpit/usage/session/$id"
          >
            {s.name ?? "Untitled"} ({shortId(s.id)})
          </Link>,
          s.project,
          s.last,
          s.subagents,
          usd(c),
        ],
      }))}
    />
  );
}

const isSearchAgent = (agent: string) => /^explore/i.test(agent);

/** Routing check: which agent ran on which model. A search agent on Opus is the thing to look at. */
export function AgentsTable({
  rows,
}: {
  rows: Array<{ agent: string; model: string } & Total>;
}) {
  return (
    <Table
      cols={[
        { head: "Agent" },
        { head: "Model" },
        { head: "Requests", right: true },
        { head: "Tokens", right: true },
        { head: "Cost", right: true },
      ]}
      empty="No agent usage in this range."
      rows={rows.map((r) => ({
        key: `${r.agent}|${r.model}`,
        cells: [
          <span className="inline-flex items-center gap-2" key="a">
            {r.agent}
            {isSearchAgent(r.agent) && r.model.startsWith("opus") ? (
              <Chip tone="warn">search on Opus</Chip>
            ) : null}
          </span>,
          r.model,
          r.requests.toLocaleString("en-US"),
          compact(r.tokens),
          usd(r.cost),
        ],
      }))}
    />
  );
}

export function ModelsTable({
  rows,
}: {
  rows: Array<{ key: string } & Total>;
}) {
  return (
    <Table
      cols={[
        { head: "Model" },
        { head: "Requests", right: true },
        { head: "Tokens", right: true },
        { head: "Cost", right: true },
      ]}
      empty="No model usage in this range."
      rows={rows.map((r) => ({
        key: r.key,
        cells: [
          r.key,
          r.requests.toLocaleString("en-US"),
          compact(r.tokens),
          usd(r.cost),
        ],
      }))}
    />
  );
}

export function FlagsTable({ flags }: { flags: UsageFlag[] }) {
  return (
    <Table
      cols={[
        { head: "Subagent" },
        { head: "Session" },
        { head: "Model" },
        { head: "Requests", right: true },
        { head: "Cost", right: true },
      ]}
      empty="Nothing flagged: no search-like subagent ran on Opus."
      rows={flags.map((f, i) => ({
        key: `${f.session}|${f.agent}|${i}`,
        cells: [
          <span key="d">
            {f.agent}
            {f.description ? (
              <span className="text-muted-foreground"> · {f.description}</span>
            ) : null}
          </span>,
          <Link
            className="underline-offset-2 hover:underline"
            key="s"
            params={{ id: f.session }}
            to="/cockpit/usage/session/$id"
          >
            {f.sessionName ?? shortId(f.session)}
          </Link>,
          f.model,
          f.requests,
          usd(f.cost),
        ],
      }))}
    />
  );
}

export function BudgetsList({
  budgets,
  attentionPercent,
}: {
  budgets: BudgetState[];
  attentionPercent: number;
}) {
  if (!budgets.length) {
    return (
      <PageEmpty>
        No weekly budget is set. Add one to the usage config to see it here.
      </PageEmpty>
    );
  }
  return (
    <PageRows>
      {budgets.map((b, i) => {
        const pct = Math.round(b.pct * 100);
        const tone =
          pct >= 100
            ? "bg-red-500"
            : pct >= attentionPercent
              ? "bg-amber-500"
              : "bg-primary";
        const fmt = (n: number) => (b.unit === "usd" ? usd(n) : compact(n));
        return (
          <Fragment key={b.scope}>
            {i > 0 ? <Separator /> : null}
            <div className="type-sub px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{b.scope}</span>
                <span className="text-muted-foreground">
                  {fmt(b.used)} of {fmt(b.limit)} · {pct}%
                </span>
              </div>
              <div
                aria-label={`${b.scope} budget used`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={Math.min(pct, 100)}
                className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
              >
                <div
                  className={`h-full ${tone}`}
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
            </div>
          </Fragment>
        );
      })}
    </PageRows>
  );
}

/** Advisor tips. A dismissed tip stays hidden for 7 days (kept in localStorage; storage trouble never breaks the page). */
export function AdvisorList({ tips }: { tips: AdvisorTip[] }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return loadDismissed(localStore());
    } catch {
      return {};
    }
  });
  let shown: AdvisorTip[] = [];
  try {
    shown = visibleTips(tips, dismissed);
  } catch {
    shown = tips;
  }
  if (!shown.length) return <PageEmpty>No tips right now.</PageEmpty>;
  return (
    <PageRows>
      {shown.map((t, i) => (
        <Fragment key={t.key}>
          {i > 0 ? <Separator /> : null}
          <div className="flex items-start gap-3 px-4 py-3">
            <div className="type-sub min-w-0 flex-1">
              <p className="font-medium">{t.title}</p>
              <p className="mt-0.5 text-muted-foreground">{t.detail}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2">
                <Chip>{t.project}</Chip>
                {t.saving ? (
                  <Chip tone="good">~{usd(t.saving)} saved</Chip>
                ) : null}
                <SessionLink link={t.link} />
              </p>
            </div>
            <Button
              onClick={() => {
                try {
                  setDismissed(dismissTip(localStore(), t.key));
                } catch {
                  setDismissed({ ...dismissed, [t.key]: Date.now() });
                }
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Dismiss
            </Button>
          </div>
        </Fragment>
      ))}
    </PageRows>
  );
}

const SESSION_LINK = /^\/cockpit\/usage\/session\/([^/]+)$/;

function SessionLink({ link }: { link: string }) {
  const id = SESSION_LINK.exec(link)?.[1];
  return id ? (
    <Link
      className="underline-offset-2 hover:underline"
      params={{ id }}
      to="/cockpit/usage/session/$id"
    >
      Open session
    </Link>
  ) : null;
}

/* ---------- shared screen parts ---------- */

const PRESET_DAYS = [7, 30, 90] as const;

/** 7 / 30 / 90 day presets and a from/to pair. */
export function RangePicker({
  range,
  onChange,
}: {
  range: Range;
  onChange: (r: Range) => void;
}) {
  return (
    <div className="mt-4 flex flex-wrap items-end gap-2">
      {PRESET_DAYS.map((n) => (
        <Button
          key={n}
          onClick={() => onChange(lastDays(n))}
          size="sm"
          type="button"
          variant="outline"
        >
          {n} days
        </Button>
      ))}
      <label className="type-caption text-muted-foreground">
        From
        <input
          className="ml-1 rounded border border-border bg-background px-1.5 py-1"
          max={range.to}
          onChange={(e) =>
            e.target.value && onChange({ ...range, from: e.target.value })
          }
          type="date"
          value={range.from}
        />
      </label>
      <label className="type-caption text-muted-foreground">
        To
        <input
          className="ml-1 rounded border border-border bg-background px-1.5 py-1"
          min={range.from}
          onChange={(e) =>
            e.target.value && onChange({ ...range, to: e.target.value })
          }
          type="date"
          value={range.to}
        />
      </label>
    </div>
  );
}

/** Totals, the daily bars (by project or model), the hour heatmap, model share, models, agents and sessions. */
export function UsageSections({
  report,
  range,
  projectName,
}: {
  report: UsageReport;
  range: Range;
  /** Set on a project page: the by-project split is pointless there. */
  projectName?: string;
}) {
  const [by, setBy] = useState<"project" | "model">(
    projectName ? "model" : "project",
  );
  const sum = totalOf(report.days);
  const pivot = pivotDaily(report.days, by, range);
  const grid = hourHeatmap(report.hours);
  const models = groupTotals(report.days, (r) => r.model);
  const agents = groupTotals(
    report.days,
    (r) => `${r.agent}\u0000${r.model}`,
  ).map((g) => {
    const [agent = "", model = ""] = g.key.split("\u0000");
    return { ...g, agent, model };
  });
  const sessionCost = new Map<string, number>();
  for (const r of report.sessionDays) {
    sessionCost.set(r.session, (sessionCost.get(r.session) ?? 0) + r.cost);
  }
  const sessions = projectName
    ? report.sessions.filter((s) => s.project === projectName)
    : report.sessions;
  return (
    <>
      <p className="type-sub mt-6">
        <span className="font-medium">{usd(sum.cost)}</span>
        <span className="text-muted-foreground">
          {" "}
          · {compact(sum.tokens)} tokens (cache reads left out) ·{" "}
          {sum.requests.toLocaleString("en-US")} requests
          {report.burnPerHour > 0 && !projectName
            ? ` · about ${usd(report.burnPerHour)}/hour lately`
            : ""}
        </span>
      </p>
      <PageSection
        action={
          <span className="inline-flex gap-1">
            {(projectName
              ? (["model"] as const)
              : (["project", "model"] as const)
            ).map((k) => (
              <Button
                aria-pressed={by === k}
                key={k}
                onClick={() => setBy(k)}
                size="sm"
                type="button"
                variant={by === k ? "secondary" : "ghost"}
              >
                By {k}
              </Button>
            ))}
          </span>
        }
        title="Cost per day"
      >
        {pivot.total > 0 ? (
          <div className="mt-4">
            <DailyBars pivot={pivot} />
            <Legend keys={pivot.keys} />
          </div>
        ) : (
          <PageEmpty>No usage in this range.</PageEmpty>
        )}
      </PageSection>
      <PageSection title="When it happens (Paris time)">
        <div className="mt-4">
          <HourHeatmap grid={grid} />
        </div>
      </PageSection>
      <PageSection
        action={<CsvButtons range={range} view="models" />}
        title="Models"
      >
        <div className="mt-4">
          <ModelShare shares={models} />
        </div>
        <ModelsTable rows={models} />
      </PageSection>
      <PageSection
        action={<CsvButtons range={range} view="agents" />}
        description="Which agent ran on which model. Search agents belong on a cheaper model."
        title="Agents"
      >
        <AgentsTable rows={agents} />
      </PageSection>
      <PageSection
        action={<CsvButtons range={range} view="sessions" />}
        title="Sessions"
      >
        <SessionsTable cost={sessionCost} sessions={sessions} />
      </PageSection>
    </>
  );
}
