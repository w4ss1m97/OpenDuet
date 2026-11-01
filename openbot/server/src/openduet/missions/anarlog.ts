import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";

/**
 * Reads meetings recorded in Anarlog through its local CLI (`anarlog --json meetings ...`). Duet never
 * records and never stores a transcript. Output shapes follow the upstream contract (fastrepl/anarlog,
 * apps/cli): the envelope is `{schema_version, command, data, pagination?}`, `pagination` being a sibling
 * of `data`; errors are `{error: {code, exit_code, message}}` on stderr. Schemas are lenient: only the
 * fields used here are checked.
 */

export type AnarlogMeetingSummary = { id: string; title: string; startedAt: Date; endedAt: Date };
export type AnarlogMeeting = AnarlogMeetingSummary & {
  /** Lowercase emails of the participants who have one. */
  participantEmails: string[];
  /** The transcript is complete and can be read; false while the app is still transcribing. */
  transcriptReady: boolean;
};
export type AnarlogTranscript = { text: string; cut: boolean };

export interface AnarlogSource {
  /** Meetings that started at or after `since`, newest first. No participants: use getMeeting for those. */
  listMeetings(since: Date): Promise<AnarlogMeetingSummary[]>;
  getMeeting(id: string): Promise<AnarlogMeeting>;
  /** The transcript text, read page by page before `deadline`. */
  transcript(id: string, deadline: Date): Promise<AnarlogTranscript>;
}

export class AnarlogError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AnarlogError";
  }
}

const CALL_TIMEOUT_MS = 20_000;
const MAX_STDOUT_BYTES = 5 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const PAGE_WORDS = 500;
export const MAX_TRANSCRIPT_WORDS = 12_000;
const LIST_PAGE = 50;
const LIST_MAX_PAGES = 6;
const MEETING_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

const date = z
  .string()
  .transform((s) => new Date(s))
  .refine((d) => !Number.isNaN(d.getTime()));
const envelope = z.object({ data: z.unknown(), pagination: z.object({ next_offset: z.number().nullish() }).passthrough().nullish() }).passthrough();
const errorEnvelope = z.object({ error: z.object({ code: z.string() }).passthrough() }).passthrough();
const listItem = z.object({ id: z.string().regex(MEETING_ID), title: z.string().default(""), started_at: date, ended_at: date }).passthrough();
const meetingData = z
  .object({
    id: z.string().regex(MEETING_ID),
    title: z.string().default(""),
    started_at: date,
    ended_at: date,
    participants: z.array(z.object({ email: z.string().nullish() }).passthrough()).default([]),
    // null for a meeting recorded live; "queued"|"importing"|"transcribing"|"summarizing"|"done"|"failed" for an import.
    processing_status: z.string().nullish(),
  })
  .passthrough();
const transcriptData = z.object({ text: z.string() }).passthrough();

function checkId(id: string): void {
  if (!MEETING_ID.test(id)) throw new AnarlogError("bad_meeting_id");
}

async function readCapped(stream: ReadableStream<Uint8Array>, cap: number, overflow: "throw" | "truncate"): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > cap) {
      if (overflow === "throw") throw new AnarlogError("output_too_large");
      chunks.push(value.subarray(0, Math.max(0, cap - size)));
      size = cap;
      continue;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createAnarlogCli(
  bin: string | undefined,
  options: { callTimeoutMs?: number; maxStdoutBytes?: number } = {},
): AnarlogSource | null {
  if (!bin || !isAbsolute(bin)) return null;
  try {
    if (!statSync(bin).isFile()) return null;
  } catch {
    return null;
  }
  const cwd = tmpdir();
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" };
  const callTimeout = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const maxStdout = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;

  /** One CLI call; resolves to the parsed envelope. No shell: the argv is an array. */
  async function call(args: string[], timeoutMs = callTimeout): Promise<z.infer<typeof envelope>> {
    if (timeoutMs <= 0) throw new AnarlogError("timeout");
    const child = Bun.spawn([bin as string, "--json", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AnarlogError("timeout")), timeoutMs);
    });
    const work = (async () => {
      const [out, err] = await Promise.all([
        readCapped(child.stdout, maxStdout, "throw"),
        readCapped(child.stderr, MAX_STDERR_BYTES, "truncate"),
      ]);
      return { out, err, code: await child.exited };
    })();
    let result: { out: string; err: string; code: number };
    try {
      result = await Promise.race([work, timedOut]);
    } catch (error) {
      child.kill("SIGKILL");
      await child.exited;
      work.catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    for (const text of [result.err, result.out]) {
      const failure = errorEnvelope.safeParse(parseJson(text));
      if (failure.success) throw new AnarlogError(failure.data.error.code);
    }
    if (result.code !== 0) throw new AnarlogError("exit_failed");
    const parsed = envelope.safeParse(parseJson(result.out));
    if (!parsed.success) throw new AnarlogError("bad_output");
    return parsed.data;
  }

  return {
    async listMeetings(since) {
      const found: AnarlogMeetingSummary[] = [];
      let offset = 0;
      for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const body = await call(["meetings", "list", "--limit", String(LIST_PAGE), "--offset", String(offset)]);
        if (!Array.isArray(body.data)) throw new AnarlogError("bad_output");
        let newest = 0;
        for (const raw of body.data) {
          const item = listItem.safeParse(raw);
          if (!item.success) continue;
          newest = Math.max(newest, item.data.started_at.getTime());
          if (item.data.started_at >= since)
            found.push({ id: item.data.id, title: item.data.title, startedAt: item.data.started_at, endedAt: item.data.ended_at });
        }
        const next = body.pagination?.next_offset;
        // Newest first: once a whole page is older than `since`, so is everything after it.
        if (next == null || next <= offset || newest < since.getTime()) break;
        offset = next;
      }
      return found;
    },

    async getMeeting(id) {
      checkId(id);
      const parsed = meetingData.safeParse((await call(["meetings", "get", id])).data);
      if (!parsed.success) throw new AnarlogError("bad_output");
      const m = parsed.data;
      return {
        id: m.id,
        title: m.title,
        startedAt: m.started_at,
        endedAt: m.ended_at,
        participantEmails: m.participants.flatMap((p) => (p.email?.trim() ? [p.email.trim().toLowerCase()] : [])),
        // "Transcript complete" = processing_status is null (live recording) or "done" (import finished).
        transcriptReady: m.processing_status == null || m.processing_status === "done",
      };
    },

    async transcript(id, deadline) {
      checkId(id);
      const words: string[] = [];
      let offset = 0;
      for (;;) {
        const body = await call(
          ["meetings", "transcript", id, "--limit", String(PAGE_WORDS), "--offset", String(offset)],
          Math.min(callTimeout, deadline.getTime() - Date.now()),
        );
        const page = transcriptData.safeParse(body.data);
        if (!page.success) throw new AnarlogError("bad_output");
        words.push(...page.data.text.split(/\s+/).filter(Boolean));
        const next = body.pagination?.next_offset;
        const more = next != null && next > offset && page.data.text.trim() !== "";
        if (words.length >= MAX_TRANSCRIPT_WORDS && (more || words.length > MAX_TRANSCRIPT_WORDS)) {
          return { text: words.slice(0, MAX_TRANSCRIPT_WORDS).join(" "), cut: true };
        }
        if (!more) return { text: words.join(" "), cut: false };
        offset = next;
      }
    },
  };
}
