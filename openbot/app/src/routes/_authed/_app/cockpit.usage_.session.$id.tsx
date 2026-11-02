import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { agoMillis, Chip, CockpitProblem } from "@/components/cockpit/parts";
import { DailyBars, Legend } from "@/components/cockpit/usage-charts";
import { AgentsTable, COST_NOTE } from "@/components/cockpit/usage-tables";
import {
  PageEmpty,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  compact,
  groupTotals,
  pivotDaily,
  totalOf,
  usageSessionQueryOptions,
  usd,
} from "@/lib/cockpit/usage";

/** One session: its cost per day and what each agent in it cost. */
export const Route = createFileRoute(
  "/_authed/_app/cockpit/usage_/session/$id",
)({
  component: CockpitUsageSession,
});

function CockpitUsageSession() {
  const { id } = Route.useParams();
  const { data, error, isPending } = useQuery(usageSessionQueryOptions(id));
  const backButton = {
    label: "Usage",
    linkProps: { to: "/cockpit/usage" as const },
  };
  if (error || isPending) {
    return (
      <PageShell backButton={backButton} title="Session" width="wide">
        {error ? (
          <CockpitProblem error={error} />
        ) : (
          <PageEmpty>Loading…</PageEmpty>
        )}
      </PageShell>
    );
  }
  const sum = totalOf(data.days);
  const pivot = pivotDaily(
    data.days.map((d) => ({ ...d, project: data.project })),
    "model",
  );
  const agents = groupTotals(
    data.agents,
    (a) => `${a.agent}\u0000${a.model}`,
  ).map((g) => {
    const [agent = "", model = ""] = g.key.split("\u0000");
    return { ...g, agent, model };
  });
  return (
    <PageShell
      backButton={backButton}
      description={COST_NOTE}
      title={data.name ?? `Session ${id.slice(0, 6)}`}
      width="wide"
    >
      <p className="type-sub mt-4 flex flex-wrap items-center gap-2">
        <Chip>{data.project}</Chip>
        <span className="font-medium">{usd(sum.cost)}</span>
        <span className="text-muted-foreground">
          · {compact(sum.tokens)} tokens (cache reads left out) ·{" "}
          {sum.requests.toLocaleString("en-US")} requests · last active{" "}
          {agoMillis(data.last)}
        </span>
      </p>
      <PageSection title="Cost per day">
        {pivot.total > 0 ? (
          <div className="mt-4">
            <DailyBars pivot={pivot} />
            <Legend keys={pivot.keys} />
          </div>
        ) : (
          <PageEmpty>No usage recorded.</PageEmpty>
        )}
      </PageSection>
      <PageSection
        description="Which agent ran on which model in this session."
        title="Agents"
      >
        <AgentsTable rows={agents} />
      </PageSection>
    </PageShell>
  );
}
