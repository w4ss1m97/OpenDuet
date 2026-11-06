import { z } from "zod";
import type { Tok } from "./usage-types";

const MAX_COUNT = 1e12;
const MAX_TITLE = 200;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SAFE_DIR = /^[\w.-]{1,300}$/;

const count = z.number().int().min(0).max(MAX_COUNT);

// The narrow part of an assistant line; everything else in the (untrusted) JSON is ignored.
const assistantSchema = z.object({
  timestamp: z.string().max(40),
  cwd: z.string().max(1000).optional(),
  message: z.object({
    id: z.string().max(200).optional(),
    model: z.string().min(1).max(100),
    usage: z.object({
      input_tokens: count.default(0),
      output_tokens: count.default(0),
      cache_read_input_tokens: count.default(0),
      cache_creation_input_tokens: count.default(0),
      cache_creation: z
        .object({ ephemeral_5m_input_tokens: count.default(0), ephemeral_1h_input_tokens: count.default(0) })
        .optional(),
    }),
  }),
});
const titleSchema = z.object({ customTitle: z.string().min(1).max(MAX_TITLE) });

export type ParsedLine =
  | { kind: "usage"; id: string | null; model: string; t: number; day: string; hour: number; cwd: string; tok: Omit<Tok, "requests"> }
  | { kind: "title"; title: string };

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (tz: string) => {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    formatters.set(tz, f);
  }
  return f;
};

/** The calendar day (`YYYY-MM-DD`) and hour (0-23) of an instant in `tz`. */
export function localDayHour(ms: number, tz: string): { day: string; hour: number } {
  const part: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(ms)) part[p.type] = p.value;
  return { day: `${part.year}-${part.month}-${part.day}`, hour: Number(part.hour) % 24 };
}

/**
 * One transcript line: usage of an assistant message, or a session title. Anything else, bad JSON, a
 * synthetic model, a bad timestamp or a negative / non-integer count gives null.
 */
export function parseUsageLine(raw: string, tz: string): ParsedLine | null {
  const isAssistant = raw.includes('"type":"assistant"');
  if (!isAssistant && !raw.includes('"custom-title"')) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isAssistant) {
    if ((json as { type?: unknown } | null)?.type !== "custom-title") return null;
    const title = titleSchema.safeParse(json);
    return title.success ? { kind: "title", title: title.data.customTitle } : null;
  }
  if ((json as { type?: unknown } | null)?.type !== "assistant") return null;
  const parsed = assistantSchema.safeParse(json);
  if (!parsed.success) return null;
  const { timestamp, cwd, message } = parsed.data;
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t) || message.model.startsWith("<")) return null;
  const u = message.usage;
  const tok = {
    input: u.input_tokens,
    cw5: u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens : u.cache_creation_input_tokens,
    cw1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cr: u.cache_read_input_tokens,
    output: u.output_tokens,
  };
  return { kind: "usage", id: message.id ?? null, model: message.model.replace(/^claude-/, ""), t, ...localDayHour(t, tz), cwd: cwd ?? "", tok };
}

/**
 * Where a transcript belongs: `<root>/<dir>/<session>.jsonl`, or a subagent's
 * `<root>/<dir>/<session>/subagents/agent-<id>.jsonl` (with its `.meta.json` beside it). Null for any other path.
 */
export function classifyPath(root: string, file: string): { dir: string; session: string; agentId: string; metaPath: string | null } | null {
  if (!file.startsWith(`${root}/`) || !file.endsWith(".jsonl")) return null;
  const parts = file.slice(root.length + 1).split("/");
  const dir = parts[0] ?? "";
  if (!SAFE_DIR.test(dir) || dir === "." || dir === "..") return null;
  const stem = (name: string) => name.slice(0, -".jsonl".length);
  if (parts.length === 2) {
    const session = stem(parts[1]!);
    return SAFE_ID.test(session) ? { dir, session, agentId: "", metaPath: null } : null;
  }
  if (parts.length === 4 && parts[2] === "subagents") {
    const session = parts[1]!;
    const agentId = stem(parts[3]!);
    if (!SAFE_ID.test(session) || !SAFE_ID.test(agentId)) return null;
    return { dir, session, agentId, metaPath: `${file.slice(0, -".jsonl".length)}.meta.json` };
  }
  return null;
}
