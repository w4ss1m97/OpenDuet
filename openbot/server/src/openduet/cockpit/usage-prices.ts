import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Price, Tok, UsageConfig } from "./usage-types";

/** The folder for the cockpit's own files (usage store and config). */
export const COCKPIT_DATA_DIR = join(homedir(), ".config", "openduet", "cockpit");
export const USAGE_CONFIG_PATH = join(COCKPIT_DATA_DIR, "usage-config.json");

const MAX_CONFIG_BYTES = 64 * 1024;

/** $/MTok (platform.claude.com/docs/en/about-claude/pricing): input, 5m write, 1h write, cache read, output. */
export const DEFAULT_PRICES: Record<string, Price> = {
  "fable-5-1": [10, 12.5, 20, 0.25, 50], "fable-5": [10, 12.5, 20, 1, 50], "mythos-5-1": [10, 12.5, 20, 0.25, 50],
  "opus-5-5": [4, 5, 8, 0.2, 20], "opus-5": [5, 6.25, 10, 0.5, 25], "opus-4-8": [5, 6.25, 10, 0.5, 25],
  "opus-4-7": [5, 6.25, 10, 0.5, 25], "opus-4-6": [5, 6.25, 10, 0.5, 25], "opus-4-5": [5, 6.25, 10, 0.5, 25],
  "opus-4-1": [15, 18.75, 30, 1.5, 75], "opus-4": [15, 18.75, 30, 1.5, 75],
  "sonnet-5-5": [2, 2.5, 4, 0.1, 10], "sonnet-5": [2, 2.5, 4, 0.2, 10], "sonnet-4-6": [3, 3.75, 6, 0.3, 15],
  "sonnet-4-5": [3, 3.75, 6, 0.3, 15], "sonnet-4": [3, 3.75, 6, 0.3, 15],
  "haiku-5-5": [0.1, 0.125, 0.2, 0.01, 0.5], "haiku-4-5": [1, 1.25, 2, 0.1, 5], "haiku-3-5": [0.8, 1, 1.6, 0.08, 4],
};
export const DEFAULT_FALLBACK: Price = [3, 3.75, 6, 0.3, 15];

export const DEFAULT_CONFIG: UsageConfig = {
  prices: DEFAULT_PRICES,
  fallbackPrice: DEFAULT_FALLBACK,
  budgets: [],
  budgetPercent: 80,
  advisor: {
    opusShortMinRequests: 40,
    opusShortMaxOutput: 400,
    bigContextTokens: 200_000,
    maxPerKind: 4,
    cheaperMain: "sonnet-5-5",
    cheaperSearch: "haiku-5-5",
  },
};

/** The price whose key is the model id or a prefix of it on a `-` boundary (longest wins); known=false for the fallback. */
export function priceFor(model: string, prices: Record<string, Price>, fallback: Price): { price: Price; known: boolean } {
  let best: string | null = null;
  for (const key of Object.keys(prices)) {
    if ((model === key || model.startsWith(`${key}-`)) && (best === null || key.length > best.length)) best = key;
  }
  return best === null ? { price: fallback, known: false } : { price: prices[best]!, known: true };
}

/** API-equivalent dollars for the tokens at a price. */
export function costOf(tok: Omit<Tok, "requests"> & { requests?: number }, price: Price): number {
  return (tok.input * price[0] + tok.cw5 * price[1] + tok.cw1h * price[2] + tok.cr * price[3] + tok.output * price[4]) / 1e6;
}

const priceSchema = z.tuple([z.number().min(0).max(10_000), z.number().min(0).max(10_000), z.number().min(0).max(10_000), z.number().min(0).max(10_000), z.number().min(0).max(10_000)]);
const configSchema = z.object({
  prices: z.record(z.string().regex(/^[a-z0-9.-]{1,40}$/), priceSchema).optional(),
  fallbackPrice: priceSchema.optional(),
  budgets: z.array(z.object({ scope: z.string().trim().min(1).max(60), unit: z.enum(["usd", "tokens"]), limit: z.number().min(0).max(1e12) })).max(50).optional(),
  budgetPercent: z.number().min(1).max(100).optional(),
  advisor: z
    .object({
      opusShortMinRequests: z.number().int().min(1).max(100_000).optional(),
      opusShortMaxOutput: z.number().min(1).max(1e6).optional(),
      bigContextTokens: z.number().min(1000).max(1e8).optional(),
      maxPerKind: z.number().int().min(1).max(50).optional(),
      cheaperMain: z.string().regex(/^[a-z0-9.-]{1,40}$/).optional(),
      cheaperSearch: z.string().regex(/^[a-z0-9.-]{1,40}$/).optional(),
    })
    .optional(),
});

/** The config file's text (null when there is no file) -> the config in force and, when the file is unusable, why. */
export function parseUsageConfig(text: string | null): { config: UsageConfig; error: string | null } {
  if (text === null) return { config: DEFAULT_CONFIG, error: null };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { config: DEFAULT_CONFIG, error: "usage-config.json is not valid JSON" };
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { config: DEFAULT_CONFIG, error: `usage-config.json: ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}` };
  }
  const user = parsed.data;
  return {
    config: {
      prices: user.prices && Object.keys(user.prices).length ? user.prices : DEFAULT_PRICES,
      fallbackPrice: user.fallbackPrice ?? DEFAULT_FALLBACK,
      budgets: user.budgets ?? [],
      budgetPercent: user.budgetPercent ?? DEFAULT_CONFIG.budgetPercent,
      advisor: { ...DEFAULT_CONFIG.advisor, ...Object.fromEntries(Object.entries(user.advisor ?? {}).filter(([, v]) => v !== undefined)) },
    },
    error: null,
  };
}

async function readSmallFile(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error("usage-config.json is bigger than 64 KiB");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export type UsageConfigSource = { get(): Promise<{ config: UsageConfig; error: string | null }> };

/** The hand-edited config file, re-read only when its mtime or size changes. A missing file means the defaults. */
export function createUsageConfigSource(path: string = USAGE_CONFIG_PATH): UsageConfigSource {
  let seen: { key: string; value: { config: UsageConfig; error: string | null } } | null = null;
  return {
    async get() {
      let key = "missing";
      try {
        const info = await stat(path);
        key = `${info.mtimeMs}:${info.size}`;
      } catch {
        // no file: defaults
      }
      if (seen?.key === key) return seen.value;
      let value: { config: UsageConfig; error: string | null };
      try {
        value = parseUsageConfig(key === "missing" ? null : await readSmallFile(path));
      } catch (error) {
        value = { config: DEFAULT_CONFIG, error: error instanceof Error ? error.message : "usage-config.json could not be read" };
      }
      seen = { key, value };
      return value;
    },
  };
}
