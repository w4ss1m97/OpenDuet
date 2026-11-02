import { expect, test } from "bun:test";
import {
  type AdvisorTip,
  dismissTip,
  downloadCsv,
  hourHeatmap,
  loadDismissed,
  pivotDaily,
  visibleTips,
} from "@/lib/cockpit/usage";

const row = (day: string, project: string, model: string, cost: number) => ({
  day,
  project,
  model,
  cost,
});

test("pivot by model sums cost per day", () => {
  const p = pivotDaily(
    [
      row("2026-10-07", "a", "opus-5-5", 10),
      row("2026-10-07", "b", "opus-5-5", 5),
      row("2026-10-07", "a", "haiku-5-5", 1),
      row("2026-10-09", "a", "opus-5-5", 2),
    ],
    "model",
    { from: "2026-10-07", to: "2026-10-09" },
  );
  expect(p.days).toEqual(["2026-10-07", "2026-10-08", "2026-10-09"]);
  expect(p.keys).toEqual(["opus-5-5", "haiku-5-5"]);
  expect(p.cells["2026-10-07"]).toEqual({ "opus-5-5": 15, "haiku-5-5": 1 });
  expect(p.dayTotals["2026-10-08"]).toBe(0);
  expect(p.total).toBe(18);
});

test("heatmap 7x24 fills zeros", () => {
  // 2026-10-07 is a Wednesday (index 2).
  const grid = hourHeatmap([
    { day: "2026-10-07", hour: 14, cost: 3 },
    { day: "2026-10-07", hour: 14, cost: 1 },
    { day: "2026-10-11", hour: 0, cost: 2 },
  ]);
  expect(grid).toHaveLength(7);
  for (const r of grid) expect(r).toHaveLength(24);
  expect(grid[2]?.[14]).toBe(4);
  expect(grid[6]?.[0]).toBe(2);
  expect(grid.flat().filter((v) => v === 0)).toHaveLength(7 * 24 - 2);
});

test("dismissed tip hidden for 7 days then back", () => {
  const mem = new Map<string, string>();
  const store = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  const tip = { key: "big-context:x" } as AdvisorTip;
  const t0 = Date.UTC(2026, 10, 1);
  dismissTip(store, tip.key, t0);
  const day = 86_400_000;
  expect(
    visibleTips([tip], loadDismissed(store, t0 + 6 * day), t0 + 6 * day),
  ).toEqual([]);
  expect(
    visibleTips([tip], loadDismissed(store, t0 + 7 * day), t0 + 7 * day),
  ).toEqual([tip]);
  expect(loadDismissed({ getItem: () => "not json", setItem() {} })).toEqual(
    {},
  );
});

test("csv download falls back to clipboard when Blob download throws", async () => {
  const copied: string[] = [];
  const result = await downloadCsv(
    "days",
    { from: "2026-10-01", to: "2026-10-31" },
    {
      fetchText: async (url) => {
        expect(url).toContain("view=days");
        expect(url).toContain("from=2026-10-01");
        return "day,cost\n2026-10-01,1";
      },
      save: () => {
        throw new Error("blocked");
      },
      copy: async (t) => void copied.push(t),
    },
  );
  expect(result).toBe("copied");
  expect(copied).toEqual(["day,cost\n2026-10-01,1"]);
});
