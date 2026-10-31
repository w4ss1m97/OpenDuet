/** Missions as the Duet API sends them, plus the pure pipeline helpers the screen uses. No React here. */

export type Stage =
  | "piste"
  | "applied"
  | "talking"
  | "interview"
  | "offer"
  | "signed"
  | "refused";

export type Mission = {
  id: string;
  company: string;
  role: string | null;
  stage: Stage;
  review: "proposed" | "active" | "dismissed";
  title: string;
  stageEnteredAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  closedAt: string | null;
};

export type Relance = {
  id: string;
  missionId: string;
  body: string;
  status: "draft" | "sent" | "dismissed";
  createdAt: string;
};

export const STAGE_LABELS: Record<Stage, string> = {
  piste: "Piste",
  applied: "Postulé",
  talking: "Échange",
  interview: "Entretien",
  offer: "Proposition",
  signed: "Signé",
  refused: "Refusé",
};

const PIPELINE: Stage[] = ["piste", "applied", "talking", "interview", "offer", "signed", "refused"];
const day = 24 * 3600_000;

function isTerminal(stage: Stage) {
  return stage === "signed" || stage === "refused";
}

/** Where a mission can go: later stages, and "refused" from any open stage; nothing from a closed one. */
export function nextStages(stage: Stage): Stage[] {
  if (isTerminal(stage)) return [];
  const from = PIPELINE.indexOf(stage);
  return PIPELINE.filter((to) => PIPELINE.indexOf(to) > from);
}

/** Missions grouped by stage in pipeline order (closed stages last); stages with no mission are left out. */
export function groupByStage(missions: Mission[]): { stage: Stage; missions: Mission[] }[] {
  return PIPELINE.map((stage) => ({
    stage,
    missions: missions.filter((m) => m.stage === stage),
  })).filter((group) => group.missions.length > 0);
}

export function daysInStage(mission: Mission, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(mission.stageEnteredAt).getTime()) / day));
}
