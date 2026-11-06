/** Token counts of one bucket; `requests` counts API messages (a repeated message id is not a new request). */
export type Tok = { input: number; cw5: number; cw1h: number; cr: number; output: number; requests: number };

/** One row of the store: a Paris day and hour, a session, a model (without `claude-`) and an agent. */
export type UsageRow = Tok & {
  day: string;
  hour: number;
  session: string;
  model: string;
  agent: string;
  agentId: string;
};

/** What was read of one transcript: `offset` is just past the last full line; `tail` the last 64 `[message id, output]`. */
export type FileState = { offset: number; size: number; ino: number; tail: Array<[string, number]> };

/** A session as the transcripts describe it. `dir` is the encoded folder under `projects`; times are milliseconds. */
export type SessionMeta = { id: string; name: string | null; dir: string; cwd: string; first: number; last: number; /** Imported history only: the project name to show when no cwd places it. */ label?: string };

export type SubagentMeta = { session: string; agentId: string; agent: string; description: string };

export type UsageStore = {
  version: 1;
  files: Record<string, FileState>;
  /** Key: `day|hour|session|model|agent|agentId`. */
  rows: Record<string, UsageRow>;
  sessions: Record<string, SessionMeta>;
  /** Key: `session|agentId`. */
  subagents: Record<string, SubagentMeta>;
};

/** $ per million tokens: input, 5-minute cache write, 1-hour cache write, cache read, output. */
export type Price = [number, number, number, number, number];

/** A weekly budget; `scope` is `overall` or a project name. Tokens leave out cache reads. */
export type Budget = { scope: string; unit: "usd" | "tokens"; limit: number };

export type AdvisorConfig = {
  opusShortMinRequests: number;
  opusShortMaxOutput: number;
  bigContextTokens: number;
  maxPerKind: number;
  /** Price key the opus-short tip compares with. */
  cheaperMain: string;
  /** Price key the opus-search tip compares with. */
  cheaperSearch: string;
};

export type UsageConfig = {
  prices: Record<string, Price>;
  fallbackPrice: Price;
  budgets: Budget[];
  /** From this share of a budget (1-100) the cockpit asks for attention. */
  budgetPercent: number;
  advisor: AdvisorConfig;
};

/** What the poller has done so far. */
export type UsageStatus = {
  backfilling: boolean;
  filesDone: number;
  filesTotal: number;
  skippedLines: number;
  lastError: string | null;
};
