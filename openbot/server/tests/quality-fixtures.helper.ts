import { buildHealth, codeStats } from "../src/openduet/cockpit/quality-parse";
import type { QualityConfig, QualitySections } from "../src/openduet/cockpit/quality-parse";

export const CFG: QualityConfig = { enabled: true, scanHours: 24, lookbackDays: 30, bigFileLines: 800, staleBranchDays: 30, npm: true };

const ref = { conclusion: "success", url: "https://x/1", at: "2026-10-01T00:00:00Z", branch: "main" };

/** A project with nothing wrong: 100 / A. */
export function healthy(): QualitySections {
  return {
    project: "p", path: "/p", repo: "o/p", default: "main", scannedAt: 1_000_000, files: 3,
    ci: {
      available: true, days: 30, runs: 5, passRate: 100, avgSeconds: 60, flaky: [],
      workflows: [{ name: "CI", runs: 5, passRate: 100, avgSeconds: 60, last: ref, lastBase: ref }],
      coverage: { enforced: null, measured: null, source: null },
    },
    deps: { dependabot: { available: true, total: 0, bySeverity: {}, top: [] }, npm: null, python: null, gradle: false },
    security: { codeScanning: null, secretScanning: null, local: [], gitignore: [] },
    health: buildHealth([codeStats("src/a.ts", "x\n".repeat(99))!, codeStats("tests/a.test.ts", "y\n".repeat(49))!], {}, 800),
    hygiene: {
      readme: true, claudeMd: true, claudeWords: 500, notes: true, notesAgeDays: 1, notesLagDays: 0, ci: true,
      branchProtection: { protected: true }, autoMerge: true, staleBranches: [], worktrees: 0,
    },
  };
}
