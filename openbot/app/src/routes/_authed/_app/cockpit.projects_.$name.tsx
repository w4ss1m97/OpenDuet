import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import {
  AttentionRow,
  agoMillis,
  agoSeconds,
  Chip,
  CockpitProblem,
  checksLabel,
  checksTone,
  External,
  runState,
} from "@/components/cockpit/parts";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cockpitProjectQueryOptions } from "@/lib/cockpit/queries";
import { resumePrompt } from "@/lib/cockpit/resume-prompt";

/** One project in full. Reached from a card on /cockpit/projects. */
export const Route = createFileRoute("/_authed/_app/cockpit/projects_/$name")({
  component: CockpitProject,
});

function Rows({ children }: { children: React.ReactNode[] }) {
  return (
    <PageRows>
      {children.map((child, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are static for one render
        <Fragment key={i}>
          {i > 0 ? <Separator /> : null}
          <div className="type-sub flex flex-wrap items-center gap-2 px-4 py-3">
            {child}
          </div>
        </Fragment>
      ))}
    </PageRows>
  );
}

function CopyResume({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      size="lg"
      type="button"
    >
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? "Copied" : "Copy resume prompt"}
    </Button>
  );
}

function CockpitProject() {
  const { name } = Route.useParams();
  const { data, error, isPending } = useQuery(cockpitProjectQueryOptions(name));
  const backButton = {
    label: "Cockpit",
    linkProps: { to: "/cockpit/projects" as const },
  };

  if (error || isPending) {
    return (
      <PageShell backButton={backButton} title={name}>
        {error ? (
          <CockpitProblem error={error} />
        ) : (
          <PageEmpty>Loading…</PageEmpty>
        )}
      </PageShell>
    );
  }
  const { project: p, attention } = data;
  if (p.error) {
    return (
      <PageShell backButton={backButton} title={p.name}>
        <PageEmpty>{p.error}</PageEmpty>
      </PageShell>
    );
  }

  return (
    <PageShell
      action={
        <div className="flex items-center gap-2">
          <Button
            render={
              <Link
                params={{ name: p.name }}
                to="/cockpit/projects/$name/explore"
              />
            }
            size="lg"
            variant="outline"
          >
            Explore
          </Button>
          <CopyResume text={resumePrompt(p)} />
        </div>
      }
      backButton={backButton}
      description={`${p.path} · ${p.branch}${p.ahead ? ` · ${p.ahead} ahead` : ""}${p.behind ? ` · ${p.behind} behind` : ""}${p.dirty?.count ? ` · ${p.dirty.count} uncommitted` : ""}`}
      title={p.name}
    >
      {attention.length ? (
        <PageSection title="Needs attention">
          <PageRows>
            {attention.map((item, i) => (
              <Fragment key={item.message}>
                {i > 0 ? <Separator /> : null}
                <AttentionRow item={item} />
              </Fragment>
            ))}
          </PageRows>
        </PageSection>
      ) : null}

      <PageSection title="Session notes">
        {p.notes ? (
          <PageRows>
            {p.notes.sections.map((s, i) => (
              <Fragment key={s.title}>
                {i > 0 ? <Separator /> : null}
                <div className="px-4 py-3">
                  <h3 className="type-sub font-medium">{s.title}</h3>
                  <p className="type-sub mt-1 whitespace-pre-wrap text-muted-foreground">
                    {s.text}
                  </p>
                </div>
              </Fragment>
            ))}
          </PageRows>
        ) : (
          <PageEmpty>No session notes.</PageEmpty>
        )}
      </PageSection>

      <PageSection title="Recent commits">
        {p.commits?.length ? (
          <Rows>
            {p.commits.map((c) => (
              <Fragment key={c.sha}>
                <span className="text-muted-foreground tabular-nums">
                  {c.sha}
                </span>
                {c.url ? (
                  <External href={c.url}>{c.subject}</External>
                ) : (
                  c.subject
                )}
                <span className="ml-auto text-muted-foreground">
                  {agoSeconds(c.t)}
                </span>
              </Fragment>
            ))}
          </Rows>
        ) : (
          <PageEmpty>No commits yet.</PageEmpty>
        )}
      </PageSection>

      <PageSection title="Worktrees">
        {p.worktrees?.length ? (
          <Rows>
            {p.worktrees.map((w) => (
              <Fragment key={w.path}>
                <span className="font-medium">{w.branch}</span>
                {w.ahead ? (
                  <Chip tone={w.prMerged ? "plain" : "warn"}>
                    {w.ahead} ahead
                  </Chip>
                ) : null}
                {w.dirty ? <Chip tone="warn">{w.dirty} dirty</Chip> : null}
                {w.prMerged ? <Chip tone="good">PR merged</Chip> : null}
                <span className="ml-auto truncate text-muted-foreground">
                  {w.path}
                </span>
              </Fragment>
            ))}
          </Rows>
        ) : (
          <PageEmpty>No other worktrees.</PageEmpty>
        )}
      </PageSection>

      <PageSection title="Pull requests">
        {p.prs?.length ? (
          <Rows>
            {p.prs.map((pr) => (
              <Fragment key={pr.number}>
                <Chip tone={checksTone(pr.checks)}>
                  {checksLabel(pr.checks)}
                </Chip>
                <External href={pr.url}>
                  #{pr.number} {pr.title}
                </External>
                {pr.draft ? <Chip>draft</Chip> : null}
                {pr.mergeState === "DIRTY" ? (
                  <Chip tone="bad">conflicts</Chip>
                ) : null}
              </Fragment>
            ))}
          </Rows>
        ) : (
          <PageEmpty>
            {p.prs === null
              ? "Couldn't read pull requests."
              : "No open pull requests."}
          </PageEmpty>
        )}
      </PageSection>

      <PageSection title="CI runs">
        {p.runs?.length ? (
          <Rows>
            {p.runs.slice(0, 10).map((r) => (
              <Fragment key={r.id}>
                <Chip tone={runState(r).tone}>{runState(r).label}</Chip>
                <External href={r.url}>
                  {r.workflow} · {r.branch}
                </External>
                <span className="ml-auto text-muted-foreground">
                  {agoSeconds(r.t)}
                </span>
              </Fragment>
            ))}
          </Rows>
        ) : (
          <PageEmpty>
            {p.runs === null ? "Couldn't read CI runs." : "No CI runs yet."}
          </PageEmpty>
        )}
      </PageSection>

      <PageSection title="Claude sessions">
        {p.sessions?.length ? (
          <Rows>
            {p.sessions.map((s) => (
              <Fragment key={s.sessionId}>
                <span className="font-medium">
                  {s.name || s.sessionId.slice(0, 8)}
                </span>
                <Chip tone={s.status === "idle" ? "warn" : "good"}>
                  {s.status}
                </Chip>
                <span className="ml-auto text-muted-foreground">
                  {agoMillis(s.updatedAt)}
                </span>
              </Fragment>
            ))}
          </Rows>
        ) : (
          <PageEmpty>No sessions running.</PageEmpty>
        )}
      </PageSection>
    </PageShell>
  );
}
