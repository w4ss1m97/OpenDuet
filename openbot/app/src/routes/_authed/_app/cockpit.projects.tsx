import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  AttentionRow,
  Chip,
  CockpitProblem,
  External,
  agoMillis,
  agoSeconds,
  checksLabel,
  checksTone,
  runState,
} from "@/components/cockpit/parts";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Separator } from "@/components/ui/separator";
import {
  type AttentionItem,
  type CockpitProject,
  cockpitProjectsQueryOptions,
} from "@/lib/cockpit/queries";
import { Fragment } from "react";

/**
 * The projects on this Mac at a glance: what needs attention first, then one card per project.
 * Read from the cockpit server on 127.0.0.1 (see lib/cockpit/queries.ts). The detail page is a
 * sibling (`projects_`), not a child, so this list stays the page at /cockpit/projects.
 */
export const Route = createFileRoute("/_authed/_app/cockpit/projects")({
  component: CockpitProjects,
});

const ORDER = { high: 0, medium: 1, low: 2 } as const;

export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

function CockpitProjects() {
  const { data, error, isPending } = useQuery(cockpitProjectsQueryOptions());
  return (
    <PageShell
      description="Your projects on this Mac, with what needs you first."
      title="Cockpit"
    >
      {error ? (
        <CockpitProblem error={error} />
      ) : isPending ? (
        <PageEmpty>Loading…</PageEmpty>
      ) : (
        <>
          <PageSection title="Needs attention">
            {data.attention.length === 0 ? (
              <PageEmpty>Nothing needs you right now.</PageEmpty>
            ) : (
              <PageRows>
                {sortAttention(data.attention).map((item, i) => (
                  <Fragment key={`${item.project}-${item.message}`}>
                    {i > 0 ? <Separator /> : null}
                    <AttentionRow item={item} />
                  </Fragment>
                ))}
              </PageRows>
            )}
          </PageSection>
          <PageSection title="Projects">
            {data.projects.length === 0 ? (
              <PageEmpty>
                No projects yet. Add one to ~/.claude/cockpit-projects.txt.
              </PageEmpty>
            ) : (
              <PageRows>
                {data.projects.map((p, i) => (
                  <Fragment key={p.name}>
                    {i > 0 ? <Separator /> : null}
                    <ProjectCard project={p} />
                  </Fragment>
                ))}
              </PageRows>
            )}
          </PageSection>
        </>
      )}
    </PageShell>
  );
}

function ProjectCard({ project: p }: { project: CockpitProject }) {
  const title = (
    <Link
      className="type-body font-medium underline-offset-2 hover:underline"
      params={{ name: p.name }}
      to="/cockpit/projects/$name"
    >
      {p.name}
    </Link>
  );
  if (p.error) {
    return (
      <div className="flex flex-col gap-1 px-4 py-3">
        {title}
        <p className="type-sub text-red-700 dark:text-red-400" role="alert">
          {p.error}
        </p>
      </div>
    );
  }
  const run = p.runs?.[0];
  const idle = (p.sessions ?? []).filter((s) => s.status === "idle");
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {title}
        <Chip>{p.branch}</Chip>
        {p.ahead ? <Chip tone="warn">{p.ahead} ahead</Chip> : null}
        {p.behind ? <Chip tone="warn">{p.behind} behind</Chip> : null}
        {p.dirty?.count ? (
          <Chip tone="warn">{p.dirty.count} uncommitted</Chip>
        ) : (
          <Chip tone="good">clean</Chip>
        )}
      </div>
      <div className="type-sub flex flex-col gap-1 text-muted-foreground">
        {(p.prs ?? []).length ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {p.prs?.length} open PR{p.prs?.length === 1 ? "" : "s"}
            </span>
            {p.prs?.map((pr) => (
              <External href={pr.url} key={pr.number}>
                #{pr.number}{" "}
                <Chip tone={checksTone(pr.checks)}>
                  {checksLabel(pr.checks)}
                </Chip>
              </External>
            ))}
          </div>
        ) : null}
        {run ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>Latest run</span>
            <Chip tone={runState(run).tone}>{runState(run).label}</Chip>
            <External href={run.url}>{run.workflow}</External>
            <span>{agoSeconds(run.t)}</span>
          </div>
        ) : null}
        {p.notes?.nextStep ? (
          <p className="line-clamp-2 text-foreground">
            Next: {p.notes.nextStep}
          </p>
        ) : null}
        {idle.length ? (
          <p>
            {idle.length} idle session{idle.length === 1 ? "" : "s"}, last{" "}
            {agoMillis(Math.max(...idle.map((s) => s.updatedAt)))}
          </p>
        ) : null}
      </div>
    </div>
  );
}
