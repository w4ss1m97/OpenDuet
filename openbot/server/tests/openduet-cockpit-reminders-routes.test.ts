import { describe, expect, test } from "bun:test";
import type { CockpitService } from "../src/openduet/cockpit/collect";
import { createCockpitApp } from "../src/openduet/cockpit/server";
import { NOON, cfgWith, makeEnv, service as makeService } from "./reminders-fixtures.helper";

const PORT = 3002;
const ORIGIN = "http://localhost:3010";
const LOCAL = { ip: { address: "127.0.0.1" } };
const base: CockpitService = { snapshot: async () => ({ projects: [], attention: [], names: [], generatedAt: 1 }), project: async () => null };
const due = NOON + 3600;

function build(over: { none?: boolean; fail?: boolean } = {}) {
  const env = makeEnv();
  const reminders = makeService(env, { fail: over.fail });
  const app = createCockpitApp({ getPort: () => PORT, origins: new Set([ORIGIN]), service: base, reminders: over.none ? undefined : reminders, now: () => env.clock.t * 1000 });
  const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    app.request(`http://127.0.0.1:${PORT}${path}`, { method: init.method ?? "GET", headers: { Host: `127.0.0.1:${PORT}`, ...init.headers } }, LOCAL as object);
  const post = (path: string, headers: Record<string, string> = { Origin: ORIGIN }) => call(path, { method: "POST", headers });
  const add = async (text = "call Paul") => (await (await post(`/api/cockpit/reminders?text=${encodeURIComponent(text)}&due=${due}`)).json()) as { id: string };
  return { call, post, add, env };
}

describe("reminder routes", () => {
  test("no service: 404 everywhere", async () => {
    const { call, post } = build({ none: true });
    expect((await call("/api/cockpit/reminders")).status).toBe(404);
    expect((await post(`/api/cockpit/reminders?text=a&due=${due}`)).status).toBe(404);
    expect((await post("/api/cockpit/notifications/test")).status).toBe(404);
  });

  test("add then list: 201, then the item is upcoming; the shape of GET", async () => {
    const { call, post } = build();
    const res = await post(`/api/cockpit/reminders?text=call%20Paul&due=${due}&repeat=weekly`);
    expect(res.status).toBe(201);
    expect((await res.json()).id).toMatch(/^u[0-9a-f]{15}$/);
    const list = await (await call("/api/cockpit/reminders")).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ kind: "user", state: "upcoming", repeat: "weekly" });
    expect(list.dueCount).toBe(0);
    expect(list.notifications).toEqual({ enabled: false, quietNow: false, lastSentAt: null });
  });

  test("bad input is 400", async () => {
    const { post } = build();
    for (const q of ["text=&due=1", `text=${"x".repeat(201)}&due=${due}`, "text=a%0Ab&due=" + due, `text=a&due=${due}&repeat=hourly`, `text=a&due=${due}&project=Nope`, "text=a", `text=a&due=${NOON + 999 * 86400}`, `text=a&text=b&due=${due}`]) {
      expect((await post(`/api/cockpit/reminders?${q}`)).status).toBe(400);
    }
  });

  test("done, snooze (default and until), delete; bad id 400, unknown 404, bad until 400", async () => {
    const { post, call, add, env } = build();
    const { id } = await add();
    expect((await post(`/api/cockpit/reminders/${id}/snooze`)).status).toBe(200);
    expect((await (await call("/api/cockpit/reminders")).json()).items[0].due).toBe(NOON + 3600);
    expect((await post(`/api/cockpit/reminders/${id}/snooze?until=${NOON + 7200}`)).status).toBe(200);
    expect((await post(`/api/cockpit/reminders/${id}/snooze?until=${NOON - 1}`)).status).toBe(400);
    expect((await post(`/api/cockpit/reminders/${id}/snooze?until=abc`)).status).toBe(400);
    expect((await post("/api/cockpit/reminders/nope/done")).status).toBe(400);
    expect((await post(`/api/cockpit/reminders/u${"0".repeat(15)}/done`)).status).toBe(404);
    expect((await post(`/api/cockpit/reminders/${id}/done`)).status).toBe(200);
    expect((await (await call("/api/cockpit/reminders")).json()).items).toHaveLength(0);
    const second = await add("again");
    expect((await post(`/api/cockpit/reminders/${second.id}/delete`)).status).toBe(200);
    expect((await post(`/api/cockpit/reminders/a${"0".repeat(15)}/delete`)).status).toBe(400);
    expect(env.sent).toEqual([]);
  });

  test("the test notification: 200 even when disabled, then 429; a failing send is 502", async () => {
    const { post, env } = build();
    expect((await post("/api/cockpit/notifications/test")).status).toBe(200);
    const again = await post("/api/cockpit/notifications/test");
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(env.sent).toHaveLength(1);
    expect((await build({ fail: true }).post("/api/cockpit/notifications/test")).status).toBe(502);
  });

  test("writes need an Origin", async () => {
    const { post } = build();
    expect((await post(`/api/cockpit/reminders?text=a&due=${due}`, {})).status).toBe(403);
    expect((await post("/api/cockpit/notifications/test", {})).status).toBe(403);
  });
});
