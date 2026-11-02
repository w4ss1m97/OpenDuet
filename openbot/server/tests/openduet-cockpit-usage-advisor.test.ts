import { describe, expect, test } from "bun:test";
import { buildTips } from "../src/openduet/cockpit/usage-advisor";
import { DEFAULT_CONFIG } from "../src/openduet/cockpit/usage-prices";
import { HOME, PROJECTS, config, row, storeWith } from "./support/usage-fixture";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const run = (rows: ReturnType<typeof row>[], over = {}, sessions: Array<[string, string, string, (string | null)?]> = [["s1", "-Users-me-alpha", "/Users/me/alpha", "Big job"]]) =>
  buildTips({ store: storeWith(rows, sessions), config: config(over), projects: PROJECTS, tz: "Europe/Paris", now: NOW, home: HOME });
const opusShort = (session = "s1", input = 1_000_000) => row({ session, model: "opus-4-5", input, output: 4000, requests: 50 });

describe("advisor", () => {
  test("many short Opus turns suggest the cheaper main model, with the numbers", () => {
    const { tips, totalSaving } = run([opusShort()]);
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({
      key: "opus-short:s1", kind: "opus-short", project: "Alpha", link: "/cockpit/usage/session/s1",
      numbers: { requests: 50, avgOutputTokens: 80, opusCost: 5.1, cheaperCost: 2.04 }, saving: 3.06,
    });
    expect(tips[0]!.title).toBe("Use Sonnet for «Big job» (s1)");
    expect(totalSaving).toBe(3.06);
  });

  test("long Opus turns, few requests, subagents and old sessions give nothing", () => {
    expect(run([row({ model: "opus-4-5", input: 1_000_000, output: 40_000, requests: 50 })]).tips).toEqual([]);
    expect(run([row({ model: "opus-4-5", output: 100, requests: 39 })]).tips).toEqual([]);
    expect(run([row({ model: "sonnet-4-5", output: 100, requests: 50 })]).tips).toEqual([]);
    expect(run([{ ...opusShort(), day: "2026-10-01" }]).tips).toEqual([]);
  });

  test("a very large context per turn suggests /compact, without a saving", () => {
    const { tips } = run([row({ model: "sonnet-4-5", cr: 12_500_000, requests: 50, output: 9000 })]);
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({ kind: "big-context", saving: null, numbers: { requests: 50, avgCacheReadTokens: 250_000, cacheReadCost: 3.75 } });
    expect(run([row({ cr: 12_500_000, requests: 29 })]).tips).toEqual([]);
    expect(run([row({ cr: 5_000_000, requests: 50 })]).tips).toEqual([]);
  });

  test("Opus subagents on search work suggest the cheaper search model", () => {
    const { tips } = run([
      row({ model: "opus-4-5", agent: "Explore", agentId: "agent-a", input: 1_000_000, requests: 3 }),
      row({ model: "opus-4-5", agent: "Plan", agentId: "agent-b", input: 1_000_000, requests: 3 }),
      row({ day: "2026-09-20", model: "opus-4-5", agent: "Explore", agentId: "agent-c", input: 1_000_000, requests: 3 }),
    ]);
    expect(tips).toHaveLength(1);
    expect(tips[0]).toMatchObject({ key: "opus-search-subagents", kind: "opus-search", project: "", link: "/cockpit/usage", numbers: { runs: 1, opusCost: 5, cheaperCost: 0.1 }, saving: 4.9 });
  });

  test("keeps the costliest maxPerKind tips of a kind and sorts by weight", () => {
    const rows = [opusShort("s1", 1_000_000), opusShort("s2", 3_000_000), opusShort("s3", 2_000_000)];
    const sessions: Array<[string, string, string]> = [["s1", "-a", ""], ["s2", "-a", ""], ["s3", "-a", ""]];
    const tips = run(rows, { advisor: { ...DEFAULT_CONFIG.advisor, maxPerKind: 2 } }, sessions).tips;
    expect(tips.map((t) => t.key)).toEqual(["opus-short:s2", "opus-short:s3"]);
  });
});
