import { describe, expect, test } from "bun:test";
import { toCsv } from "../src/openduet/cockpit/csv";
import { csvFor, summarize } from "../src/openduet/cockpit/usage-query";
import { HOME, PROJECTS, config, row, storeWith } from "./support/usage-fixture";

describe("toCsv", () => {
  test("quotes every string, doubles quotes and leaves numbers bare", () => {
    expect(toCsv(["a", "b"], [["x", 1.5], ['say "hi", ok', 0]])).toBe('"a","b"\r\n"x",1.5\r\n"say ""hi"", ok",0\r\n');
  });

  test("a cell that starts like a formula gets a leading apostrophe", () => {
    for (const cell of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      expect(toCsv(["h"], [[cell]])).toBe(`"h"\r\n"'${cell}"\r\n`);
    }
    expect(toCsv(["h"], [["a=b", "ok"]])).toBe('"h"\r\n"a=b","ok"\r\n');
  });

  test("a negative or odd number is not touched, a non-finite one is empty", () => {
    expect(toCsv(["n"], [[-3], [Number.NaN]])).toBe('"n"\r\n-3\r\n\r\n');
  });

  test("a header that looks like a formula is sanitized too", () => {
    expect(toCsv(["=evil"], [])).toBe(`"'=evil"\r\n`);
  });
});

describe("csvFor", () => {
  const store = storeWith(
    [
      row({ model: "opus-4-5", input: 1_000_000, requests: 2 }),
      row({ session: "s2", model: "sonnet-4-5", agent: "=Explore", agentId: "agent-x", input: 1_000_000, requests: 1 }),
    ],
    [["s1", "-Users-me-alpha", "/Users/me/alpha", '=cmd|"x"'], ["s2", "-Users-me-alpha", "/Users/me/alpha", null]],
  );
  const summary = summarize({ store, config: config(), projects: PROJECTS, tz: "Europe/Paris", now: Date.parse("2026-10-30T12:00:00Z"), home: HOME }, "2026-10-01", "2026-10-30");

  test("the four views have their own headers and rows", () => {
    expect(csvFor("days", summary).split("\r\n")[0]).toBe('"day","project","model","agent","input","cache_write_5m","cache_write_1h","cache_read","output","requests","tokens","cost_usd"');
    expect(csvFor("models", summary).split("\r\n")[0]).toStartWith('"model",');
    expect(csvFor("agents", summary).split("\r\n")[0]).toStartWith('"agent",');
    expect(csvFor("sessions", summary).split("\r\n")[0]).toStartWith('"session","name","project"');
    expect(csvFor("days", summary).trimEnd().split("\r\n")).toHaveLength(3);
  });

  test("session names and agents are sanitized", () => {
    expect(csvFor("sessions", summary)).toContain(`"'=cmd|""x"""`);
    expect(csvFor("agents", summary)).toContain(`"'=Explore"`);
  });
});
