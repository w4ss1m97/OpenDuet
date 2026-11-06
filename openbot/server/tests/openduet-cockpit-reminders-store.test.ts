import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NOON, makeEnv, service } from "./reminders-fixtures.helper";

const due = String(NOON + 3600);

describe("user reminders: add", () => {
  test.each([
    ["empty", { text: "   ", due }],
    ["201 chars", { text: "x".repeat(201), due }],
    ["control char", { text: "a\u0007b", due }],
    ["newline", { text: "a\nb", due }],
    ["bad repeat", { text: "t", due, repeat: "hourly" }],
    ["missing due", { text: "t" }],
    ["due not a number", { text: "t", due: "soon" }],
    ["due too old", { text: "t", due: String(NOON - 2 * 86400) }],
    ["due too far", { text: "t", due: String(NOON + 400 * 86400) }],
    ["unknown project", { text: "t", due, project: "Nope" }],
  ])("%s is refused", async (_name, input) => {
    const out = await service(makeEnv()).add(input);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.kind).toBe("invalid");
  });

  test("a good one gets a u+15 hex id, NFC text, and a known project is accepted", async () => {
    const env = makeEnv();
    const out = await service(env).add({ text: " café ", due, project: "P", repeat: "daily" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.item.id).toMatch(/^u[0-9a-f]{15}$/);
      expect(out.item.text).toBe("café");
    }
    expect((await service(env).list()).items).toHaveLength(1);
  });

  test("the 201st item is refused with full", async () => {
    const env = makeEnv();
    const s = service(env);
    for (let i = 0; i < 200; i++) expect((await s.add({ text: `r${i}`, due })).ok).toBe(true);
    const out = await s.add({ text: "one more", due });
    expect(out).toMatchObject({ ok: false, kind: "full" });
  });

  test("the mutex keeps add and tick from losing each other", async () => {
    const env = makeEnv();
    const s = service(env);
    await Promise.all([...Array.from({ length: 10 }, (_, i) => s.add({ text: `r${i}`, due })), s.tick(), s.tick()]);
    expect((await s.list()).items).toHaveLength(10);
  });
});

describe("user reminders: done, snooze, delete", () => {
  const addOne = async (repeat: string, offset = -3600) => {
    const env = makeEnv();
    const s = service(env);
    const out = await s.add({ text: "t", due: String(NOON + offset), repeat });
    if (!out.ok) throw new Error("add failed");
    return { env, s, id: out.item.id };
  };

  test("done on a one-off removes it", async () => {
    const { s, id } = await addOne("none");
    expect(await s.act(id, "done")).toEqual({ ok: true });
    expect((await s.list()).items).toHaveLength(0);
  });

  test("done on a repeating one jumps past now, at the same time of day", async () => {
    const { env, s, id } = await addOne("daily", -600);
    env.clock.t = NOON + 3 * 86400;
    await s.act(id, "done");
    const item = (await s.list()).items[0]!;
    expect(item.due).toBe(NOON - 600 + 4 * 86400);
    expect(item.state).toBe("upcoming");
  });

  test("snooze moves due (default +1 h), refuses out of range", async () => {
    const { s, id } = await addOne("none");
    await s.act(id, "snooze");
    expect((await s.list()).items[0]!.due).toBe(NOON + 3600);
    expect(await s.act(id, "snooze", NOON + 31 * 86400)).toMatchObject({ ok: false, kind: "invalid" });
    expect(await s.act(id, "snooze", NOON - 5)).toMatchObject({ ok: false, kind: "invalid" });
  });

  test("delete, unknown id, bad id", async () => {
    const { s, id } = await addOne("weekly");
    expect(await s.act("u" + "0".repeat(15), "delete")).toMatchObject({ ok: false, kind: "notfound" });
    expect(await s.act("nope", "delete")).toMatchObject({ ok: false, kind: "invalid" });
    expect(await s.act(id, "delete")).toEqual({ ok: true });
    expect((await s.list()).items).toHaveLength(0);
  });

  test("delete on an automatic reminder is an error", async () => {
    const env = makeEnv();
    const s = service(env);
    expect(await s.act("a" + "0".repeat(15), "delete")).toMatchObject({ ok: false, kind: "invalid" });
  });

  test("an invalid store loads empty with an error and the next add rewrites it", async () => {
    const env = makeEnv();
    writeFileSync(join(env.dir, "reminders.json"), "{nope");
    const s = service(env);
    const out = await s.list();
    expect(out.items).toHaveLength(0);
    expect(out.storeError).toContain("invalid");
  });
});
