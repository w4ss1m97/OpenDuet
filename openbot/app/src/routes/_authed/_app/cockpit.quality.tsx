import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { CockpitProblem, agoSeconds } from "@/components/cockpit/parts";
import { GradeChip } from "@/components/cockpit/quality-parts";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  qualityKeys,
  qualityQueryOptions,
  requestScan,
} from "@/lib/cockpit/quality";

/** The quality grade of each project, and a button to scan them all. */
export const Route = createFileRoute("/_authed/_app/cockpit/quality")({
  component: CockpitQuality,
});

function CockpitQuality() {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery(qualityQueryOptions());
  const [message, setMessage] = useState<string | null>(null);

  async function scanAll() {
    setMessage(null);
    try {
      const r = await requestScan("all");
      if (!r.ok) setMessage(r.message);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Cockpit is off.");
    }
    await queryClient.invalidateQueries({ queryKey: qualityKeys.all });
  }

  const scanning = data?.status.scanning;
  return (
    <PageShell
      action={
        <Button disabled={!!scanning} onClick={() => void scanAll()} size="lg" variant="outline">
          {scanning ? `Scanning ${scanning}…` : "Scan all"}
        </Button>
      }
      backButton={{ label: "Cockpit", linkProps: { to: "/cockpit/projects" } }}
      description="Tests, dependencies, security, code health and hygiene, per project."
      title="Quality"
    >
      {message ? (
        <p className="type-sub mt-4" role="alert">
          {message}
        </p>
      ) : null}
      {error ? (
        <CockpitProblem error={error} />
      ) : isPending ? (
        <PageEmpty>Loading…</PageEmpty>
      ) : (
        <>
          {data.configError || data.storeError ? (
            <p className="type-sub mt-4 text-red-700 dark:text-red-400" role="alert">
              {data.configError ?? data.storeError}
            </p>
          ) : null}
          {data.status.lastError ? (
            <p className="type-caption mt-2 text-muted-foreground">Last scan problem: {data.status.lastError}</p>
          ) : null}
          <PageSection title="Projects">
            {data.projects.length === 0 ? (
              <PageEmpty>No scan yet. Scan all to start.</PageEmpty>
            ) : (
              <PageRows>
                {data.projects.map((p, i) => (
                  <Fragment key={p.name}>
                    {i > 0 ? <Separator /> : null}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <GradeChip grade={p.grade} score={p.score} />
                      <Link
                        className="type-body min-w-0 flex-1 truncate font-medium underline-offset-2 hover:underline"
                        params={{ name: p.name }}
                        to="/cockpit/quality/$name"
                      >
                        {p.name}
                      </Link>
                      {p.high.length ? (
                        <span className="type-caption text-red-700 dark:text-red-400">
                          {p.high.length} high
                        </span>
                      ) : null}
                      <span className="type-caption text-muted-foreground">
                        {agoSeconds(p.scannedAt)}
                      </span>
                    </div>
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
