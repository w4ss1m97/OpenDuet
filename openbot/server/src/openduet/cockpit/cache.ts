/** A cache of slow results (gh calls, git scans) that keeps the last good value when a refresh fails. */
export type TtlCache = {
  cached<T>(key: string, ttlMs: number, fn: () => Promise<T | null>): Promise<T | null>;
  /** Forgets every entry whose key starts with `prefix`; a call still running for one of them stores nothing. */
  invalidate(prefix: string): void;
};

type Flight = { promise: Promise<unknown>; dead: boolean };

/**
 * Fresh values are served as is; a stale one is refetched by one shared call however many ask at once.
 * A refresh that returns null or throws gives back the last good value (or null) and stores nothing.
 */
export function createTtlCache(now: () => number = Date.now): TtlCache {
  const entries = new Map<string, { at: number; value: unknown }>();
  const inflight = new Map<string, Flight>();
  return {
    async cached<T>(key: string, ttlMs: number, fn: () => Promise<T | null>): Promise<T | null> {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value as T;
      const running = inflight.get(key);
      if (running) return (await running.promise) as T | null;
      const flight: Flight = { promise: Promise.resolve(null), dead: false };
      flight.promise = (async () => {
        try {
          const value = await fn();
          if (value === null || value === undefined) return (hit?.value as T | undefined) ?? null;
          if (!flight.dead) entries.set(key, { at: now(), value });
          return value;
        } catch {
          return (hit?.value as T | undefined) ?? null;
        }
      })();
      inflight.set(key, flight);
      try {
        return (await flight.promise) as T | null;
      } finally {
        if (inflight.get(key) === flight) inflight.delete(key);
      }
    },
    invalidate(prefix: string) {
      for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
      for (const [key, flight] of [...inflight]) {
        if (!key.startsWith(prefix)) continue;
        flight.dead = true;
        inflight.delete(key);
      }
    },
  };
}

/** A slow fact read in the background: `get()` answers at once with the last value (null at first). */
export type Background<T> = { get(): T | null };

/**
 * Each `get()` past the ttl starts one refresh and does not wait for it. A refresh that returns null or
 * throws keeps the last value; the next try comes a full ttl after the failed one started.
 */
export function createBackground<T>(ttlMs: number, fn: () => Promise<T | null>, now: () => number = Date.now): Background<T> {
  let value: T | null = null;
  let startedAt: number | null = null;
  let running = false;
  return {
    get() {
      if (!running && (startedAt === null || now() - startedAt >= ttlMs)) {
        running = true;
        startedAt = now();
        void (async () => {
          try {
            const next = await fn();
            if (next !== null && next !== undefined) value = next;
          } catch {
            // keep the last value
          } finally {
            running = false;
          }
        })();
      }
      return value;
    },
  };
}
