import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CockpitProblem } from "@/components/cockpit/parts";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import {
  cpuGauge,
  diskGauge,
  type Level,
  type MachineFacts,
  machineQueryOptions,
  memGauge,
} from "@/lib/cockpit/machine";
import { cn } from "@/lib/utils";

/** Load, memory and disk of this Mac and its Docker VM, with the colours of the thresholds. */
export const Route = createFileRoute("/_authed/_app/cockpit/machine")({
  component: CockpitMachine,
});

const BAR: Record<Level, string> = {
  ok: "bg-primary",
  warn: "bg-amber-500",
  bad: "bg-red-500",
};

function Gauge({
  label,
  value,
  pct,
  level,
  sub,
}: {
  label: string;
  value: string;
  pct: number;
  level: Level;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="type-sub text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-medium">{value}</div>
      <div
        aria-hidden
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full", BAR[level])}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="type-caption mt-2 text-muted-foreground">{sub}</div>
    </div>
  );
}

function Gauges({ m }: { m: MachineFacts }) {
  const cpu = cpuGauge(m);
  const mem = memGauge(m);
  const disk = diskGauge(m);
  const docker = m.docker;
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2">
      <Gauge
        label="CPU load"
        level={cpu.level}
        pct={cpu.pct}
        sub={`5 min ${m.load[1]?.toFixed(1)} · 15 min ${m.load[2]?.toFixed(1)}`}
        value={`${m.load[0]?.toFixed(1)} / ${m.cores} cores`}
      />
      <Gauge
        label="Memory"
        level={mem.level}
        pct={mem.used ?? 0}
        sub={`${m.memTotalGB} GB total · ${m.memFreePercent ?? "?"}% free`}
        value={mem.used === null ? "?" : `${mem.used}% used`}
      />
      <Gauge
        label="Disk"
        level={disk.level}
        pct={disk.pct}
        sub={`of ${m.diskTotalGB} GB`}
        value={`${m.diskFreeGB} GB free`}
      />
      {docker ? (
        docker.running ? (
          <Gauge
            label="Docker VM"
            level="ok"
            pct={0}
            sub={`${docker.cpus} CPUs · ${docker.memGB} GB · reclaimable ${docker.disk.Images?.reclaimable ?? "?"} images, ${docker.disk["Build Cache"]?.reclaimable ?? "?"} cache`}
            value={`${docker.containers.length} containers`}
          />
        ) : (
          <Gauge
            label="Docker VM"
            level="ok"
            pct={0}
            sub="Docker Desktop is off"
            value="not running"
          />
        )
      ) : null}
    </div>
  );
}

function CockpitMachine() {
  const { data, error, isPending } = useQuery(machineQueryOptions());
  const containers = data?.docker?.running ? data.docker.containers : [];
  return (
    <PageShell
      backButton={{ label: "Cockpit", linkProps: { to: "/cockpit/projects" } }}
      description="This Mac right now. Refreshed every 30 seconds."
      title="Machine"
      width="wide"
    >
      {error ? (
        <CockpitProblem error={error} />
      ) : isPending ? (
        <PageEmpty>Loading…</PageEmpty>
      ) : (
        <>
          <Gauges m={data} />
          {containers.length > 0 ? (
            <PageSection title="Docker containers">
              <PageRows>
                {containers.map((c) => (
                  <div
                    className="type-sub grid grid-cols-[1fr_1fr_6rem_5rem_6rem] gap-3 border-border border-b px-4 py-3 last:border-b-0"
                    key={c.name}
                  >
                    <span className="truncate font-medium">{c.name}</span>
                    <span className="truncate text-muted-foreground">
                      {c.runnerName ?? "—"}
                    </span>
                    <span>{c.status}</span>
                    <span>{c.cpu}</span>
                    <span>{c.mem}</span>
                  </div>
                ))}
              </PageRows>
            </PageSection>
          ) : null}
        </>
      )}
    </PageShell>
  );
}
