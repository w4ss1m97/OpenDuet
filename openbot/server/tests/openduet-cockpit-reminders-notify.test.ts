import { describe, expect, test } from "bun:test";
import { createNotifier } from "../src/openduet/cockpit/notify";
import { inQuietHours } from "../src/openduet/cockpit/reminders";
import { DEFAULT_COCKPIT_CONFIG, parseCockpitConfig } from "../src/openduet/cockpit/cockpit-config";
import { NOON, cfgWith, fakeSpawn, makeEnv, service } from "./reminders-fixtures.helper";

const ON = { enabled: true, quietEnabled: false };
const addDue = async (s: ReturnType<typeof service>, text: string, due: number) => {
  const out = await s.add({ text, due: String(due) });
  if (!out.ok) throw new Error(out.error);
};

describe("notifier", () => {
  test("exact argv, text as data after --", async () => {
    const calls: string[][] = [];
    const ok = await createNotifier({ spawn: fakeSpawn(calls) }).send('x" & do shell script "evil', "line1\nline2");
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 8)).toEqual(["/usr/bin/osascript", "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--"]);
    expect(calls[0]![8]).toBe('x" & do shell script "evil');
    expect(calls[0]![9]).toBe("line1 line2");
  });

  test("control chars stripped, title 80, body 240; a failing exit is false", async () => {
    const calls: string[][] = [];
    await createNotifier({ spawn: fakeSpawn(calls) }).send("a\u0000b".padEnd(200, "t"), "c\u001b".padEnd(500, "d"));
    expect(calls[0]![8]!.length).toBe(80);
    expect(calls[0]![9]!.length).toBe(240);
    expect(calls[0]!.slice(8).join("")).not.toMatch(/\p{Cc}/u);
    expect(await createNotifier({ spawn: fakeSpawn([], 1) }).send("a", "b")).toBe(false);
  });
});

describe("quiet hours", () => {
  const cfg = DEFAULT_COCKPIT_CONFIG.notifications;
  const at = (h: number, m = 0) => Date.UTC(2026, 10, 2, h - 1, m) / 1000; // Paris is UTC+1 in November
  test("22:00-08:00 crosses midnight", () => {
    expect(inQuietHours(cfg, at(21, 59), "Europe/Paris")).toBe(false);
    expect(inQuietHours(cfg, at(22, 0), "Europe/Paris")).toBe(true);
    expect(inQuietHours(cfg, at(2, 0), "Europe/Paris")).toBe(true);
    expect(inQuietHours(cfg, at(7, 59), "Europe/Paris")).toBe(true);
    expect(inQuietHours(cfg, at(8, 0), "Europe/Paris")).toBe(false);
  });
  test("a same-day window and a disabled one", () => {
    const day = { ...cfg, quietStart: "12:00", quietEnd: "14:00" };
    expect(inQuietHours(day, at(13), "Europe/Paris")).toBe(true);
    expect(inQuietHours(day, at(14), "Europe/Paris")).toBe(false);
    expect(inQuietHours({ ...cfg, quietEnabled: false }, at(23), "Europe/Paris")).toBe(false);
  });
});

describe("sending", () => {
  test("disabled by default: nothing is sent", async () => {
    const env = makeEnv();
    const s = service(env);
    await addDue(s, "late", NOON - 100);
    expect(await s.tick()).toBe(0);
    expect(env.sent).toHaveLength(0);
  });

  test("a due reminder goes out once, also across a restart", async () => {
    const env = makeEnv();
    env.cfg.value = cfgWith({ notifications: ON });
    const s = service(env);
    await addDue(s, "late", NOON - 100);
    expect(await s.tick()).toBe(1);
    expect(await s.tick()).toBe(0);
    expect(await service(env).tick()).toBe(0);
    expect(env.sent).toEqual([["Cockpit reminder", "late"]]);
  });

  test("quiet hours hold it, then it is sent after", async () => {
    const env = makeEnv();
    env.cfg.value = cfgWith({ notifications: { enabled: true } });
    env.clock.t = Date.UTC(2026, 10, 2, 22, 30) / 1000; // 23:30 Paris
    const s = service(env);
    await addDue(s, "late", env.clock.t - 100);
    expect(await s.tick()).toBe(0);
    expect((await s.list()).notifications.quietNow).toBe(true);
    env.clock.t = Date.UTC(2026, 10, 3, 7, 5) / 1000; // 08:05 Paris
    expect(await s.tick()).toBe(1);
  });

  test("the 7th in an hour waits for the next window", async () => {
    const env = makeEnv();
    env.cfg.value = cfgWith({ notifications: ON });
    const s = service(env);
    for (let i = 0; i < 7; i++) await addDue(s, `r${i}`, NOON - 100 - i);
    expect(await s.tick()).toBe(6);
    expect(await s.tick()).toBe(0);
    env.clock.t = NOON + 3601;
    expect(await s.tick()).toBe(1);
    expect(env.sent).toHaveLength(7);
  });

  test("a failed send is not remembered as sent", async () => {
    const env = makeEnv();
    env.cfg.value = cfgWith({ notifications: ON });
    await addDue(service(env), "late", NOON - 100);
    expect(await service(env, { fail: true }).tick()).toBe(0);
    expect(await service(env).tick()).toBe(1);
  });

  test("the test notification works while disabled, once a minute", async () => {
    const env = makeEnv();
    const s = service(env);
    expect(await s.testNotification()).toEqual({ kind: "ok" });
    expect(await s.testNotification()).toMatchObject({ kind: "rate" });
    env.clock.t += 61;
    expect(await s.testNotification()).toEqual({ kind: "ok" });
    expect(env.sent).toHaveLength(2);
  });

  test("list reports enabled, quietNow and lastSentAt", async () => {
    const env = makeEnv();
    env.cfg.value = cfgWith({ notifications: ON });
    const s = service(env);
    await addDue(s, "late", NOON - 100);
    await s.tick();
    expect((await s.list()).notifications).toEqual({ enabled: true, quietNow: false, lastSentAt: NOON });
  });
});

describe("cockpit-config", () => {
  test("defaults: notifications off, quality as in the spec", () => {
    const { config, error } = parseCockpitConfig(null);
    expect(error).toBeNull();
    expect(config.notifications).toEqual({ enabled: false, quietEnabled: true, quietStart: "22:00", quietEnd: "08:00", maxPerHour: 6 });
    expect(config.quality).toEqual({ enabled: true, scanHours: 24, lookbackDays: 30, bigFileLines: 800, staleBranchDays: 30, npm: true });
    expect(config.autoReminders).toEqual({ ciRedHours: 1, prWaitHours: 24, dirtyDays: 2, budgetPercent: 80 });
  });
  test("partial files keep the other defaults; invalid ones fall back with an error", () => {
    expect(parseCockpitConfig('{"notifications":{"enabled":true}}').config.notifications.quietStart).toBe("22:00");
    for (const bad of ['{"quality":{"scanHours":0}}', '{"quality":{"lookbackDays":6}}', '{"notifications":{"quietStart":"25:00"}}', '{"extra":1}', "[", '{"quality":{"scanHours":"a"}}']) {
      const out = parseCockpitConfig(bad);
      expect(out.error).not.toBeNull();
      expect(out.config).toEqual(DEFAULT_COCKPIT_CONFIG);
    }
  });
});
