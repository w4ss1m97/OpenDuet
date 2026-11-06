import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COCKPIT_CONFIG, type CockpitConfig } from "../src/openduet/cockpit/cockpit-config";
import type { Notifier } from "../src/openduet/cockpit/notify";
import { createRemindersService } from "../src/openduet/cockpit/reminders";
import type { Spawn } from "../src/openduet/cockpit/run";
import type { CockpitSnapshot, ProjectData } from "../src/openduet/cockpit/types";

/** 2026-11-02 12:00 Paris (UTC+1). */
export const NOON = Date.UTC(2026, 10, 2, 11, 0, 0) / 1000;

export const cfgWith = (patch: { autoReminders?: Partial<CockpitConfig["autoReminders"]>; notifications?: Partial<CockpitConfig["notifications"]> } = {}): CockpitConfig => ({
  ...DEFAULT_COCKPIT_CONFIG,
  autoReminders: { ...DEFAULT_COCKPIT_CONFIG.autoReminders, ...patch.autoReminders },
  notifications: { ...DEFAULT_COCKPIT_CONFIG.notifications, ...patch.notifications },
});

export function project(over: Partial<ProjectData> = {}): ProjectData {
  return { name: "P", path: "~/p", error: null, default: "main", prs: [], runs: [], dirty: { count: 0, oldest: null, files: [] }, ...over };
}

export const snap = (...projects: ProjectData[]): CockpitSnapshot => ({ projects, attention: [], names: projects.map((p) => p.name), generatedAt: 1 });

export type Env = {
  clock: { t: number };
  sent: Array<[string, string]>;
  cfg: { value: CockpitConfig };
  data: { snapshot: CockpitSnapshot; budgets: Array<{ scope: string; pct: number }>; quality: Array<{ name: string; high: Array<{ key: string; text: string }> }> };
  dir: string;
};

export function makeEnv(dir = mkdtempSync(join(tmpdir(), "reminders-")), shared?: Pick<Env, "clock" | "sent" | "cfg" | "data">): Env {
  return {
    clock: shared?.clock ?? { t: NOON },
    sent: shared?.sent ?? [],
    cfg: shared?.cfg ?? { value: cfgWith() },
    data: shared?.data ?? { snapshot: snap(project()), budgets: [], quality: [] },
    dir,
  };
}

export function service(env: Env, over: { notifier?: Notifier; fail?: boolean } = {}) {
  const notifier: Notifier = over.notifier ?? { send: async (t, b) => { env.sent.push([t, b]); return !over.fail; } };
  return createRemindersService({
    config: async () => ({ config: env.cfg.value, error: null }),
    snapshot: async () => env.data.snapshot,
    budgets: async () => env.data.budgets,
    quality: async () => ({ projects: env.data.quality }),
    listProjects: () => env.data.snapshot.projects.map((p) => ({ name: p.name, path: `/x/${p.name}` })),
    notifier, now: () => env.clock.t * 1000, userPath: join(env.dir, "reminders.json"), statePath: join(env.dir, "reminder-state.json"),
  });
}

/** A spawn that records argv and never starts a process. */
export function fakeSpawn(calls: string[][], code = 0): Spawn {
  return (argv) => {
    calls.push(argv);
    return { stdout: new Response("").body!, exited: Promise.resolve(code), kill: () => undefined };
  };
}
