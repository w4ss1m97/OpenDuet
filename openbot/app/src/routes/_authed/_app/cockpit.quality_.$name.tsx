import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import {
  Chip,
  CockpitProblem,
  External,
  agoSeconds,
} from "@/components/cockpit/parts";
import {
  CategoryBar,
  CopyPromptButton,
  Fact,
  GradeChip,
  PRIORITY_TONE,
  TrendChart,
  yesNo,
} from "@/components/cockpit/quality-parts";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  dismissSuggestion,
  qualityDetailQueryOptions,
  qualityKeys,
  type QualityResult,
  type Unavailable,
  requestScan,
  trendDelta,
  weightedCategories,
} from "@/lib/cockpit/quality";
import { reviewPrompt } from "@/lib/cockpit/review-prompt";

/** One project's quality: score by category, trend, findings and suggestions. A sibling of the list (`quality_`). */
export const Route = createFileRoute("/_authed/_app/cockpit/quality_/$name")({
  component: QualityDetailPage,
});

const sevText = (m: Record<string, number>) =>
  Object.entries(m).map(([k, n]) => `${n} ${k}`).join(", ") || "none";

function CiBlock({ r }: { r: QualityResult }) {
  const ci = r.ci;
  if (!ci.available) return <PageEmpty>CI details unavailable: {ci.why}</PageEmpty>;
  return (
    <PageRows>
      <Fact label={`Pass rate, ${ci.days} days`}>{ci.passRate === null ? "n/a" : `${ci.passRate}%`} ({ci.runs} runs)</Fact>
      <Fact label="Average run">{Math.round(ci.avgSeconds)}s</Fact>
      <Fact label="Coverage">
        {ci.coverage.measured === null ? "not measured" : `${ci.coverage.measured}%`}
        {ci.coverage.enforced !== null ? ` (floor ${ci.coverage.enforced}%)` : ""}
      </Fact>
      {ci.workflows.map((w) => (
        <Fact key={w.name} label={w.name}>
          {w.passRate === null ? "n/a" : `${w.passRate}%`}
          {w.last ? <> · <External href={w.last.url}>{w.last.conclusion ?? "running"}</External></> : null}
        </Fact>
      ))}
      {ci.flaky.map((f) => (
        <Fact key={f.id} label="Flaky">
          <External href={f.url}>{f.workflow}</External> {f.jobs.join(", ")}
        </Fact>
      ))}
    </PageRows>
  );
}

function DepsBlock({ r }: { r: QualityResult }) {
  const d = r.deps;
  const audit = d.npm?.audit;
  const outdated = d.npm?.outdated;
  if (!d.dependabot && !d.npm) return <PageEmpty>No dependency data.</PageEmpty>;
  return (
    <PageRows>
      {d.dependabot ? (
        <Fact label="Dependabot">
          {d.dependabot.available ? `${d.dependabot.total} open (${sevText(d.dependabot.bySeverity)})` : d.dependabot.why}
        </Fact>
      ) : null}
      {d.dependabot && d.dependabot.available
        ? d.dependabot.top.map((t) => (
            <Fact key={`${t.package}-${t.summary}`} label={`${t.package ?? "?"} ${t.severity ?? ""}`}>
              {t.url ? <External href={t.url}>{t.summary}</External> : t.summary}
            </Fact>
          ))
        : null}
      {audit ? (
        <Fact label="npm audit">
          {"error" in audit ? audit.error : `${audit.critical} critical, ${audit.high} high, ${audit.moderate} moderate, ${audit.low} low`}
        </Fact>
      ) : null}
      {outdated ? (
        <Fact label="npm outdated">
          {"error" in outdated ? outdated.error : `${outdated.total} outdated, ${outdated.major} major${outdated.majorNames.length ? ` (${outdated.majorNames.join(", ")})` : ""}`}
        </Fact>
      ) : null}
      {d.python ? <Fact label="Python">skipped: {d.python.skipped}</Fact> : null}
    </PageRows>
  );
}

function SecurityBlock({ r }: { r: QualityResult }) {
  const s = r.security;
  const state = (v: Unavailable | { available: true; total: number } | null, label: string) =>
    v === null ? null : (
      <Fact label={label}>
        {v.available ? `${v.total} open` : v.why}
      </Fact>
    );
  return (
    <PageRows>
      {state(s.codeScanning, "Code scanning")}
      {state(s.secretScanning, "Secret scanning")}
      {s.local.length === 0 && s.gitignore.length === 0 ? (
        <p className="type-sub px-4 py-3 text-muted-foreground">No local findings.</p>
      ) : null}
      {s.local.map((h) => (
        <Fact key={`${h.file}:${h.line}:${h.type}`} label={h.line > 0 ? `${h.file}:${h.line}` : h.file}>
          <Chip tone={h.severity === "high" ? "bad" : "warn"}>{h.type}</Chip>
        </Fact>
      ))}
      {s.gitignore.map((g) => (
        <Fact key={g.file} label={g.file}>
          {g.why}
        </Fact>
      ))}
    </PageRows>
  );
}

function HealthBlock({ r }: { r: QualityResult }) {
  const h = r.health;
  const todo = Object.entries(h.todo).filter(([, n]) => n > 0);
  return (
    <PageRows>
      <Fact label="Lines of code">{h.totalLoc} ({h.srcLoc} source, {h.testLoc} tests)</Fact>
      <Fact label="Tests / source">{h.testRatio === null ? "n/a" : `${Math.round(h.testRatio * 100)}%`}</Fact>
      {todo.length ? <Fact label="Markers">{todo.map(([k, n]) => `${n} ${k}`).join(", ")}</Fact> : null}
      {h.largest.slice(0, 5).map((f) => (
        <Fact key={f.file} label={f.file}>
          {f.lines} lines {f.flag ? <Chip tone="warn">big</Chip> : null}
        </Fact>
      ))}
      {h.churn.slice(0, 5).map((c) => (
        <Fact key={`churn-${c.file}`} label={`Churn ${c.file}`}>{c.changes} changes</Fact>
      ))}
    </PageRows>
  );
}

function HygieneBlock({ r }: { r: QualityResult }) {
  const y = r.hygiene;
  const bp = y.branchProtection;
  return (
    <PageRows>
      <Fact label="README">{yesNo(y.readme)}</Fact>
      <Fact label="CLAUDE.md">{yesNo(y.claudeMd)}{y.claudeMd ? ` ${y.claudeWords} words` : ""}</Fact>
      <Fact label="Session notes">
        {yesNo(y.notes)}
        {y.notesAgeDays !== null ? ` ${y.notesAgeDays} d old` : ""}
      </Fact>
      <Fact label="CI configured">{yesNo(y.ci)}</Fact>
      {bp ? <Fact label="Branch protection">{"protected" in bp ? yesNo(bp.protected) : bp.why}</Fact> : null}
      <Fact label="Worktrees">{y.worktrees}</Fact>
      {y.staleBranches.map((b) => (
        <Fact key={b.branch} label={`Stale branch ${b.branch}`}>{b.days} days</Fact>
      ))}
    </PageRows>
  );
}

function QualityDetailPage() {
  const { name } = Route.useParams();
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery(qualityDetailQueryOptions(name));
  const [message, setMessage] = useState<string | null>(null);
  const backButton = { label: "Quality", linkProps: { to: "/cockpit/quality" as const } };

  if (error || isPending) {
    return (
      <PageShell backButton={backButton} title={name}>
        {error ? <CockpitProblem error={error} /> : <PageEmpty>Loading…</PageEmpty>}
      </PageShell>
    );
  }
  const { result: r, trend, suggestions } = data;
  const delta = trendDelta(trend);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qualityKeys.all });

  async function run(task: () => Promise<{ ok: boolean; message: string | null }>) {
    setMessage(null);
    try {
      const out = await task();
      if (!out.ok) setMessage(out.message);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Cockpit is off.");
    }
    await refresh();
  }

  return (
    <PageShell
      action={
        <Button onClick={() => void run(() => requestScan(name))} size="lg" variant="outline">
          Scan now
        </Button>
      }
      backButton={backButton}
      description={`Scanned ${agoSeconds(r.scannedAt)} · ${r.files} files${r.repo ? ` · ${r.repo}` : ""}`}
      title={name}
    >
      {message ? <p className="type-sub mt-4" role="alert">{message}</p> : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <GradeChip grade={r.grade} score={r.score} />
        {delta !== null ? (
          <Chip tone={delta < 0 ? "bad" : delta > 0 ? "good" : "plain"}>
            {delta > 0 ? "+" : ""}{delta} in {trend.length} days
          </Chip>
        ) : null}
        <CopyPromptButton label="Copy security review" text={reviewPrompt("security", r)} />
        <CopyPromptButton label="Copy code review" text={reviewPrompt("code", r)} />
      </div>

      <PageSection title="Score by category">
        <PageRows>
          {weightedCategories(r.categories).map((c, i) => (
            <Fragment key={c.key}>
              {i > 0 ? <Separator /> : null}
              <CategoryBar label={c.label} reasons={r.why[c.key] ?? []} score={c.score} weight={c.weight} />
            </Fragment>
          ))}
        </PageRows>
      </PageSection>
      <PageSection title="Trend, 30 days">
        <PageRows><TrendChart trend={trend} /></PageRows>
      </PageSection>
      <PageSection title="Suggestions">
        {suggestions.length === 0 ? (
          <PageEmpty>Nothing to suggest.</PageEmpty>
        ) : (
          <PageRows>
            {suggestions.map((s, i) => {
              const hidden = s.dismissedUntil * 1000 > Date.now();
              return (
                <Fragment key={s.key}>
                  {i > 0 ? <Separator /> : null}
                  <div className={`flex items-start gap-3 px-4 py-3 ${hidden ? "opacity-50" : ""}`}>
                    <Chip tone={PRIORITY_TONE[s.priority]}>{s.priority}</Chip>
                    <div className="type-sub min-w-0 flex-1">
                      <div className="font-medium">{s.title}</div>
                      <div className="type-caption text-muted-foreground">{s.evidence}</div>
                    </div>
                    {hidden ? (
                      <span className="type-caption text-muted-foreground">dismissed</span>
                    ) : (
                      <Button onClick={() => void run(() => dismissSuggestion(name, s.key))} size="sm" variant="outline">
                        Dismiss
                      </Button>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </PageRows>
        )}
      </PageSection>
      <PageSection title="Tests and CI"><CiBlock r={r} /></PageSection>
      <PageSection title="Dependencies"><DepsBlock r={r} /></PageSection>
      <PageSection title="Security"><SecurityBlock r={r} /></PageSection>
      <PageSection title="Code health"><HealthBlock r={r} /></PageSection>
      <PageSection title="Hygiene"><HygieneBlock r={r} /></PageSection>
    </PageShell>
  );
}
