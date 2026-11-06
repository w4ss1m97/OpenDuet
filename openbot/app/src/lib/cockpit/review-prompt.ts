import type { QualityResult } from "./quality";

export type ReviewKind = "security" | "code";

/*
 * A prompt to paste into Claude Code for a deeper review. It lists findings as file:line and type only:
 * the cockpit never holds the matched text, and the prompt tells the session not to print any.
 */
export function reviewPrompt(kind: ReviewKind, r: QualityResult): string {
  const head =
    kind === "security"
      ? `/review-sec Review ${r.project} (${r.path}), branch ${r.default}, for security problems.`
      : `/code-review Review ${r.project} (${r.path}), branch ${r.default}, for code quality problems.`;
  const lines = [head, `The cockpit scored it ${r.grade} (${r.score}/100).`, ""];

  if (kind === "security") {
    const hits = r.security.local.map((h) => (h.line > 0 ? `${h.file}:${h.line} (${h.type})` : `${h.file} (${h.type})`));
    lines.push("Local secret-pattern findings (file:line and type only):");
    lines.push(...(hits.length ? hits.map((h) => `- ${h}`) : ["- none"]));
    for (const g of r.security.gitignore) lines.push(`- ${g.file} (${g.why})`);
    lines.push("", "Check each one and anything similar. Do not print any secret value; name the file and line only.");
  } else {
    const big = r.health.largest.filter((f) => f.flag).map((f) => `- ${f.file} (${f.lines} lines)`);
    lines.push("Large files:", ...(big.length ? big : ["- none"]));
    const todo = Object.entries(r.health.todo).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
    if (todo.length) lines.push("", `Markers: ${todo.join(", ")}.`);
    const open = r.suggestions.filter((s) => s.priority !== "low").map((s) => `- ${s.title}`);
    if (open.length) lines.push("", "Cockpit suggestions:", ...open);
    lines.push("", "Look for dead code, duplication and risky changes. Never print any secret value.");
  }
  return lines.join("\n");
}
