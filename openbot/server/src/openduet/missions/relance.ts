import { parisBusinessDaysSince } from "../items/paris-time";
import type { Review, Stage } from "./stages";

/** When a silent mission deserves a nudge, and what the nudge says. Pure. */

export const RELANCE_AFTER_BUSINESS_DAYS = 5;
export const MAX_RELANCES_PER_STAGE = 2;

type MissionClock = {
  stage: Stage;
  review: Review;
  stageEnteredAt: Date;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
};

/** The latest sign of life on a mission: entering the stage, or a mail either way. */
export function silenceAnchor(m: Pick<MissionClock, "stageEnteredAt" | "lastInboundAt" | "lastOutboundAt">): Date {
  const times = [m.stageEnteredAt, m.lastInboundAt, m.lastOutboundAt].filter((d): d is Date => d !== null);
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

/**
 * Where the relance clock starts: the later of the last sign of life and the end of the last interview
 * that took place. Used both to decide a relance is due and to key its window.
 */
export function relanceAnchor(
  m: Pick<MissionClock, "stageEnteredAt" | "lastInboundAt" | "lastOutboundAt">,
  lastEndedInterviewEnd: Date | null,
): Date {
  const silence = silenceAnchor(m);
  return lastEndedInterviewEnd && lastEndedInterviewEnd > silence ? lastEndedInterviewEnd : silence;
}

export type InterviewFacts = { lastEndedInterviewEnd: Date | null; hasUpcomingInterview: boolean };

/**
 * `relancesInStage` is how many relances were already sent since the mission entered its stage. Stage
 * `interview` is allowed only once a linked interview has ended and no later round is scheduled.
 */
export function relanceDue(
  m: MissionClock,
  now: Date,
  relancesInStage: number,
  interview: InterviewFacts = { lastEndedInterviewEnd: null, hasUpcomingInterview: false },
): boolean {
  if (m.review !== "active") return false;
  if (m.stage === "interview") {
    if (!interview.lastEndedInterviewEnd || interview.hasUpcomingInterview) return false;
  } else if (m.stage !== "applied" && m.stage !== "talking") return false;
  if (relancesInStage >= MAX_RELANCES_PER_STAGE) return false;
  return parisBusinessDaysSince(relanceAnchor(m, interview.lastEndedInterviewEnd), now) >= RELANCE_AFTER_BUSINESS_DAYS;
}

export function relanceBody(m: { company: string; role: string | null }): string {
  const about = m.role ? `la mission ${m.role} chez ${m.company}` : `la mission chez ${m.company}`;
  return [
    "Bonjour,",
    "",
    `Je me permets de revenir vers vous au sujet de ${about}. Y a-t-il du nouveau de votre côté ?`,
    "Je reste disponible pour échanger quand cela vous convient.",
    "",
    "Bien cordialement,",
  ].join("\n");
}
