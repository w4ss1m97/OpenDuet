import type { GrantedTool } from "@openbot/toolkit/granted-tool";
import { z } from "zod";
import type { AuditInitiator } from "../../audit";
import type { IntakeReport } from "./intake";
import type { ItemStore } from "./store";
import type { Scanner } from "./types";

export const INTAKE_REPORT_TOOL = "intake_report";

const SOURCE_NAMES: Record<Scanner, string> = {
  mail: "Gmail",
  calendar: "Google Agenda",
  notes: "Apple Notes",
  projects: "Projets",
};

const WINDOW_MS = 48 * 60 * 60 * 1000;

/** What the last intake found, for the brief's "since last time". Read-only. */
export function intakeReportTools(options: {
  actorId: string;
  initiator: AuditInitiator;
  store: ItemStore;
  report: (ownerUserId: string) => IntakeReport | null;
}): GrantedTool[] {
  const parameters = z.object({}).strict();
  return [
    {
      name: INTAKE_REPORT_TOOL,
      ref: `openduet/${INTAKE_REPORT_TOOL}`,
      description: [
        "What Duet gathered since last time from mail, calendar, Apple Notes and projects: how many items were added, how many cards wait to be sorted, what is due within 48 hours, and which sources could not be read.",
        "Never describe a source listed in failedSources as quiet; name it and say it reconnects from Connexions.",
      ].join(" "),
      parameters,
      initiator: options.initiator,
      async execute() {
        const report = options.report(options.actorId);
        const now = Date.now();
        const active = await options.store.list(options.actorId, { status: ["active"] });
        const dueWithin48h = active
          .filter((item) => item.dueAt && item.dueAt.getTime() <= now + WINDOW_MS)
          .map((item) => ({ title: item.title, dueAt: item.dueAt?.toISOString() }));
        if (!report) return JSON.stringify({ ranYet: false, dueWithin48h });
        return JSON.stringify({
          ranYet: true,
          since: report.at.toISOString(),
          added: report.added,
          proposed: report.proposed,
          dueWithin48h,
          failedSources: report.failed.map((f) => `${SOURCE_NAMES[f.scanner]} (${f.error})`),
        });
      },
    },
  ];
}
