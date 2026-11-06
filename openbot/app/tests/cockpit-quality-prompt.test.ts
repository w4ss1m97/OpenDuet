import { expect, test } from "bun:test";
import { reviewPrompt } from "@/lib/cockpit/review-prompt";
import type { QualityResult } from "@/lib/cockpit/quality";

const result = {
  project: "Duet",
  path: "~/src/Duet",
  default: "main",
  grade: "C",
  score: 72,
  security: {
    local: [
      { file: "src/a.ts", line: 12, type: "AWS access key", severity: "high" },
      { file: ".env", line: 0, type: "tracked sensitive file", severity: "high" },
    ],
    gitignore: [],
    codeScanning: null,
    secretScanning: null,
  },
  health: { largest: [{ file: "big.ts", lines: 900, flag: true }], todo: { TODO: 3 } },
  highFindings: [],
  suggestions: [],
} as unknown as QualityResult;

test("security prompt names file:line and type only", () => {
  const text = reviewPrompt("security", result);
  expect(text).toContain("/review-sec");
  expect(text).toContain("src/a.ts:12 (AWS access key)");
  expect(text).toContain(".env (tracked sensitive file)");
  expect(text).toContain("Duet");
  expect(text).toMatch(/do not print|never print/i);
});

test("code prompt starts with /code-review and carries no matched text", () => {
  const text = reviewPrompt("code", result);
  expect(text.startsWith("/code-review")).toBe(true);
  expect(text).not.toContain("AKIA");
});
