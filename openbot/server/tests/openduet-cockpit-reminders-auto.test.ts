import { describe, expect, test } from "bun:test";
import type { CockpitPr, CockpitRun } from "../src/openduet/cockpit/types";
import { NOON, cfgWith, makeEnv, project, service, snap } from "./reminders-fixtures.helper";

const run = (over: Partial<CockpitRun> = {}): CockpitRun => ({
  id: 1, wid: 7, dynamic: false, workflow: "CI", branch: "main", status: "completed", conclusion: "failure", url: "https://x/r",
  updated: "", t: NOON - 1800, started: null, attempt: 1, ...over,
});
const pr = (over: Partial<CockpitPr> = {}): CockpitPr => ({ number: 4, title: "Fix", branch: "f", url: "https://x/p", draft: false, mergeState: "CLEAN", checks: "success", updated: "", ...over });
const autos = async (s: ReturnType<typeof service>) => (await s.list()).items.filter((i) => i.kind === "auto");

describe("automatic reminders", () => {
  test("ci red: nothing before ciRedHours, an item after", async () => {
    const env = makeEnv();
    env.data.snapshot = snap(project({ runs: [run()] }));
    const s = service(env);
    expect(await autos(s)).toHaveLength(0);
    env.clock.t = NOON + 1801;
    const items = await autos(s);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^a[0-9a-f]{15}$/);
    expect(items[0]!.state).toBe("due");
  });

  test("ci: dynamic runs and non-default branches are ignored; a later green run clears it", async () => {
    const env = makeEnv();
    env.clock.t = NOON + 7200;
    env.data.snapshot = snap(project({ runs: [run({ dynamic: true }), run({ branch: "dev", id: 2 })] }));
    const s = service(env);
    expect(await autos(s)).toHaveLength(0);
    env.data.snapshot = snap(project({ runs: [run(), run({ conclusion: "success", t: NOON + 100, id: 3 })] }));
    expect(await autos(s)).toHaveLength(0);
  });

  test("pr: counted from first seen, not draft, not dirty or behind", async () => {
    const env = makeEnv();
    env.data.snapshot = snap(project({ prs: [pr(), pr({ number: 5, draft: true }), pr({ number: 6, mergeState: "DIRTY" }), pr({ number: 7, mergeState: "BEHIND" })] }));
    const s = service(env);
    expect(await autos(s)).toHaveLength(0);
    env.clock.t = NOON + 23 * 3600;
    expect(await autos(s)).toHaveLength(0);
    env.clock.t = NOON + 24 * 3600;
    const items = await autos(s);
    expect(items).toHaveLength(1);
    expect(items[0]!.text).toContain("#4");
  });

  test("dirty after dirtyDays", async () => {
    const env = makeEnv();
    env.data.snapshot = snap(project({ dirty: { count: 3, oldest: NOON - 3 * 86400, files: [] } }));
    expect(await autos(service(env))).toHaveLength(1);
    env.data.snapshot = snap(project({ dirty: { count: 3, oldest: NOON - 86400, files: [] } }));
    expect(await autos(service(env))).toHaveLength(0);
  });

  test("ack is held while the condition lasts, cleared on a complete snapshot, kept when prs is null", async () => {
    const env = makeEnv();
    env.clock.t = NOON + 7200;
    env.data.snapshot = snap(project({ runs: [run()] }));
    const s = service(env);
    const [item] = await autos(s);
    expect(await s.act(item!.id, "done")).toEqual({ ok: true });
    expect(await autos(s)).toHaveLength(0);
    // a gh outage: prs null, no run list -> the ack must survive it
    env.data.snapshot = snap(project({ prs: null, runs: null }));
    await autos(s);
    env.data.snapshot = snap(project({ runs: [run()] }));
    expect(await autos(s)).toHaveLength(0);
    // the condition clears on a complete snapshot, then comes back: a new reminder
    env.data.snapshot = snap(project({ runs: [] }));
    await autos(s);
    env.data.snapshot = snap(project({ runs: [run()] }));
    expect(await autos(s)).toHaveLength(1);
  });

  test("snooze hides until the time, then it is back", async () => {
    const env = makeEnv();
    env.clock.t = NOON + 7200;
    env.data.snapshot = snap(project({ runs: [run()] }));
    const s = service(env);
    const [item] = await autos(s);
    await s.act(item!.id, "snooze", env.clock.t + 600);
    expect(await autos(s)).toHaveLength(0);
    env.clock.t += 601;
    expect(await autos(s)).toHaveLength(1);
  });

  test("budget 80 and 100, quality high findings immediately", async () => {
    const env = makeEnv();
    env.data.budgets = [{ scope: "overall", pct: 0.85 }, { scope: "P", pct: 1.2 }, { scope: "Q", pct: 0.5 }];
    env.data.quality = [{ name: "P", high: [{ key: "secrets", text: "1 possible secret(s)" }] }];
    const items = await autos(service(env));
    expect(items.map((i) => i.text).sort()).toEqual(["P is at 120% of its weekly budget", "P: 1 possible secret(s)", "overall is at 85% of its weekly budget"]);
    expect(items.every((i) => i.state === "due")).toBe(true);
  });

  test("budgetPercent is read from the config", async () => {
    const env = makeEnv();
    env.cfg.value = cfgWith({ autoReminders: { budgetPercent: 90 } });
    env.data.budgets = [{ scope: "overall", pct: 0.85 }];
    expect(await autos(service(env))).toHaveLength(0);
  });

  test("a project with an error gives nothing", async () => {
    const env = makeEnv();
    env.clock.t = NOON + 7200;
    env.data.snapshot = snap(project({ error: "git failed", runs: [run()] }));
    expect(await autos(service(env))).toHaveLength(0);
  });
});
