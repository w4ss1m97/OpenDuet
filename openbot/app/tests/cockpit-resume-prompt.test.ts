import { expect, test } from "bun:test";
import type { CockpitProject } from "@/lib/cockpit/queries";
import { resumePrompt } from "@/lib/cockpit/resume-prompt";

const project: CockpitProject = {
  name: "BarberOS",
  path: "~/Desktop/Barber",
  error: null,
  default: "main",
  branch: "feat/x",
  ahead: 2,
  behind: 1,
  dirty: { count: 2, oldest: null, files: ["a.ts", "b.ts"] },
  prs: [
    {
      number: 7,
      title: "Add thing",
      branch: "feat/x",
      url: "https://github.com/o/r/pull/7",
      draft: false,
      mergeState: "CLEAN",
      checks: "success",
      updated: "2026-11-01T10:00:00Z",
    },
  ],
  worktrees: [
    { path: "/wt/a", branch: "wt-a", ahead: 3, dirty: 0, prMerged: true },
    { path: "/wt/b", branch: "wt-b", ahead: 0, dirty: 1, prMerged: false },
  ],
  notes: {
    title: "Notes",
    updated: null,
    mtime: 0,
    blocked: false,
    waiting: false,
    nextStep: "Do it",
    sections: [{ title: "State", text: "Half done." }],
  },
};

test("resume prompt names the branch, files, open PRs, ahead worktrees and notes", () => {
  const text = resumePrompt(project);
  expect(text).toContain("Resume work on BarberOS (~/Desktop/Barber).");
  expect(text).toContain(
    "Branch feat/x (default main): 2 unpushed, 1 behind, 2 uncommitted file(s) (a.ts, b.ts).",
  );
  expect(text).toContain(
    "Open PR #7 Add thing [success] https://github.com/o/r/pull/7",
  );
  expect(text).toContain(
    "Worktree /wt/a: wt-a, 3 commit(s) not in main (PR merged)",
  );
  expect(text).not.toContain("/wt/b");
  expect(text).toContain("## State\nHalf done.");
  expect(text.endsWith("then continue with the Exact next step.")).toBe(true);
});

test("resume prompt copes with no notes, no PRs and a clean tree", () => {
  const text = resumePrompt({
    ...project,
    prs: null,
    worktrees: [],
    notes: null,
    dirty: { count: 0, oldest: null, files: [] },
  });
  expect(text).toContain("0 uncommitted file(s).");
  expect(text).not.toContain("Open PR");
  expect(text).not.toContain("##");
});
