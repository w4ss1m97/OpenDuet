/** A cache of slow results (gh calls, git scans) that keeps the last good value when a refresh fails. */
export type TtlCache = {
  cached<T>(key: string, ttlMs: number, fn: () => Promise<T | null>): Promise<T | null>;
};

/**
 * Fresh values are served as is; a stale one is refetched by one shared call however many ask at once.
 * A refresh that returns null or throws gives back the last good value (or null) and stores nothing.
 */
export function createTtlCache(now: () => number = Date.now): TtlCache {
  const entries = new Map<string, { at: number; value: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();
  return {
    async cached<T>(key: string, ttlMs: number, fn: () => Promise<T | null>): Promise<T | null> {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value as T;
      const running = inflight.get(key);
      if (running) return (await running) as T | null;
      const call = (async () => {
        try {
          const value = await fn();
          if (value === null || value === undefined) return (hit?.value as T | undefined) ?? null;
          entries.set(key, { at: now(), value });
          return value;
        } catch {
          return (hit?.value as T | undefined) ?? null;
        }
      })();
      inflight.set(key, call);
      try {
        return await call;
      } finally {
        inflight.delete(key);
      }
    },
  };
}
