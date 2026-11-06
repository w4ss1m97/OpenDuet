import { describe, expect, test } from "bun:test";
import { classifyPath, localDayHour, parseUsageLine } from "../src/openduet/cockpit/usage-parse";

const TZ = "Europe/Paris";
const line = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}, ts = "2026-10-24T05:50:12.345Z") =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    cwd: "/Users/me/proj",
    message: { id: "msg_1", model: "claude-opus-4-5-20251101", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, ...usage }, ...over },
  });

describe("parseUsageLine", () => {
  test("reads 5m and 1h cache writes from cache_creation", () => {
    const parsed = parseUsageLine(line({}, { cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 9 }, cache_creation_input_tokens: 16 }), TZ);
    expect(parsed).toMatchObject({ kind: "usage", id: "msg_1", model: "opus-4-5-20251101", cwd: "/Users/me/proj", tok: { input: 10, cw5: 7, cw1h: 9, cr: 5, output: 20 } });
  });

  test("falls back to cache_creation_input_tokens as 5m writes", () => {
    const parsed = parseUsageLine(line({}, { cache_creation_input_tokens: 40 }), TZ);
    expect(parsed).toMatchObject({ tok: { cw5: 40, cw1h: 0 } });
  });

  test("skips synthetic and empty models, and lines without usage", () => {
    expect(parseUsageLine(line({ model: "<synthetic>" }), TZ)).toBeNull();
    expect(parseUsageLine(line({ model: "" }), TZ)).toBeNull();
    expect(parseUsageLine(JSON.stringify({ type: "assistant", timestamp: "2026-10-24T05:50:12Z", message: { model: "claude-x" } }), TZ)).toBeNull();
  });

  test("rejects negative, fractional and string counts", () => {
    expect(parseUsageLine(line({}, { input_tokens: -1 }), TZ)).toBeNull();
    expect(parseUsageLine(line({}, { output_tokens: "20" }), TZ)).toBeNull();
    expect(parseUsageLine(line({}, { cache_read_input_tokens: 1.5 }), TZ)).toBeNull();
    expect(parseUsageLine(line({}, { cache_creation: { ephemeral_1h_input_tokens: -3 } }), TZ)).toBeNull();
  });

  test("rejects bad JSON, bad timestamps and non-assistant lines", () => {
    expect(parseUsageLine("{not json", TZ)).toBeNull();
    expect(parseUsageLine(line({}, {}, "yesterday"), TZ)).toBeNull();
    expect(parseUsageLine(JSON.stringify({ type: "user", message: { content: "hi" } }), TZ)).toBeNull();
  });

  test("a custom-title line gives the session title", () => {
    expect(parseUsageLine(JSON.stringify({ type: "custom-title", customTitle: "Fix the poller" }), TZ)).toEqual({ kind: "title", title: "Fix the poller" });
    expect(parseUsageLine(JSON.stringify({ type: "custom-title", customTitle: "" }), TZ)).toBeNull();
  });

  test("a line without a message id has id null", () => {
    expect(parseUsageLine(line({ id: undefined }), TZ)).toMatchObject({ id: null });
  });
});

describe("localDayHour", () => {
  test("uses Europe/Paris across the two DST changes", () => {
    // Summer (UTC+2): 22:30Z on the 24th is 00:30 on the 25th.
    expect(localDayHour(Date.parse("2026-10-24T22:30:00Z"), TZ)).toEqual({ day: "2026-10-25", hour: 0 });
    // The clocks went back on 2026-10-25 03:00 -> 02:00; after that Paris is UTC+1.
    expect(localDayHour(Date.parse("2026-10-25T23:30:00Z"), TZ)).toEqual({ day: "2026-10-26", hour: 0 });
    // Winter (UTC+1): 23:30Z is already the next day.
    expect(localDayHour(Date.parse("2026-01-15T23:30:00Z"), TZ)).toEqual({ day: "2026-01-16", hour: 0 });
    // Spring forward 2026-03-29 01:00Z.
    expect(localDayHour(Date.parse("2026-03-29T01:00:00Z"), TZ)).toEqual({ day: "2026-03-29", hour: 3 });
  });

  test("the timezone is injectable", () => {
    expect(localDayHour(Date.parse("2026-01-15T23:30:00Z"), "UTC")).toEqual({ day: "2026-01-15", hour: 23 });
  });

  test("day and hour land in the parsed line", () => {
    expect(parseUsageLine(line({}, {}, "2026-10-24T22:30:00.000Z"), TZ)).toMatchObject({ day: "2026-10-25", hour: 0 });
  });
});

describe("classifyPath", () => {
  const root = "/h/.claude/projects";
  test("a main transcript", () => {
    expect(classifyPath(root, `${root}/-Users-me-proj/abc-123.jsonl`)).toEqual({ dir: "-Users-me-proj", session: "abc-123", agentId: "", metaPath: null });
  });
  test("a subagent transcript names its session and meta file", () => {
    expect(classifyPath(root, `${root}/-Users-me-proj/abc-123/subagents/agent-a1.jsonl`)).toEqual({
      dir: "-Users-me-proj",
      session: "abc-123",
      agentId: "agent-a1",
      metaPath: `${root}/-Users-me-proj/abc-123/subagents/agent-a1.meta.json`,
    });
  });
  test("anything else is not a transcript", () => {
    expect(classifyPath(root, `${root}/-Users-me-proj/notes.txt`)).toBeNull();
    expect(classifyPath(root, `${root}/-Users-me-proj/a/b/c.jsonl`)).toBeNull();
    expect(classifyPath(root, `/elsewhere/x/y.jsonl`)).toBeNull();
    expect(classifyPath(root, `${root}/-Users-me-proj/../x.jsonl`)).toBeNull();
  });
});
