import { describe, expect, test } from "bun:test";
import { DEFAULT_PRICES } from "../src/openduet/cockpit/usage-prices";
import { budgetAttention, budgetStatus, projectLabel, resolveProject, resolveRange, sessionDetail, summarize, weekStart } from "../src/openduet/cockpit/usage-query";
import { HOME, PROJECTS, config, row, storeWith } from "./support/usage-fixture";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const ctx = (store: ReturnType<typeof storeWith>, over: Record<string, unknown> = {}) => ({ store, config: config(), projects: PROJECTS, tz: "Europe/Paris", now: NOW, home: HOME, ...over });

describe("project resolution", () => {
  test("a worktree cwd under the project path belongs to the project", () => {
    expect(resolveProject({ dir: "-Users-me-other", cwd: "/Users/me/alpha/.claude/worktrees/x" }, PROJECTS, HOME)).toBe("Alpha");
    expect(resolveProject({ dir: "-Users-me-other", cwd: "/Users/me/alpha" }, PROJECTS, HOME)).toBe("Alpha");
  });

  test("a sibling folder that only shares the prefix does not match", () => {
    expect(resolveProject({ dir: "-Users-me-alpha-two", cwd: "/Users/me/alpha-two" }, PROJECTS, HOME)).toBe("alpha-two");
  });

  test("without a cwd the transcript folder decides, worktrees included", () => {
    expect(resolveProject({ dir: "-Users-me-alpha", cwd: "" }, PROJECTS, HOME)).toBe("Alpha");
    expect(resolveProject({ dir: "-Users-me-alpha--claude-worktrees-feat", cwd: "" }, PROJECTS, HOME)).toBe("Alpha");
  });

  test("an unmapped folder gets a readable label", () => {
    expect(projectLabel("-Users-me-Desktop-Barber--claude-worktrees-x", HOME)).toBe("Barber (worktree)");
    expect(projectLabel("-Users-me-Documents-notes", HOME)).toBe("notes");
    expect(projectLabel("-Users-me", HOME)).toBe("~");
    expect(projectLabel("-Users-me-scratch-workspaces-abc", HOME)).toBe("(no folder)");
    expect(projectLabel("-opt-elsewhere", HOME)).toBe("-opt-elsewhere");
    expect(resolveProject(undefined, PROJECTS, HOME)).toBe("(unknown)");
  });

  test("history is relabeled when the project list changes", () => {
    const store = storeWith([row({ output: 5, requests: 1 })], [["s1", "-Users-me-alpha", "/Users/me/alpha"]]);
    expect(summarize(ctx(store, { projects: [] }), "2026-10-01", "2026-10-30").days[0]!.project).toBe("alpha");
    expect(summarize(ctx(store), "2026-10-01", "2026-10-30").days[0]!.project).toBe("Alpha");
  });
});

describe("summarize", () => {
  const store = storeWith(
    [
      row({ model: "opus-4-5-20251101", input: 1_000_000, cw5: 1_000_000, cw1h: 1_000_000, cr: 1_000_000, output: 1_000_000, requests: 4 }),
      row({ day: "2026-10-29", hour: 23, model: "mystery-1", input: 1000, output: 10, requests: 1 }),
      row({ day: "2026-09-01", output: 1, requests: 1 }),
      row({ day: "2026-10-30", hour: 13, model: "sonnet-4-5", input: 3_000_000, requests: 2 }),
    ],
    [["s1", "-Users-me-alpha", "/Users/me/alpha", "Fix it"]],
  );

  test("prices rows at query time, counts tokens without cache reads, keeps the range", () => {
    const out = summarize(ctx(store), "2026-10-01", "2026-10-30");
    const opus = out.days.find((d) => d.model === "opus-4-5-20251101")!;
    expect(opus).toMatchObject({ day: "2026-10-28", project: "Alpha", agent: "main", requests: 4, tokens: 4_000_000 });
    expect(opus.cost).toBeCloseTo(5 + 6.25 + 10 + 0.5 + 25, 6);
    expect(out.days.some((d) => d.day === "2026-09-01")).toBe(false);
    expect(out.firstDay).toBe("2026-09-01");
    expect(out.from).toBe("2026-10-01");
    expect(out.hours.find((h) => h.hour === 23)).toMatchObject({ day: "2026-10-29" });
    expect(out.sessions).toEqual([expect.objectContaining({ id: "s1", name: "Fix it", project: "Alpha", mainRequests: 7, mainOpusRequests: 4, subagents: 0, first: "2026-10-28", last: "2026-10-30" })]);
  });

  test("the cost follows a price change and unknown models are listed with the fallback price", () => {
    const base = summarize(ctx(store), "2026-10-01", "2026-10-30");
    expect(base.unknownModels).toEqual(["mystery-1"]);
    expect(base.days.find((d) => d.model === "mystery-1")!.cost).toBeCloseTo((1000 * 3 + 10 * 15) / 1e6, 6);
    const doubled = Object.fromEntries(Object.entries(DEFAULT_PRICES).map(([k, v]) => [k, v.map((x) => x * 2)]));
    const next = summarize(ctx(store, { config: config({ prices: doubled as never }) }), "2026-10-01", "2026-10-30");
    const was = base.days.find((d) => d.model === "opus-4-5-20251101")!.cost;
    expect(next.days.find((d) => d.model === "opus-4-5-20251101")!.cost).toBeCloseTo(was * 2, 6);
  });

  test("the burn rate is the cost of the last three Paris hours divided by three", () => {
    // NOW is 13:00 Paris on 2026-10-30 (UTC+1): hours 10, 11, 12 and 13 count from 10:00.
    const out = summarize(ctx(store), "2026-10-01", "2026-10-30");
    expect(out.burnPerHour).toBeCloseTo((3_000_000 * 3) / 1e6 / 3, 4);
  });

  test("opus subagents doing search work are flagged", () => {
    const withAgents = storeWith(
      [
        row({ model: "opus-4-5", agent: "Explore", agentId: "agent-a", input: 1_000_000, requests: 2 }),
        row({ model: "opus-4-5", agent: "general-purpose", agentId: "agent-b", input: 1_000_000, requests: 2 }),
        row({ model: "sonnet-4-5", agent: "Explore", agentId: "agent-c", input: 1_000_000, requests: 2 }),
      ],
      [["s1", "-Users-me-alpha", "/Users/me/alpha"]],
    );
    withAgents.subagents["s1|agent-b"] = { session: "s1", agentId: "agent-b", agent: "general-purpose", description: "Find usages of foo" };
    const flags = summarize(ctx(withAgents), "2026-10-01", "2026-10-30").flags;
    expect(flags.map((f) => f.agent).sort()).toEqual(["Explore", "general-purpose"]);
  });
});

describe("sessionDetail", () => {
  test("lists days and agents of one session, null for an unknown one", () => {
    const store = storeWith(
      [row({ output: 5, requests: 1 }), row({ agent: "Explore", agentId: "agent-a", model: "haiku-4-5", output: 7, requests: 1 })],
      [["s1", "-Users-me-alpha", "/Users/me/alpha", "Fix it"]],
    );
    store.subagents["s1|agent-a"] = { session: "s1", agentId: "agent-a", agent: "Explore", description: "Look around" };
    const out = sessionDetail(ctx(store), "s1")!;
    expect(out).toMatchObject({ id: "s1", name: "Fix it", project: "Alpha" });
    expect(out.days.map((d) => [d.day, d.model, d.agent])).toEqual([["2026-10-28", "haiku-4-5", "Explore"], ["2026-10-28", "sonnet-4-5", "main"]]);
    expect(out.agents.find((a) => a.agentId === "agent-a")).toMatchObject({ agent: "Explore", description: "Look around", model: "haiku-4-5", output: 7 });
    expect(sessionDetail(ctx(store), "nope")).toBeNull();
  });
});

describe("resolveRange", () => {
  test("defaults to the last 30 Paris days", () => {
    expect(resolveRange(undefined, undefined, NOW, "Europe/Paris")).toEqual({ from: "2026-10-01", to: "2026-10-30" });
  });
  test("rejects bad dates, reversed ranges and spans over 400 days", () => {
    for (const [from, to] of [["2026-13-01", "2026-12-01"], ["nope", undefined], ["2026-02-30", "2026-03-01"], ["2026-10-02", "2026-10-01"], ["2025-01-01", "2026-10-30"]] as const) {
      expect("error" in resolveRange(from, to, NOW, "Europe/Paris")).toBe(true);
    }
    expect(resolveRange("2025-09-27", "2026-10-30", NOW, "Europe/Paris")).toEqual({ from: "2025-09-27", to: "2026-10-30" });
  });
});

describe("weekly budgets", () => {
  test("the week starts on Monday in Paris: Sunday 23:30Z is already the next week", () => {
    expect(weekStart(Date.parse("2026-10-25T23:30:00Z"), "Europe/Paris")).toBe("2026-10-26"); // 00:30 Monday
    expect(weekStart(Date.parse("2026-10-25T21:30:00Z"), "Europe/Paris")).toBe("2026-10-19"); // Sunday 22:30 Paris
    expect(weekStart(Date.parse("2026-10-30T12:00:00Z"), "Europe/Paris")).toBe("2026-10-26");
  });

  const spend = storeWith(
    [
      row({ day: "2026-10-26", input: 1_000_000, cr: 5_000_000, output: 0, requests: 1 }), // $3 + $1.5
      row({ day: "2026-10-20", input: 9_000_000 }), // last week
      row({ session: "s2", day: "2026-10-27", input: 1_000_000 }), // $3, another project
    ],
    [["s1", "-Users-me-alpha", "/Users/me/alpha"], ["s2", "-Users-me-beta", "/Users/me/beta"]],
  );

  test("dollars count cache reads, tokens do not, other weeks and unknown scopes are 0", () => {
    const budgets = [
      { scope: "overall", unit: "usd" as const, limit: 10 },
      { scope: "Alpha", unit: "usd" as const, limit: 4.5 },
      { scope: "Alpha", unit: "tokens" as const, limit: 2_000_000 },
      { scope: "Nowhere", unit: "usd" as const, limit: 5 },
    ];
    const out = budgetStatus(ctx(spend, { config: config({ budgets }) }));
    expect(out.map((b) => [b.scope, b.unit, b.used, Math.round(b.pct * 1000) / 1000])).toEqual([
      ["overall", "usd", 7.5, 0.75],
      ["Alpha", "usd", 4.5, 1],
      ["Alpha", "tokens", 1_000_000, 0.5],
      ["Nowhere", "usd", 0, 0],
    ]);
  });

  test("a limit of 0 is ignored", () => {
    expect(budgetStatus(ctx(spend, { config: config({ budgets: [{ scope: "overall", unit: "usd", limit: 0 }] }) }))).toEqual([]);
  });

  test("80% is a medium attention item, 100% a high one, below is silent", () => {
    const status = (pct: number, scope = "Alpha") => ({ scope, unit: "usd" as const, limit: 10, used: pct * 10, pct });
    const items = budgetAttention([status(0.79), status(0.8, "B"), status(1, "C"), status(1.4, "overall")], 80);
    expect(items.map((i) => [i.project, i.severity])).toEqual([["B", "medium"], ["C", "high"], ["overall", "high"]]);
    expect(items[0]).toEqual({ project: "B", severity: "medium", message: "Weekly budget at 80%: 8 of 10 $ (API-equivalent)", link: null });
    expect(budgetAttention([{ scope: "x", unit: "tokens", limit: 1000, used: 900, pct: 0.9 }], 90)[0]!.message).toBe("Weekly budget at 90%: 900 of 1000 tokens");
    expect(budgetAttention([status(0.5)], 40)).toHaveLength(1);
  });
});
