/** The mission pipeline. Pure: parsers and the store import this without loading the database. */

export const STAGES = [
  "piste",
  "applied",
  "talking",
  "interview",
  "offer",
  "signed",
  "refused",
] as const;
export type Stage = (typeof STAGES)[number];

export const REVIEWS = ["proposed", "active", "dismissed"] as const;
export type Review = (typeof REVIEWS)[number];

/** What one mail says about a mission. */
export type MissionSignal = "reply" | "invite" | "offer" | "rejection";

export function rank(stage: Stage): number {
  return STAGES.indexOf(stage);
}

export function isTerminal(stage: Stage): boolean {
  return stage === "signed" || stage === "refused";
}

/** Forward only, stages may be skipped, `refused` is reachable from any open stage, nothing leaves a terminal one. */
export function canTransition(from: Stage, to: Stage): boolean {
  if (isTerminal(from) || from === to) return false;
  if (to === "refused") return true;
  return rank(to) > rank(from);
}

/** The stage a signal leads to, or null when it is at or below the current stage. */
export function nextStage(current: Stage, signal: MissionSignal): Stage | null {
  const target: Stage =
    signal === "rejection"
      ? "refused"
      : signal === "offer"
        ? "offer"
        : signal === "invite"
          ? "interview"
          : "talking";
  return canTransition(current, target) ? target : null;
}
