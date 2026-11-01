import { IconExternalLink } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { PageEmpty } from "@/components/layout/page-shell";
import {
  type AttentionItem,
  type CheckStatus,
  CockpitOffError,
  type CockpitRun,
  type Severity,
} from "@/lib/cockpit/queries";
import { agoShort } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/** Seconds since the epoch, said as "3 hr ago". */
export function agoSeconds(t: number | null | undefined): string {
  return t ? agoShort(new Date(t * 1000).toISOString()) : "never";
}

export function agoMillis(t: number): string {
  return agoShort(new Date(t).toISOString());
}

const TONES = {
  good: "bg-green-500/15 text-green-700 dark:text-green-400",
  bad: "bg-red-500/15 text-red-700 dark:text-red-400",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  plain: "bg-muted text-muted-foreground",
} as const;

export type Tone = keyof typeof TONES;

export function Chip({
  children,
  tone = "plain",
}: {
  children: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={cn(
        "type-caption inline-flex items-center rounded-full px-2 py-0.5 font-medium",
        TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export const SEVERITY_TONE: Record<Severity, Tone> = {
  high: "bad",
  medium: "warn",
  low: "plain",
};

export function checksTone(c: CheckStatus): Tone {
  return c === "success"
    ? "good"
    : c === "failure"
      ? "bad"
      : c === "pending"
        ? "warn"
        : "plain";
}

export function checksLabel(c: CheckStatus): string {
  return c === "none" ? "no checks" : c;
}

/** A run's outcome: its conclusion once finished, otherwise where it is. */
export function runState(r: CockpitRun): { label: string; tone: Tone } {
  const label = r.status === "completed" ? (r.conclusion ?? "done") : r.status;
  const tone: Tone =
    label === "success"
      ? "good"
      : label === "failure" || label === "timed_out"
        ? "bad"
        : label === "completed" || label === "cancelled" || label === "skipped"
          ? "plain"
          : "warn";
  return { label: label.replace("_", " "), tone };
}

/** A GitHub link opens in a new tab. */
export function External({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {children}
      <IconExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
    </a>
  );
}

/** One attention line. A line with no GitHub link goes to the project's page. */
export function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Chip tone={SEVERITY_TONE[item.severity]}>{item.severity}</Chip>
      <div className="type-sub min-w-0 flex-1">
        <span className="font-medium">{item.project}</span>
        <span className="text-muted-foreground"> · {item.message}</span>
      </div>
      {item.link ? (
        <External href={item.link}>
          <span className="type-sub">Open</span>
        </External>
      ) : (
        <Link
          className="type-sub underline-offset-2 hover:underline"
          params={{ name: item.project }}
          to="/cockpit/projects/$name"
        >
          Open
        </Link>
      )}
    </div>
  );
}

/** What a failed read says. A server that does not answer is the off state. */
export function CockpitProblem({ error }: { error: Error }) {
  if (error instanceof CockpitOffError) {
    return (
      <PageEmpty>
        Cockpit is off (start the server with OPENDUET_COCKPIT=1).
      </PageEmpty>
    );
  }
  return <PageEmpty>{error.message}</PageEmpty>;
}
