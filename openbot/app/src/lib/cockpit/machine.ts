import { queryOptions } from "@tanstack/react-query";
import { read } from "./queries";

/*
 * Machine (C3): load, memory, disk and the Docker VM of this Mac, from the cockpit server on 127.0.0.1.
 * Types mirror server/src/openduet/cockpit/machine.ts.
 */

export type Thresholds = {
  loadPerCoreWarn: number;
  ramFreeWarnPercent: number;
  diskFreeWarnGB: number;
};

export type DockerContainer = {
  name: string;
  runnerName: string | null;
  status: string;
  cpu: string;
  mem: string;
  paused: boolean;
};

export type DockerFacts =
  | { running: false }
  | {
      running: true;
      cpus: number;
      memGB: number;
      containers: DockerContainer[];
      disk: Record<string, { size: string; reclaimable: string }>;
    };

export type MachineFacts = {
  cores: number;
  load: number[];
  memTotalGB: number;
  memFreePercent: number | null;
  diskFreeGB: number;
  diskTotalGB: number;
  thresholds: Thresholds;
  docker: DockerFacts | null;
};

export type Level = "ok" | "warn" | "bad";

/** CPU load per core as a percentage of one core per core; warns from 70% of the threshold. */
export function cpuGauge(m: MachineFacts): { pct: number; level: Level } {
  const perCore = m.load[0]! / Math.max(1, m.cores);
  const warn = m.thresholds.loadPerCoreWarn;
  return {
    pct: perCore * 100,
    level: perCore > warn ? "bad" : perCore > warn * 0.7 ? "warn" : "ok",
  };
}

/** Memory used (100 - free); an unknown free percentage is shown without a colour. */
export function memGauge(m: MachineFacts): { used: number | null; level: Level } {
  const free = m.memFreePercent;
  if (free === null) return { used: null, level: "ok" };
  const warn = m.thresholds.ramFreeWarnPercent;
  return {
    used: 100 - free,
    level: free < warn ? "bad" : free < warn * 1.5 ? "warn" : "ok",
  };
}

export function diskGauge(m: MachineFacts): { pct: number; level: Level } {
  if (m.diskTotalGB <= 0) return { pct: 0, level: "ok" };
  return {
    pct: 100 - (m.diskFreeGB / m.diskTotalGB) * 100,
    level: m.diskFreeGB < m.thresholds.diskFreeWarnGB ? "bad" : "ok",
  };
}

export const machineKeys = { all: ["cockpit", "machine"] as const };

export const machineQueryOptions = () =>
  queryOptions({
    queryKey: machineKeys.all,
    queryFn: ({ signal }): Promise<MachineFacts> =>
      read("/api/cockpit/machine", signal),
    refetchInterval: 30_000,
    retry: false,
  });
