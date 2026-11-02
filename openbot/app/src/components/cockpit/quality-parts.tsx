import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useState } from "react";
import { Chip, type Tone } from "@/components/cockpit/parts";
import { Button } from "@/components/ui/button";
import {
  gradeOf,
  type Priority,
  type TrendPoint,
  trendPoints,
} from "@/lib/cockpit/quality";
import { cn } from "@/lib/utils";

const GRADE_TONE: Record<string, Tone> = {
  A: "good",
  B: "good",
  C: "warn",
  D: "warn",
  F: "bad",
};

export const PRIORITY_TONE: Record<Priority, Tone> = {
  high: "bad",
  medium: "warn",
  low: "plain",
};

/** A letter grade as a chip, optionally with the score. */
export function GradeChip({ grade, score }: { grade: string; score?: number }) {
  return (
    <Chip tone={GRADE_TONE[grade] ?? "plain"}>
      {grade}
      {score === undefined ? "" : ` · ${score}`}
    </Chip>
  );
}

/** One category's score as a labelled bar; null means it does not apply. */
export function CategoryBar({
  label,
  weight,
  score,
  reasons,
}: {
  label: string;
  weight: number;
  score: number | null;
  reasons: string[];
}) {
  const tone = score === null ? "" : GRADE_TONE[gradeOf(score)];
  return (
    <div className="px-4 py-3">
      <div className="type-sub flex items-center justify-between gap-3">
        <span className="font-medium">
          {label} <span className="text-muted-foreground">weight {weight}</span>
        </span>
        <span>{score === null ? "n/a" : `${Math.round(score)}/100`}</span>
      </div>
      {score !== null ? (
        <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full",
              tone === "bad" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : "bg-primary",
            )}
            style={{ width: `${Math.min(100, Math.max(0, score))}%` }}
          />
        </div>
      ) : null}
      {reasons.length ? (
        <ul className="type-caption mt-2 list-none text-muted-foreground">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The 30-day score trend as a small hand-written SVG line (0 to 100). */
export function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const w = 300;
  const h = 60;
  if (trend.length === 0) {
    return <p className="type-sub px-4 py-3 text-muted-foreground">No history yet.</p>;
  }
  const points = trendPoints(trend, w, h);
  const first = trend[0];
  const last = trend[trend.length - 1];
  return (
    <div className="px-4 py-3">
      <svg
        aria-label={`Score trend, ${trend.length} day(s), from ${first?.score} to ${last?.score}`}
        className="h-16 w-full text-primary"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${w} ${h}`}
      >
        <line className="stroke-border" strokeWidth={1} x1={0} x2={w} y1={h * 0.1} y2={h * 0.1} />
        <line className="stroke-border" strokeWidth={1} x1={0} x2={w} y1={h * 0.4} y2={h * 0.4} />
        <polyline
          fill="none"
          points={points}
          stroke="currentColor"
          strokeLinejoin="round"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="type-caption flex justify-between text-muted-foreground">
        <span>{first?.day}</span>
        <span>{last?.day}</span>
      </div>
    </div>
  );
}

/** Copies text to the clipboard and says so for two seconds. */
export function CopyPromptButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {copied ? <IconCheck /> : <IconCopy />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/** A label and a value on one line. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="type-sub flex items-baseline justify-between gap-3 px-4 py-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

export const yesNo = (v: boolean) => <Chip tone={v ? "good" : "warn"}>{v ? "yes" : "no"}</Chip>;
