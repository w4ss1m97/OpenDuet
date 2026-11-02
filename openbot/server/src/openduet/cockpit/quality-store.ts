import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { qualityResultSchema } from "./quality-parse";
import type { QualityResult } from "./quality-parse";
import { COCKPIT_DATA_DIR } from "./usage-prices";

export const QUALITY_STORE_PATH = join(COCKPIT_DATA_DIR, "quality-scans.json");

const HISTORY_DAYS = 90;
const DISMISS_SECONDS = 30 * 86400;
const DEFAULT_TZ = "Europe/Paris";

const historyRow = z.object({ day: z.string(), score: z.number(), grade: z.string(), categories: z.record(z.string(), z.number().nullable()) });
const storeSchema = z.object({
  version: z.literal(1),
  scans: z.record(z.string(), qualityResultSchema),
  history: z.record(z.string(), z.array(historyRow)),
  dismissed: z.record(z.string(), z.number()),
});

export type QualityData = z.infer<typeof storeSchema>;
export type HistoryRow = z.infer<typeof historyRow>;
export const emptyQualityData = (): QualityData => ({ version: 1, scans: {}, history: {}, dismissed: {} });

/** The calendar day (YYYY-MM-DD) of an epoch-seconds time in a time zone. */
export function parisDay(epochSeconds: number, tz: string = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochSeconds * 1000));
}

/** Writes JSON next to its final name (file 0600, folder 0700), then renames it over: a reader never sees half a file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export type QualityStore = {
  /** The saved data; a missing file is empty, an unreadable or invalid one is empty with the reason. */
  read(): Promise<{ data: QualityData; error: string | null }>;
  /** Saves a scan and its day's history row. */
  saveScan(result: QualityResult): Promise<void>;
  /** Hides a suggestion for 30 days; returns the epoch seconds it comes back. */
  dismiss(key: string): Promise<number>;
};

export function createQualityStore(options: { path?: string; tz?: string; now?: () => number } = {}): QualityStore {
  const path = options.path ?? QUALITY_STORE_PATH;
  const tz = options.tz ?? DEFAULT_TZ;
  const now = options.now ?? Date.now;
  let chain: Promise<unknown> = Promise.resolve();
  /** One writer at a time: each change reads, edits and writes under the same lock. */
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const read = async (): Promise<{ data: QualityData; error: string | null }> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { data: emptyQualityData(), error: null }
        : { data: emptyQualityData(), error: "quality store could not be read; starting empty" };
    }
    try {
      const parsed = storeSchema.safeParse(JSON.parse(text));
      if (parsed.success) return { data: parsed.data, error: null };
    } catch {
      // same answer as an invalid shape
    }
    return { data: emptyQualityData(), error: "quality store was invalid; starting empty" };
  };

  const pruneDismissed = (data: QualityData) => {
    const nowSec = now() / 1000;
    for (const [key, until] of Object.entries(data.dismissed)) if (until <= nowSec) delete data.dismissed[key];
  };

  return {
    read,
    saveScan: (result) =>
      locked(async () => {
        const { data } = await read();
        data.scans[result.project] = result;
        const rows = (data.history[result.project] ?? []).filter((r) => r.day !== parisDay(result.scannedAt, tz));
        rows.push({ day: parisDay(result.scannedAt, tz), score: result.score, grade: result.grade, categories: result.categories });
        data.history[result.project] = rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-HISTORY_DAYS);
        pruneDismissed(data);
        await writeJsonAtomic(path, data);
      }),
    dismiss: (key) =>
      locked(async () => {
        const { data } = await read();
        const until = now() / 1000 + DISMISS_SECONDS;
        pruneDismissed(data);
        data.dismissed[key] = until;
        await writeJsonAtomic(path, data);
        return until;
      }),
  };
}
