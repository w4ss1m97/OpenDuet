import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CockpitProblem } from "@/components/cockpit/parts";
import {
  AdvisorList,
  BudgetsList,
  COST_NOTE,
  FlagsTable,
  RangePicker,
  UsageBanners,
  UsageSections,
} from "@/components/cockpit/usage-tables";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  lastDays,
  parisToday,
  usageAdvisorQueryOptions,
  usageBudgetsQueryOptions,
  usageQueryOptions,
} from "@/lib/cockpit/usage";

/** Claude Code tokens and API-equivalent cost on this Mac, from the transcripts. The range lives in the URL. */
export const Route = createFileRoute("/_authed/_app/cockpit/usage")({
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
  component: CockpitUsage,
});

function CockpitUsage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = {
    from: search.from ?? lastDays(30).from,
    to: search.to ?? parisToday(),
  };
  const { data, error, isPending } = useQuery(usageQueryOptions(range));
  const budgets = useQuery(usageBudgetsQueryOptions());
  const advisor = useQuery(usageAdvisorQueryOptions());

  return (
    <PageShell
      backButton={{ label: "Cockpit", linkProps: { to: "/cockpit/projects" } }}
      description={COST_NOTE}
      title="Usage"
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
          {budgets.data?.configError ? (
            <p className="type-sub mt-2" role="alert">
              Budget config problem: {budgets.data.configError}
            </p>
          ) : null}
          <PageSection
            description={`Week from ${budgets.data?.weekStart ?? "Monday"}. Tokens leave out cache reads.`}
            title="Weekly budgets"
          >
            <BudgetsList
              attentionPercent={budgets.data?.budgetPercent ?? 80}
              budgets={budgets.data?.budgets ?? []}
            />
          </PageSection>
          <PageSection title="Tips">
            <AdvisorList tips={advisor.data?.tips ?? []} />
          </PageSection>
          <UsageSections range={range} report={data} />
          <PageSection
            description="Search-like subagents that ran on Opus."
            title="Flags"
          >
            <FlagsTable flags={data.flags} />
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
