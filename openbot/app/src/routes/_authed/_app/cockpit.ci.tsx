import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Chip,
  CockpitProblem,
  External,
  agoSeconds,
  runState,
  type Tone,
} from "@/components/cockpit/parts";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  type CiFacts,
  type CiRepo,
  ciKeys,
  ciQueryOptions,
  controlRunner,
  type GithubRunner,
  runDuration,
  runnerState,
  type RunnerState,
} from "@/lib/cockpit/ci";
import { machineKeys } from "@/lib/cockpit/machine";

/** Self-hosted runners per repository, queued jobs and recent runs; pause or resume a runner on this Mac. */
export const Route = createFileRoute("/_authed/_app/cockpit/ci")({
  component: CockpitCi,
});

const STATE_TONE: Record<RunnerState, Tone> = {
  idle: "good",
  busy: "warn",
  offline: "bad",
  paused: "plain",
};

function RunnerRow({
  runner,
  repo,
  ci,
}: {
  runner: GithubRunner;
  repo: CiRepo;
  ci: CiFacts;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const local = ci.local.find((l) => l.name === runner.name);
  const container = ci.containers.find((c) => c.runnerName === runner.name);
  const state = runnerState(runner, local, container);
  const job = repo.jobs.find((j) => j.runner === runner.name);
  const where = local
    ? `native · nice ${local.nice ?? "?"} · ${local.cpuPercent}% CPU · ${local.ramMB} MB${local.workGB !== null ? ` · _work ${local.workGB} GB` : ""}${local.serviceLoaded ? "" : " · no launchd service loaded"}`
    : container
      ? `container ${container.name} · ${container.cpu} CPU · ${container.mem}`
      : "not on this Mac";

  async function act(action: "pause" | "resume", force = false) {
    setWorking(true);
    setMessage(null);
    try {
      const result = await controlRunner(runner.name, action, force);
      if (!result.ok && result.busy) {
        if (
          window.confirm(
            `${runner.name} is running a job. Pausing it now stops that job. Pause anyway?`,
          )
        ) {
          await act(action, true);
        }
        return;
      }
      if (!result.ok) setMessage(result.message);
      else if (action === "pause")
        setMessage("Paused. It starts again if you log out and in, or resume it here.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Cockpit is off.");
    } finally {
      setWorking(false);
      await queryClient.invalidateQueries({ queryKey: ciKeys.all });
      await queryClient.invalidateQueries({ queryKey: machineKeys.all });
    }
  }

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="type-sub min-w-0 flex-1">
        <div>
          <span className="font-medium">{runner.name}</span>
          <span className="text-muted-foreground"> {runner.os}</span>
        </div>
        <div className="type-caption text-muted-foreground">
          {job ? `running ${job.name} (${job.branch}) · ` : ""}
          {where}
        </div>
        {message ? <div className="type-caption mt-1">{message}</div> : null}
      </div>
      <Chip tone={STATE_TONE[state]}>{state}</Chip>
      {local || container ? (
        <Button
          disabled={working}
          onClick={() => void act(state === "paused" ? "resume" : "pause")}
          size="sm"
          variant="outline"
        >
          {state === "paused" ? "Resume" : "Pause"}
        </Button>
      ) : null}
    </div>
  );
}

function RepoSection({ repo, ci }: { repo: CiRepo; ci: CiFacts }) {
  const queued = repo.jobs.filter((j) => j.status === "queued");
  return (
    <PageSection
      description={repo.projects.length ? repo.projects.join(", ") : undefined}
      title={repo.repo}
    >
      <External href={`https://github.com/${repo.repo}/actions`}>
        <span className="type-sub">Actions</span>
      </External>
      {repo.error ? (
        <p className="type-sub mt-2" role="alert">
          {repo.error}
        </p>
      ) : null}
      {repo.runners.length === 0 ? (
        <PageEmpty>No self-hosted runner. Jobs use GitHub's runners.</PageEmpty>
      ) : (
        <PageRows>
          {repo.runners.map((r) => (
            <RunnerRow ci={ci} key={r.name} repo={repo} runner={r} />
          ))}
        </PageRows>
      )}
      {queued.length > 0 ? (
        <PageRows>
          {queued.map((j) => (
            <div
              className="type-sub flex gap-3 px-4 py-3"
              key={`${j.workflow}-${j.name}-${j.started ?? ""}-${j.branch}`}
            >
              <Chip tone="warn">waiting</Chip>
              <span>
                {j.workflow} · {j.name} ({j.branch})
              </span>
            </div>
          ))}
        </PageRows>
      ) : null}
      {repo.runs.length === 0 ? (
        <PageEmpty>No runs yet.</PageEmpty>
      ) : (
        <PageRows>
          {repo.runs.map((run) => {
            const st = runState(run);
            return (
              <div
                className="type-sub flex items-center gap-3 px-4 py-2"
                key={run.id}
              >
                <Chip tone={st.tone}>{st.label}</Chip>
                <span className="min-w-0 flex-1 truncate">
                  <External href={run.url}>{run.workflow}</External>
                  {run.attempt > 1 ? (
                    <span className="ml-2">
                      <Chip>try {run.attempt}</Chip>
                    </span>
                  ) : null}
                </span>
                <span className="hidden max-w-40 truncate text-muted-foreground sm:block">
                  {run.branch}
                </span>
                <span className="text-muted-foreground">
                  {runDuration(run.started, run.updated)}
                </span>
                <span className="text-muted-foreground">
                  {agoSeconds(run.t)}
                </span>
              </div>
            );
          })}
        </PageRows>
      )}
    </PageSection>
  );
}

function CockpitCi() {
  const { data, error, isPending } = useQuery(ciQueryOptions());
  return (
    <PageShell
      backButton={{ label: "Cockpit", linkProps: { to: "/cockpit/projects" } }}
      description="Self-hosted runners, queued jobs and recent runs. GitHub is read only while this page is open."
      title="CI"
      width="wide"
    >
      {error ? (
        <CockpitProblem error={error} />
      ) : isPending ? (
        <PageEmpty>Loading…</PageEmpty>
      ) : data.repos.length === 0 ? (
        <PageEmpty>No GitHub repository found for your projects or runners.</PageEmpty>
      ) : (
        data.repos.map((repo) => (
          <RepoSection ci={data} key={repo.repo} repo={repo} />
        ))
      )}
    </PageShell>
  );
}
