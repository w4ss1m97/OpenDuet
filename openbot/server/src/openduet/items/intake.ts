import { proactiveInitiator } from "../../proactive/restriction";
import { CALENDAR_LIST, type CallTool, GMAIL_SEARCH } from "../brief";
import { type CalendarEvent, parseEvent } from "./calendar-parser";
import { classify, defaultRemindAt } from "./classify";
import { MAIL_QUERY, type MailMessage, parseMail } from "./mail-parsers";
import { type HostRunner, scanNotes } from "./notes-scanner";
import { hostProjectReader, type Project, scanProject } from "./project-scanner";
import type { ItemStore } from "./store";
import type { ItemCandidate, Scanner } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_MAIL_DAYS = 7;
const MAX_MAIL_DAYS = 30;
const CALENDAR_DAYS = 14;
const MAIL_CAP = 50;
const NO_BRIDGE = "Mac bridge non connecté";

export type IntakeReport = {
  at: Date;
  added: number;
  proposed: number;
  failed: { scanner: Scanner; error: string }[];
};

export type IntakeDeps = {
  store: ItemStore;
  callTool: CallTool;
  host: HostRunner | null;
  projects: Project[];
  now: () => Date;
};

type ScanResult = { candidates: ItemCandidate[]; cursor: unknown };

const reports = new Map<string, IntakeReport>();

/** The last intake for this person since the server started, for the brief. */
export function lastIntakeReport(ownerUserId: string): IntakeReport | null {
  return reports.get(ownerUserId) ?? null;
}

function toolCaller(deps: IntakeDeps, ownerUserId: string, botId: string) {
  return async (ref: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = await deps.callTool({
      ref,
      args,
      botId,
      actorId: ownerUserId,
      initiator: proactiveInitiator("openduet-intake"),
    });
    if (result.isError) throw new Error(result.text);
    return JSON.parse(result.text);
  };
}

/**
 * Reads every source once and keeps what is new. Each scanner stands alone: one that fails is named
 * in the report and keeps its cursor, so the next run reads that window again.
 */
export async function runIntake(
  deps: IntakeDeps,
  ownerUserId: string,
  botId: string,
): Promise<IntakeReport> {
  const now = deps.now();
  const call = toolCaller(deps, ownerUserId, botId);

  const scanners: Record<Scanner, (lastSuccessAt: Date | null) => Promise<ScanResult>> = {
    mail: async (lastSuccessAt) => {
      const days = lastSuccessAt
        ? Math.min(MAX_MAIL_DAYS, Math.max(1, Math.ceil((now.getTime() - lastSuccessAt.getTime()) / DAY_MS)))
        : FIRST_MAIL_DAYS;
      const found = (await call(GMAIL_SEARCH, {
        query: `(${MAIL_QUERY}) newer_than:${days}d`,
        maxResults: MAIL_CAP,
      })) as { messages?: MailMessage[] };
      return {
        candidates: (found.messages ?? []).flatMap((m) => parseMail(m) ?? []),
        cursor: {},
      };
    },
    calendar: async () => {
      const found = (await call(CALENDAR_LIST, {
        timeMin: now.toISOString(),
        timeMax: new Date(now.getTime() + CALENDAR_DAYS * DAY_MS).toISOString(),
      })) as { events?: CalendarEvent[] };
      return {
        candidates: (found.events ?? []).flatMap((e) => parseEvent(e) ?? []),
        cursor: {},
      };
    },
    notes: async (lastSuccessAt) => {
      if (!deps.host) throw new Error(NO_BRIDGE);
      const result = await scanNotes(deps.host, lastSuccessAt, undefined, now);
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    projects: async () => {
      if (!deps.host) throw new Error(NO_BRIDGE);
      const read = hostProjectReader(deps.host);
      return {
        candidates: await Promise.all(deps.projects.map((p) => scanProject(p, read, now))),
        cursor: {},
      };
    },
  };

  const report: IntakeReport = { at: now, added: 0, proposed: 0, failed: [] };
  await Promise.all(
    (Object.keys(scanners) as Scanner[]).map(async (scanner) => {
      try {
        const { lastSuccessAt } = await deps.store.getCursor(ownerUserId, scanner);
        const { candidates, cursor } = await scanners[scanner](lastSuccessAt);
        for (const c of candidates) {
          const status = classify(c);
          const item = await deps.store.insertIfNew(
            ownerUserId,
            c,
            status,
            status === "active" ? defaultRemindAt(c, now) : [],
          );
          if (item) report[status === "active" ? "added" : "proposed"]++;
        }
        await deps.store.advanceCursor(ownerUserId, scanner, cursor, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failed.push({ scanner, error: message });
        await deps.store.recordFailure(ownerUserId, scanner, message).catch(() => {});
      }
    }),
  );
  report.failed.sort((a, b) => a.scanner.localeCompare(b.scanner));
  reports.set(ownerUserId, report);
  return report;
}
