import type { CockpitProject } from "./queries";

/** The text a person pastes into a fresh Claude Code session to pick a project back up. */
export function resumePrompt(p: CockpitProject): string {
  const files = p.dirty?.files ?? [];
  const lines = [
    `Resume work on ${p.name} (${p.path}).`,
    `Branch ${p.branch} (default ${p.default}): ${p.ahead ?? 0} unpushed, ${p.behind ?? 0} behind, ${p.dirty?.count ?? 0} uncommitted file(s)${files.length ? ` (${files.join(", ")})` : ""}.`,
  ];
  for (const x of p.prs ?? []) {
    lines.push(`Open PR #${x.number} ${x.title} [${x.checks}] ${x.url}`);
  }
  for (const w of (p.worktrees ?? []).filter((w) => w.ahead)) {
    lines.push(
      `Worktree ${w.path}: ${w.branch}, ${w.ahead} commit(s) not in ${p.default}${w.prMerged ? " (PR merged)" : ""}`,
    );
  }
  const sections = p.notes?.sections ?? [];
  if (sections.length) {
    lines.push("", "Session notes:");
    for (const x of sections) lines.push(`## ${x.title}`, x.text, "");
  } else {
    lines.push("");
  }
  lines.push(
    "Read .claude/session-notes.md, then continue with the Exact next step.",
  );
  return lines.join("\n");
}
