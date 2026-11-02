import { expect, test } from "bun:test";
import { runDuration, runnerState } from "@/lib/cockpit/ci";
import { cpuGauge, diskGauge, memGauge, type MachineFacts } from "@/lib/cockpit/machine";

const base: MachineFacts = {
  cores: 8,
  load: [4, 3, 2],
  memTotalGB: 16,
  memFreePercent: 50,
  diskFreeGB: 200,
  diskTotalGB: 500,
  thresholds: { loadPerCoreWarn: 1, ramFreeWarnPercent: 20, diskFreeWarnGB: 50 },
  docker: null,
};

test("cpu gauge: load per core against the threshold, warn from 70%", () => {
  expect(cpuGauge(base)).toMatchObject({ pct: 50, level: "ok" });
  expect(cpuGauge({ ...base, load: [6, 0, 0] })).toMatchObject({ pct: 75, level: "warn" });
  expect(cpuGauge({ ...base, load: [9, 0, 0] }).level).toBe("bad");
});

test("memory gauge: used is 100 - free; unknown stays neutral", () => {
  expect(memGauge(base)).toMatchObject({ used: 50, level: "ok" });
  expect(memGauge({ ...base, memFreePercent: 25 }).level).toBe("warn");
  expect(memGauge({ ...base, memFreePercent: 10 }).level).toBe("bad");
  expect(memGauge({ ...base, memFreePercent: null })).toMatchObject({ used: null, level: "ok" });
});

test("disk gauge: bad under the threshold; an unreadable disk is neutral", () => {
  expect(diskGauge(base)).toMatchObject({ pct: 60, level: "ok" });
  expect(diskGauge({ ...base, diskFreeGB: 49 }).level).toBe("bad");
  expect(diskGauge({ ...base, diskFreeGB: 0, diskTotalGB: 0 })).toMatchObject({ pct: 0, level: "ok" });
});

test("runner state: paused wins, then offline, busy, idle", () => {
  const gh = { name: "r", status: "online", busy: false, os: "macOS", labels: [] };
  const local = { name: "r", paused: false } as never;
  expect(runnerState(gh, local, undefined)).toBe("idle");
  expect(runnerState({ ...gh, busy: true }, local, undefined)).toBe("busy");
  expect(runnerState({ ...gh, status: "offline" }, local, undefined)).toBe("offline");
  expect(runnerState(gh, { paused: true } as never, undefined)).toBe("paused");
  expect(runnerState({ ...gh, status: "offline" }, undefined, { paused: true } as never)).toBe("paused");
});

test("run duration from start to last update", () => {
  expect(runDuration("2026-11-01T00:00:00Z", "2026-11-01T00:01:05Z")).toBe("1m 05s");
  expect(runDuration("2026-11-01T00:00:00Z", "2026-11-01T01:02:00Z")).toBe("1h 02m");
  expect(runDuration("2026-11-01T00:00:00Z", "2026-11-01T00:00:09Z")).toBe("9s");
  expect(runDuration(null, "2026-11-01T00:00:09Z")).toBe("–");
});
