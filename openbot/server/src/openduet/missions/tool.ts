import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { AuditInitiator } from "../../audit";
import { STAGES } from "./stages";
import { IllegalTransitionError, MissionNotFoundError, type MissionStore } from "./store";

export const MISSION_UPDATE_TOOL = "mission_update";

const parameters = z
  .object({
    missionId: z.string().min(1).optional().describe("The mission to move, when a previous answer listed several."),
    company: z.string().trim().min(1).describe("The company, as the person said it."),
    role: z.string().trim().min(1).optional().describe("The role, when the person named one."),
    stage: z.enum(STAGES).describe("Where the mission stands now."),
  })
  .strict();

/** "I applied to Acme", "I have an interview at Acme": the Bot records it on the person's missions. */
export function missionTools(options: {
  actorId: string;
  initiator: AuditInitiator;
  store: Pick<MissionStore, "upsertFromChat" | "advance">;
}): GrantedTool[] {
  const brief = (m: { id: string; title: string; stage: string }) => ({ id: m.id, title: m.title, stage: m.stage });
  return [
    {
      name: MISSION_UPDATE_TOOL,
      ref: `openduet/${MISSION_UPDATE_TOOL}`,
      description: [
        "Record where a freelance mission stands when the person says it in chat: applied, talking with the client, interview, offer, signed or refused.",
        "Give the company, the role when they named one, and the stage. A mission that does not exist yet is created.",
        "If the result has an `ambiguous` list, several missions match: do not guess. Ask which one (name each by its role and stage), then call again with its missionId.",
        "A move backwards is refused; say so plainly. Keep the confirmation to one short sentence.",
      ].join(" "),
      parameters,
      initiator: options.initiator,
      async execute(args) {
        const parsed = parameters.safeParse(args ?? {});
        if (!parsed.success) return "Refused. Invalid mission_update arguments.";
        const { missionId, company, role, stage } = parsed.data;
        try {
          if (missionId) {
            const r = await options.store.advance(options.actorId, missionId, {
              to: stage,
              source: "chat",
              matchedBy: "chat",
            });
            return JSON.stringify({ created: false, moved: r.moved, mission: brief(r.mission) });
          }
          const r = await options.store.upsertFromChat(options.actorId, { company, role, stage });
          if (r.kind === "ambiguous")
            return JSON.stringify({
              ambiguous: r.missions.map((m) => ({ id: m.id, role: m.role, stage: m.stage })),
            });
          return JSON.stringify({
            created: r.kind === "created",
            moved: r.kind === "created" ? false : r.moved,
            mission: brief(r.mission),
          });
        } catch (error) {
          if (error instanceof IllegalTransitionError) return `Refused. ${error.message}.`;
          if (error instanceof MissionNotFoundError) return "Refused. That mission does not exist.";
          throw error;
        }
      },
    },
  ];
}
