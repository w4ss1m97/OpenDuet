import { describe, expect, test } from "bun:test";
import { createTtlCache } from "../src/openduet/cockpit/cache";

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
});
