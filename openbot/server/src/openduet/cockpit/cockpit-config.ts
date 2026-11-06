/*
 * The cockpit's hand-edited settings for quality scans, automatic reminders and notifications:
 * ~/.config/openduet/cockpit/cockpit-config.json, re-read only when its mtime or size changes.
 * A missing file means the defaults; an invalid one means the defaults plus the reason (nothing half-applied).
 */
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { QualityConfig } from "./quality-parse";
import { COCKPIT_DATA_DIR } from "./usage-prices";

export const COCKPIT_CONFIG_PATH = join(COCKPIT_DATA_DIR, "cockpit-config.json");
const MAX_BYTES = 64 * 1024;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const int = (min: number, max: number) => z.number().int().min(min).max(max);

const qualitySchema = z.object({
  enabled: z.boolean().default(true),
  scanHours: int(1, 168).default(24),
  lookbackDays: int(7, 90).default(30),
  bigFileLines: int(50, 100_000).default(800),
  staleBranchDays: int(1, 3650).default(30),
  npm: z.boolean().default(true),
}).strict();
const autoSchema = z.object({
  ciRedHours: z.number().min(0).max(24 * 365).default(1),
  prWaitHours: z.number().min(0).max(24 * 365).default(24),
  dirtyDays: z.number().min(0).max(3650).default(2),
  budgetPercent: int(1, 99).default(80),
}).strict();
const notifySchema = z.object({
  enabled: z.boolean().default(false),
  quietEnabled: z.boolean().default(true),
  quietStart: hhmm.default("22:00"),
  quietEnd: hhmm.default("08:00"),
  maxPerHour: int(1, 60).default(6),
}).strict();

// zod does not fill the defaults of a section that is missing, so a missing section is parsed from {} here.
const schema = z.object({
  quality: qualitySchema.default(() => qualitySchema.parse({})),
  autoReminders: autoSchema.default(() => autoSchema.parse({})),
  notifications: notifySchema.default(() => notifySchema.parse({})),
}).strict();

export type CockpitConfig = { quality: QualityConfig } & Omit<z.infer<typeof schema>, "quality">;

export const DEFAULT_COCKPIT_CONFIG: CockpitConfig = schema.parse({});

export function parseCockpitConfig(text: string | null): { config: CockpitConfig; error: string | null } {
  if (text === null) return { config: DEFAULT_COCKPIT_CONFIG, error: null };
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return { config: parsed.data, error: null };
    const first = parsed.error.issues[0];
    return { config: DEFAULT_COCKPIT_CONFIG, error: `cockpit-config.json: ${first?.path.join(".") || "root"} is invalid; using the defaults` };
  } catch {
    return { config: DEFAULT_COCKPIT_CONFIG, error: "cockpit-config.json is not valid JSON; using the defaults" };
  }
}

async function readSmall(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error("cockpit-config.json is bigger than 64 KiB");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export type CockpitConfigSource = {
  get(): Promise<{ config: CockpitConfig; error: string | null }>;
  /** The quality part, in the shape the quality service wants. */
  quality(): Promise<{ config: QualityConfig; error: string | null }>;
};

export function createCockpitConfigSource(path: string = COCKPIT_CONFIG_PATH): CockpitConfigSource {
  let seen: { key: string; value: { config: CockpitConfig; error: string | null } } | null = null;
  const get = async () => {
    let key = "missing";
    try {
      const info = await stat(path);
      key = `${info.mtimeMs}:${info.size}`;
    } catch {
      // no file: defaults
    }
    if (seen?.key === key) return seen.value;
    let value: { config: CockpitConfig; error: string | null };
    try {
      value = parseCockpitConfig(key === "missing" ? null : await readSmall(path));
    } catch (error) {
      value = { config: DEFAULT_COCKPIT_CONFIG, error: error instanceof Error ? error.message : "cockpit-config.json could not be read" };
    }
    seen = { key, value };
    return value;
  };
  return {
    get,
    quality: async () => {
      const { config, error } = await get();
      return { config: config.quality, error };
    },
  };
}
