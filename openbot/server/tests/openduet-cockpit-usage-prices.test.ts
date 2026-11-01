import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, DEFAULT_FALLBACK, DEFAULT_PRICES, costOf, createUsageConfigSource, parseUsageConfig, priceFor } from "../src/openduet/cockpit/usage-prices";

describe("priceFor", () => {
  test("a dated model id uses the longest matching key", () => {
    expect(priceFor("opus-4-5-20251101", DEFAULT_PRICES, DEFAULT_FALLBACK)).toEqual({ price: DEFAULT_PRICES["opus-4-5"]!, known: true });
    expect(priceFor("opus-4-1-20250805", DEFAULT_PRICES, DEFAULT_FALLBACK).price).toEqual(DEFAULT_PRICES["opus-4-1"]!);
    expect(priceFor("sonnet-4-5", DEFAULT_PRICES, DEFAULT_FALLBACK).price).toEqual(DEFAULT_PRICES["sonnet-4-5"]!);
  });

  test("an unknown model gets the fallback and known=false", () => {
    expect(priceFor("mystery-9", DEFAULT_PRICES, DEFAULT_FALLBACK)).toEqual({ price: DEFAULT_FALLBACK, known: false });
    // "opus-45" shares letters with "opus-4" but not a "-" boundary.
    expect(priceFor("opus-45", DEFAULT_PRICES, DEFAULT_FALLBACK).known).toBe(false);
  });
});

describe("costOf", () => {
  test("multiplies each bucket by its price per million tokens", () => {
    const tok = { input: 1_000_000, cw5: 1_000_000, cw1h: 1_000_000, cr: 1_000_000, output: 1_000_000, requests: 1 };
    expect(costOf(tok, [1, 2, 3, 4, 5])).toBe(15);
  });
});

describe("parseUsageConfig", () => {
  test("no file gives the defaults, no error", () => {
    expect(parseUsageConfig(null)).toEqual({ config: DEFAULT_CONFIG, error: null });
  });

  test("a valid file overrides what it names and keeps the other defaults", () => {
    const { config, error } = parseUsageConfig(JSON.stringify({ budgets: [{ scope: "overall", unit: "usd", limit: 100 }], budgetPercent: 90, advisor: { maxPerKind: 2 } }));
    expect(error).toBeNull();
    expect(config.budgets).toEqual([{ scope: "overall", unit: "usd", limit: 100 }]);
    expect(config.budgetPercent).toBe(90);
    expect(config.advisor).toEqual({ ...DEFAULT_CONFIG.advisor, maxPerKind: 2 });
    expect(config.prices).toEqual(DEFAULT_PRICES);
  });

  test("user prices replace the whole table", () => {
    const { config } = parseUsageConfig(JSON.stringify({ prices: { "opus-9": [1, 2, 3, 4, 5] } }));
    expect(config.prices).toEqual({ "opus-9": [1, 2, 3, 4, 5] });
  });

  test("invalid config gives the defaults and an error", () => {
    for (const text of ["{nope", JSON.stringify({ prices: { "opus-9": [1, 2] } }), JSON.stringify({ budgets: [{ scope: "x", unit: "eur", limit: 1 }] }), JSON.stringify({ budgetPercent: 500 }), JSON.stringify({ prices: { "BAD KEY": [1, 2, 3, 4, 5] } })]) {
      const result = parseUsageConfig(text);
      expect(result.config).toEqual(DEFAULT_CONFIG);
      expect(result.error).toBeTruthy();
    }
  });
});

describe("createUsageConfigSource", () => {
  test("re-reads when the file changes and falls back when it breaks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-config-"));
    try {
      const path = join(dir, "usage-config.json");
      const source = createUsageConfigSource(path);
      expect((await source.get()).error).toBeNull();
      expect((await source.get()).config).toEqual(DEFAULT_CONFIG);
      await writeFile(path, JSON.stringify({ budgetPercent: 70 }));
      await utimes(path, new Date(1_000_000), new Date(1_000_000));
      expect((await source.get()).config.budgetPercent).toBe(70);
      await writeFile(path, "{broken");
      await utimes(path, new Date(2_000_000), new Date(2_000_000));
      const broken = await source.get();
      expect(broken.config).toEqual(DEFAULT_CONFIG);
      expect(broken.error).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
