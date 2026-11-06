/*
 * Reminders: the ones Wassim writes (reminders.json) and the ones the attention rules raise by themselves
 * (from the cached snapshot, the usage budgets and the quality summary). What was acked, snoozed and sent is kept in
 * reminder-state.json, so a restart or a refresh never repeats a notification. Port of Cockpit reminders.py.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CockpitConfig } from "./cockpit-config";
import type { Notifier } from "./notify";
import { writeJsonAtomic } from "./quality-store";
import type { CockpitProject, CockpitSnapshot } from "./types";
import { COCKPIT_DATA_DIR } from "./usage-prices";

export const REMINDERS_PATH = join(COCKPIT_DATA_DIR, "reminders.json");
export const REMINDER_STATE_PATH = join(COCKPIT_DATA_DIR, "reminder-state.json");

const REPEAT_SECONDS = { none: 0, daily: 86400, weekly: 7 * 86400 } as const;
type Repeat = keyof typeof REPEAT_SECONDS;
const MAX_ITEMS = 200;
const TEXT_MAX = 200;
const DAY = 86400;
const SENT_KEEP_SECONDS = 30 * DAY;
const OLD_STATE_SECONDS = 90 * DAY;
const SNOOZE_MAX_SECONDS = 30 * DAY;
const TEST_EVERY_MS = 60_000;
const TICK_MS = 2 * 60_000;
const FIRST_TICK_MS = 15_000;
export const REMINDER_ID = /^[ua][0-9a-f]{15}$/;

const userItem = z.object({
  id: z.string().regex(REMINDER_ID), text: z.string(), project: z.string(), due: z.number(),
  repeat: z.enum(["none", "daily", "weekly"]), created: z.number(),
});
const userSchema = z.object({ version: z.literal(1), items: z.array(userItem) });
const num = z.record(z.string(), z.number());
const stateSchema = z.object({ version: z.literal(1), first: num, ack: num, snooze: num, sent: num });

type UserItem = z.infer<typeof userItem>;
type State = z.infer<typeof stateSchema>;
const emptyState = (): State => ({ version: 1, first: {}, ack: {}, snooze: {}, sent: {} });

export type ReminderItem = {
  id: string; kind: "user" | "auto"; text: string; project: string; link: string | null;
  due: number; repeat: Repeat; state: "due" | "upcoming"; since?: number;
};
export type RemindersResponse = {
  items: ReminderItem[];
  dueCount: number;
  notifications: { enabled: boolean; quietNow: boolean; lastSentAt: number | null };
  configError: string | null;
  storeError: string | null;
};

export type AddInput = { text?: string; due?: string; project?: string; repeat?: string };
export type AddOutcome = { ok: true; item: UserItem } | { ok: false; kind: "invalid" | "full"; error: string };
export type ActOutcome = { ok: true } | { ok: false; kind: "invalid" | "notfound"; error: string };
export type TestOutcome = { kind: "ok" } | { kind: "rate"; retryAfterSeconds: number } | { kind: "failed" };

export type RemindersService = {
  list(): Promise<RemindersResponse>;
  add(input: AddInput): Promise<AddOutcome>;
  act(id: string, action: "done" | "snooze" | "delete", until?: number): Promise<ActOutcome>;
  /** One pass: raises the automatic reminders and sends the notifications that are due. Returns how many went out. */
  tick(): Promise<number>;
  testNotification(): Promise<TestOutcome>;
  start(options?: { firstDelayMs?: number; intervalMs?: number }): () => void;
};

type Found = { key: string; text: string; project: string; link: string; since: number | null; afterSeconds: number };

const mutex = () => {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
};

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is this moment inside the quiet hours (a window that may cross midnight), in the notification time zone? */
export function inQuietHours(cfg: CockpitConfig["notifications"], nowSec: number, tz: string): boolean {
  if (!cfg.quietEnabled) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nowSec * 1000));
  const cur = Number(parts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const a = minutes(cfg.quietStart);
  const b = minutes(cfg.quietEnd);
  return a === b ? false : a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

const FAILED_CI = new Set(["failure", "timed_out", "startup_failure"]);

/** The conditions that deserve a reminder once they have lasted long enough. A project in `complete` was read fully. */
export function findAutoConditions(
  snapshot: CockpitSnapshot | null,
  budgets: Array<{ scope: string; pct: number }> | null,
  quality: Array<{ name: string; high: Array<{ key: string; text: string }> }> | null,
  cfg: CockpitConfig["autoReminders"],
): { found: Found[]; complete: Set<string> } {
  const found: Found[] = [];
  const complete = new Set<string>();
  for (const p of snapshot?.projects ?? []) {
    if (p.error || !p.prs || !p.runs) continue;
    complete.add(p.name);
    const latest = new Map<string, (typeof p.runs)[number]>();
    for (const r of [...p.runs].sort((a, b) => a.t - b.t)) {
      if (r.branch === p.default && r.status === "completed" && !r.dynamic) latest.set(String(r.wid ?? r.workflow), r);
    }
    for (const [wid, r] of latest) {
      if (r.conclusion && FAILED_CI.has(r.conclusion)) {
        found.push({ key: `ci:${p.name}:${wid}`, text: `CI "${r.workflow}" is red on ${p.default}`, project: p.name, link: r.url, since: r.t, afterSeconds: cfg.ciRedHours * 3600 });
      }
    }
    for (const pr of p.prs) {
      if (pr.checks === "success" && !pr.draft && pr.mergeState !== "DIRTY" && pr.mergeState !== "BEHIND") {
        found.push({ key: `pr:${p.name}:${pr.number}`, text: `PR #${pr.number} is green and not merged: ${pr.title}`, project: p.name, link: pr.url, since: null, afterSeconds: cfg.prWaitHours * 3600 });
      }
    }
    if (p.dirty && p.dirty.count > 0 && p.dirty.oldest) {
      found.push({ key: `dirty:${p.name}`, text: `${p.dirty.count} uncommitted file(s) in ${p.name}`, project: p.name, link: `/cockpit/projects#p-${p.name}`, since: p.dirty.oldest, afterSeconds: cfg.dirtyDays * DAY });
    }
  }
  for (const b of budgets ?? []) {
    const level = b.pct >= 1 ? 100 : b.pct * 100 >= cfg.budgetPercent ? cfg.budgetPercent : null;
    if (level !== null) {
      found.push({
        key: `budget:${b.scope}:${level}`, text: `${b.scope} is at ${Math.round(b.pct * 100)}% of its weekly budget`,
        project: b.scope === "overall" ? "" : b.scope, link: "/cockpit/usage", since: null, afterSeconds: 0,
      });
    }
  }
  for (const q of quality ?? []) {
    for (const f of q.high) found.push({ key: `quality:${q.name}:${f.key}`, text: `${q.name}: ${f.text}`, project: q.name, link: `/cockpit/quality/${q.name}`, since: null, afterSeconds: 0 });
  }
  return { found, complete };
}

const autoId = (key: string) => `a${createHash("sha256").update(key).digest("hex").slice(0, 15)}`;
const sanitizeText = (raw: string) => raw.normalize("NFC").trim();

export function createRemindersService(options: {
  config: () => Promise<{ config: CockpitConfig; error: string | null }>;
  snapshot: () => Promise<CockpitSnapshot>;
  budgets?: () => Promise<Array<{ scope: string; pct: number }>>;
  quality?: () => Promise<{ projects: Array<{ name: string; high: Array<{ key: string; text: string }> }> }>;
  listProjects: () => CockpitProject[] | Promise<CockpitProject[]>;
  notifier: Notifier;
  userPath?: string;
  statePath?: string;
  now?: () => number;
  tz?: string;
}): RemindersService {
  const userPath = options.userPath ?? REMINDERS_PATH;
  const statePath = options.statePath ?? REMINDER_STATE_PATH;
  const nowMs = options.now ?? Date.now;
  const tz = options.tz ?? "Europe/Paris";
  const userLock = mutex();
  const stateLock = mutex();
  let lastTest = 0;
  let storeError: string | null = null;

  const readJson = async <T>(path: string, schema: z.ZodType<T>, empty: () => T, label: string): Promise<T> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") storeError = `${label} could not be read; starting empty`;
      return empty();
    }
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // same answer as an invalid shape
    }
    storeError = `${label} was invalid; starting empty`;
    return empty();
  };
  const loadUser = () => readJson(userPath, userSchema, () => ({ version: 1 as const, items: [] as UserItem[] }), "reminders.json");
  const loadState = () => readJson(statePath, stateSchema, emptyState, "reminder-state.json");
  const readUserLocked = () => userLock(loadUser);

  const gather = async () => {
    const safe = async <T>(fn: (() => Promise<T>) | undefined): Promise<T | null> => {
      try {
        return fn ? await fn() : null;
      } catch {
        return null;
      }
    };
    const [snapshot, budgets, quality, cfg] = await Promise.all([safe(options.snapshot), safe(options.budgets), safe(options.quality), options.config()]);
    return { snapshot, budgets, quality, cfg };
  };

  /** Raises the automatic items from the conditions, and forgets state for conditions that are over (only when read fully). */
  const buildAuto = (g: Awaited<ReturnType<typeof gather>>, st: State, nowSec: number) => {
    const { found, complete } = findAutoConditions(g.snapshot, g.budgets, g.quality?.projects ?? null, g.cfg.config.autoReminders);
    const active = new Set(found.map((f) => f.key));
    const covered = (key: string) => {
      if (key.startsWith("budget:")) return g.budgets !== null;
      for (const p of complete) {
        if (key === `dirty:${p}` || key.startsWith(`ci:${p}:`) || key.startsWith(`pr:${p}:`)) return true;
        if (key.startsWith(`quality:${p}:`) && g.quality !== null) return true;
      }
      return false;
    };
    for (const table of [st.first, st.ack]) {
      for (const [key, at] of Object.entries(table)) {
        if (active.has(key)) continue;
        if (covered(key) || nowSec - at > OLD_STATE_SECONDS) delete table[key];
      }
    }
    for (const [key, until] of Object.entries(st.snooze)) if (until <= nowSec && !active.has(key)) delete st.snooze[key];
    const items: ReminderItem[] = [];
    for (const f of found) {
      const since = f.since ?? (st.first[f.key] ??= nowSec);
      if (f.key in st.ack || nowSec < (st.snooze[f.key] ?? 0) || nowSec - since < f.afterSeconds) continue;
      items.push({ id: autoId(f.key), kind: "auto", text: f.text, project: f.project, link: f.link, due: since + f.afterSeconds, since, repeat: "none", state: "due" });
    }
    return { items, found };
  };

  const compute = async (send: boolean) =>
    stateLock(async () => {
      const nowSec = nowMs() / 1000;
      const [g, user] = await Promise.all([gather(), readUserLocked()]);
      const st = await loadState();
      const before = JSON.stringify(st);
      const auto = buildAuto(g, st, nowSec).items;
      const items: ReminderItem[] = [...user.items.map((r) => ({ ...r, kind: "user" as const, link: null, state: (r.due <= nowSec ? "due" : "upcoming") as "due" | "upcoming" })), ...auto];
      items.sort((a, b) => Number(a.state !== "due") - Number(b.state !== "due") || a.due - b.due);
      const ncfg = g.cfg.config.notifications;
      let sentCount = 0;
      if (send && ncfg.enabled && !inQuietHours(ncfg, nowSec, tz)) {
        let recent = Object.values(st.sent).filter((t) => nowSec - t < 3600).length;
        for (const item of items) {
          if (item.state !== "due") continue;
          const key = `${item.id}|${Math.floor(item.due)}`;
          if (key in st.sent) continue;
          if (recent >= ncfg.maxPerHour) break;
          if (await options.notifier.send(`Cockpit reminder${item.project ? ` · ${item.project}` : ""}`, item.text)) {
            st.sent[key] = nowSec;
            recent++;
            sentCount++;
          }
        }
      }
      for (const [key, at] of Object.entries(st.sent)) if (nowSec - at > SENT_KEEP_SECONDS) delete st.sent[key];
      if (JSON.stringify(st) !== before) await writeJsonAtomic(statePath, st);
      return { items, sentCount, cfg: g.cfg, st, nowSec };
    });

  const knownProject = async (name: string) => name === "" || (await options.listProjects()).some((p) => p.name === name);

  return {
    async list() {
      const { items, cfg, st, nowSec } = await compute(false);
      const sentTimes = Object.values(st.sent);
      return {
        items,
        dueCount: items.filter((i) => i.state === "due").length,
        notifications: {
          enabled: cfg.config.notifications.enabled,
          quietNow: inQuietHours(cfg.config.notifications, nowSec, tz),
          lastSentAt: sentTimes.length > 0 ? Math.max(...sentTimes) : null,
        },
        configError: cfg.error,
        storeError,
      };
    },

    async add(input) {
      const nowSec = nowMs() / 1000;
      const text = sanitizeText(input.text ?? "");
      if (text.length < 1 || text.length > TEXT_MAX || /\p{Cc}/u.test(text)) return { ok: false, kind: "invalid", error: "text must be 1 to 200 characters without control characters" };
      const repeat = input.repeat ?? "none";
      if (!(repeat in REPEAT_SECONDS)) return { ok: false, kind: "invalid", error: "repeat must be none, daily or weekly" };
      if (input.due === undefined || !/^\d{1,11}$/.test(input.due)) return { ok: false, kind: "invalid", error: "due must be epoch seconds" };
      const due = Number(input.due);
      if (due < nowSec - DAY || due > nowSec + 366 * DAY) return { ok: false, kind: "invalid", error: "due is out of range" };
      const project = input.project ?? "";
      if (!(await knownProject(project))) return { ok: false, kind: "invalid", error: "unknown project" };
      return userLock(async () => {
        const data = await loadUser();
        if (data.items.length >= MAX_ITEMS) return { ok: false as const, kind: "full" as const, error: "too many reminders (200)" };
        const item: UserItem = { id: `u${randomBytes(8).toString("hex").slice(0, 15)}`, text, project, due, repeat: repeat as Repeat, created: nowSec };
        data.items.push(item);
        await writeJsonAtomic(userPath, data);
        return { ok: true as const, item };
      });
    },

    async act(id, action, until) {
      const nowSec = nowMs() / 1000;
      if (!REMINDER_ID.test(id)) return { ok: false, kind: "invalid", error: "bad id" };
      const snoozeTo = until ?? nowSec + 3600;
      if (action === "snooze" && !(snoozeTo > nowSec && snoozeTo <= nowSec + SNOOZE_MAX_SECONDS)) return { ok: false, kind: "invalid", error: "until is out of range" };
      if (id.startsWith("a")) {
        if (action === "delete") return { ok: false, kind: "invalid", error: "automatic reminders can be completed or snoozed" };
        return stateLock(async () => {
          const g = await gather();
          const st = await loadState();
          const hit = buildAuto(g, st, nowSec).found.find((f) => autoId(f.key) === id);
          if (!hit) return { ok: false as const, kind: "notfound" as const, error: "unknown reminder" };
          if (action === "done") st.ack[hit.key] = nowSec;
          else st.snooze[hit.key] = snoozeTo;
          await writeJsonAtomic(statePath, st);
          return { ok: true as const };
        });
      }
      return userLock(async () => {
        const data = await loadUser();
        const me = data.items.find((r) => r.id === id);
        if (!me) return { ok: false as const, kind: "notfound" as const, error: "unknown reminder" };
        if (action === "delete") data.items = data.items.filter((r) => r !== me);
        else if (action === "snooze") me.due = snoozeTo;
        else if (REPEAT_SECONDS[me.repeat] > 0) {
          // a repeating reminder comes back at the next slot after now
          const step = REPEAT_SECONDS[me.repeat];
          me.due += step;
          while (me.due <= nowSec) me.due += step;
        } else data.items = data.items.filter((r) => r !== me);
        await writeJsonAtomic(userPath, data);
        return { ok: true as const };
      });
    },

    async tick() {
      return (await compute(true)).sentCount;
    },

    async testNotification() {
      const t = nowMs();
      if (t - lastTest < TEST_EVERY_MS) return { kind: "rate", retryAfterSeconds: Math.ceil((TEST_EVERY_MS - (t - lastTest)) / 1000) };
      lastTest = t;
      return (await options.notifier.send("Cockpit", "Test notification")) ? { kind: "ok" } : { kind: "failed" };
    },

    start(opts = {}) {
      const tick = () => {
        compute(true).catch(() => undefined);
      };
      const first = setTimeout(tick, opts.firstDelayMs ?? FIRST_TICK_MS);
      const timer = setInterval(tick, opts.intervalMs ?? TICK_MS);
      first.unref();
      timer.unref();
      return () => {
        clearTimeout(first);
        clearInterval(timer);
      };
    },
  };
}
