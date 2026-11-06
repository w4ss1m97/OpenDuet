import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CockpitProblem } from "@/components/cockpit/parts";
import {
  COST_NOTE,
  RangePicker,
  UsageBanners,
  UsageSections,
} from "@/components/cockpit/usage-tables";
import { PageEmpty, PageShell } from "@/components/layout/page-shell";
import {
  lastDays,
  parisToday,
  type UsageReport,
  usageQueryOptions,
} from "@/lib/cockpit/usage";

/** One project's usage: the same report, narrowed to its rows. */
export const Route = createFileRoute(
  "/_authed/_app/cockpit/usage_/project/$name",
)({
  validateSearch: (
    s: Record<string, unknown>,
  ): { from?: string; to?: string } => {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    return {
      ...(typeof s.from === "string" && day.test(s.from)
        ? { from: s.from }
        : {}),
      ...(typeof s.to === "string" && day.test(s.to) ? { to: s.to } : {}),
    };
  },
  component: CockpitUsageProject,
});

function onlyProject(r: UsageReport, name: string): UsageReport {
  const keep = <T extends { project: string }>(rows: T[]) =>
    rows.filter((x) => x.project === name);
  return {
    ...r,
    days: keep(r.days),
    hours: keep(r.hours),
    sessionDays: keep(r.sessionDays),
    sessions: keep(r.sessions),
  };
}

function CockpitUsageProject() {
  const { name } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = {
    from: search.from ?? lastDays(30).from,
    to: search.to ?? parisToday(),
  };
  const { data, error, isPending } = useQuery(usageQueryOptions(range));
  return (
    <PageShell
      backButton={{
        label: "Usage",
        linkProps: { to: "/cockpit/usage" },
      }}
      description={COST_NOTE}
      title={name}
      width="wide"
    >
      <RangePicker
        onChange={(r) => void navigate({ search: r })}
        range={range}
      />
      {error ? (
        <CockpitProblem error={error} />
      ) : isPending ? (
        <PageEmpty>Loading…</PageEmpty>
      ) : (
        <>
          <UsageBanners report={data} />
          <UsageSections
            projectName={name}
            range={range}
            report={onlyProject(data, name)}
          />
        </>
      )}
    </PageShell>
  );
}
