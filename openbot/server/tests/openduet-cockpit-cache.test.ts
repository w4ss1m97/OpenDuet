import { describe, expect, test } from "bun:test";
import { createBackground, createTtlCache } from "../src/openduet/cockpit/cache";

describe("cockpit ttl cache", () => {
  test("serves a fresh value without calling again, refetches after the ttl", async () => {
    let t = 0;
    let calls = 0;
    const cache = createTtlCache(() => t);
    const fn = async () => ++calls;
    expect(await cache.cached("k", 1000, fn)).toBe(1);
    t = 999;
    expect(await cache.cached("k", 1000, fn)).toBe(1);
    t = 1000;
    expect(await cache.cached("k", 1000, fn)).toBe(2);
  });

  test("concurrent callers share one in-flight call", async () => {
    let calls = 0;
    const cache = createTtlCache(() => 0);
    const fn = async () => {
      calls++;
      await Bun.sleep(10);
      return "v";
    };
    const all = await Promise.all([cache.cached("k", 1000, fn), cache.cached("k", 1000, fn), cache.cached("k", 1000, fn)]);
    expect(all).toEqual(["v", "v", "v"]);
    expect(calls).toBe(1);
  });

  test("a failed refresh (null or throw) returns the last good value", async () => {
    let t = 0;
    const cache = createTtlCache(() => t);
    await cache.cached("k", 10, async () => "good");
    t = 20;
    expect(await cache.cached("k", 10, async () => null)).toBe("good");
    t = 40;
    expect(await cache.cached("k", 10, async () => { throw new Error("boom"); })).toBe("good");
  });

  test("a failure with nothing cached is null and is not remembered", async () => {
    const cache = createTtlCache(() => 0);
    expect(await cache.cached("k", 1000, async () => null)).toBeNull();
    expect(await cache.cached("k", 1000, async () => "later")).toBe("later");
  });

  test("keys are independent", async () => {
    const cache = createTtlCache(() => 0);
    await cache.cached("a", 1000, async () => 1);
    expect(await cache.cached("b", 1000, async () => 2)).toBe(2);
  });

  test("invalidate(prefix) drops the matching entries and leaves the others", async () => {
    let calls = 0;
    const cache = createTtlCache(() => 0);
    const fn = async () => ++calls;
    await cache.cached("machine:a", 1000, fn);
    await cache.cached("machine:b", 1000, fn);
    await cache.cached("ci:a", 1000, fn);
    cache.invalidate("machine:");
    expect(await cache.cached("machine:a", 1000, fn)).toBe(4);
    expect(await cache.cached("machine:b", 1000, fn)).toBe(5);
    expect(await cache.cached("ci:a", 1000, fn)).toBe(3);
  });

  test("a call in flight when invalidate runs does not store its stale answer", async () => {
    let release: (v: string) => void = () => {};
    const cache = createTtlCache(() => 0);
    const slow = cache.cached("machine:x", 1000, () => new Promise<string>((r) => (release = r)));
    cache.invalidate("machine:");
    release("old");
    expect(await slow).toBe("old");
    expect(await cache.cached("machine:x", 1000, async () => "new")).toBe("new");
  });
});

describe("cockpit background value", () => {
  test("get() never waits: null at first, the value once the refresh is done", async () => {
    let release: (v: number) => void = () => {};
    const bg = createBackground(1000, () => new Promise<number>((r) => (release = r)), () => 0);
    expect(bg.get()).toBeNull();
    release(7);
    await Bun.sleep(5);
    expect(bg.get()).toBe(7);
  });

  test("one refresh at a time, and none before the ttl", async () => {
    let t = 0;
    let calls = 0;
    const bg = createBackground(1000, async () => ++calls, () => t);
    bg.get();
    bg.get();
    bg.get();
    await Bun.sleep(5);
    expect(calls).toBe(1);
    t = 999;
    bg.get();
    await Bun.sleep(5);
    expect(calls).toBe(1);
    t = 1000;
    expect(bg.get()).toBe(1);
    await Bun.sleep(5);
    expect(calls).toBe(2);
    expect(bg.get()).toBe(2);
  });

  test("a failed refresh keeps the last value and waits a full ttl before retrying", async () => {
    let t = 0;
    let calls = 0;
    const bg = createBackground<number>(1000, async () => (++calls === 1 ? 5 : null), () => t);
    bg.get();
    await Bun.sleep(5);
    t = 1000;
    bg.get();
    await Bun.sleep(5);
    expect(bg.get()).toBe(5);
    t = 1500;
    bg.get();
    await Bun.sleep(5);
    expect(calls).toBe(2);
  });

  test("a throwing refresh is swallowed", async () => {
    const bg = createBackground<number>(1000, async () => { throw new Error("boom"); }, () => 0);
    expect(bg.get()).toBeNull();
    await Bun.sleep(5);
    expect(bg.get()).toBeNull();
  });
});
