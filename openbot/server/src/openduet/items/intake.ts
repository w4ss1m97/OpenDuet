import { proactiveInitiator } from "../../proactive/restriction";
import { CALENDAR_LIST, type CallTool, displayName, GMAIL_SEARCH } from "../brief";
import { contactOf, missionSignal } from "../missions/mail-signal";
import { type MatchedBy, type MissionStore, UntrustedMatchError } from "../missions/store";
import type { MissionSignal, Stage } from "../missions/stages";
import { type CalendarEvent, parseEvent } from "./calendar-parser";
import { classify, defaultRemindAt } from "./classify";
import { MAIL_QUERIES, type MailMessage, parseMail } from "./mail-parsers";
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
/** Sources whose items change in place: an event moves, a project moves on. */
const TRACKED = new Set(["gcal", "project"]);
const TIMED_OUT = "Source illisible : pas de réponse à temps.";

/** Rejects when `work` has not settled in time, so no source can hold the whole intake. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMED_OUT)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

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
  /** How long one scanner may take before it counts as unreadable. 90 s by default. */
  scannerTimeoutMs?: number;
  /** The missions pipeline. Absent, mail is read exactly as before and nothing touches missions. */
  missions?: MissionStore;
};

type ScanResult = {
  candidates: ItemCandidate[];
  cursor: unknown;
  /** Mail scanner only: the messages read, and which of them came from a mission contact. */
  mails?: { messages: MailMessage[]; fromContacts: Set<string> };
};

const SIGNAL_STAGE: Record<MissionSignal, Stage> = {
  rejection: "refused",
  offer: "offer",
  invite: "interview",
  reply: "talking",
};
/** Names that stand for a platform, never for the company behind an offer. */
const PLATFORM_KEYS = new Set(["malt", "freework", "collective", "linkedin"]);
const MAX_RUN_WORDS = 5;

/** Whether the words of `text`, run together, spell the company key as whole words. */
function namesCompany(text: string, key: string): boolean {
  if (key.length < 3 || PLATFORM_KEYS.has(key)) return false;
  const words = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let start = 0; start < words.length; start += 1) {
    let run = "";
    for (let end = start; end < Math.min(words.length, start + MAX_RUN_WORDS); end += 1) {
      run += words[end];
      if (run === key) return true;
      if (run.length >= key.length) break;
    }
  }
  return false;
}

/**
 * One mail about a mission: find its mission (thread, contact, then a company named in the words),
 * move it, and tie the mail's item to it. An unmatched mission mail becomes a proposed piste.
 * Everything here is idempotent, so a failed run is simply read again.
 */
async function applyMailToMissions(
  deps: Required<Pick<IntakeDeps, "missions" | "store">>,
  ownerUserId: string,
  mail: MailMessage,
  candidate: ItemCandidate | undefined,
): Promise<void> {
  const { missions } = deps;
  const sent = new Date(mail.date);
  const at = Number.isNaN(sent.getTime()) ? new Date() : sent;
  const threadId = mail.threadId || undefined;
  const contact = contactOf(mail.from) ?? undefined;
  const signal = missionSignal(mail);

  let mission: Awaited<ReturnType<MissionStore["get"]>> | null = null;
  let matchedBy: MatchedBy | undefined;
  const found = await missions.matchMail(ownerUserId, { threadId, from: mail.from });
  if (found.kind === "ambiguous") return;
  if (found.kind === "match") {
    mission = found.mission;
    matchedBy = found.matchedBy;
  } else {
    const text = `${mail.subject}\n${mail.snippet}`;
    const open = await missions.list(ownerUserId, { open: true, review: ["active"] });
    const named = open.filter((m) => namesCompany(text, m.companyKey));
    if (named.length > 1) return;
    if (named[0]) {
      mission = named[0];
      matchedBy = "company";
    }
  }

  if (!mission) {
    if (!candidate) return;
    const subject = mail.subject.trim();
    const created = await missions.createPiste(ownerUserId, {
      company: displayName(mail.from) || "Mission",
      role: subject || null,
      title: subject || undefined,
      review: "proposed",
      threadId,
      contactEmail: contact,
      at,
    });
    mission = created.mission;
  } else if (signal) {
    if (mission.review === "active") {
      try {
        await missions.advance(ownerUserId, mission.id, {
          to: SIGNAL_STAGE[signal],
          source: "mail",
          sourceHash: `gmail:${mail.id}`,
          at,
          matchedBy,
        });
      } catch (error) {
        // A name in the words is not proof enough to refuse or accept an offer: only note the mail.
        if (!(error instanceof UntrustedMatchError)) throw error;
      }
    }
    await missions.recordInbound(ownerUserId, mission.id, {
      at,
      threadId,
      contactEmail: matchedBy === "company" ? undefined : contact,
    });
  }
  if (candidate) await deps.store.linkMission(ownerUserId, candidate.sourceHash, mission.id);
}

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
      const seen = new Map<string, MailMessage>();
      for (const query of MAIL_QUERIES) {
        const found = (await call(GMAIL_SEARCH, {
          query: `${query} newer_than:${days}d`,
          maxResults: MAIL_CAP,
        })) as { messages?: MailMessage[] };
        for (const m of found.messages ?? []) seen.set(m.id, m);
      }
      // Recruiters write from their own addresses: one more search for the contacts of active missions.
      const fromContacts = new Set<string>();
      const contacts = deps.missions ? await deps.missions.contactsForQuery(ownerUserId, 20) : [];
      if (contacts.length > 0) {
        const found = (await call(GMAIL_SEARCH, {
          query: `from:(${contacts.join(" OR ")}) newer_than:${days}d`,
          maxResults: MAIL_CAP,
        })) as { messages?: MailMessage[] };
        for (const m of found.messages ?? []) {
          seen.set(m.id, m);
          fromContacts.add(m.id);
        }
      }
      const messages = [...seen.values()];
      return {
        candidates: messages.flatMap((m) => parseMail(m) ?? []),
        cursor: {},
        mails: { messages, fromContacts },
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
        const { candidates, cursor, mails } = await withDeadline(
          scanners[scanner](lastSuccessAt),
          deps.scannerTimeoutMs ?? 90_000,
        );
        for (const c of candidates) {
          const status = classify(c);
          const remindAt = status === "active" ? defaultRemindAt(c, now) : [];
          const inserted = TRACKED.has(c.sourceApp)
            ? (await deps.store.upsertTracked(ownerUserId, c, status, remindAt)).inserted
            : (await deps.store.insertIfNew(ownerUserId, c, status, remindAt)) !== null;
          if (inserted) report[status === "active" ? "added" : "proposed"]++;
        }
        if (deps.missions && mails) {
          const bySource = new Map(candidates.map((c) => [c.sourceHash, c]));
          for (const m of mails.messages) {
            const candidate = bySource.get(`gmail:${m.id}`);
            const aboutMission = candidate?.channelId === "missions";
            if (!aboutMission && !mails.fromContacts.has(m.id)) continue;
            await applyMailToMissions(
              { missions: deps.missions, store: deps.store },
              ownerUserId,
              m,
              aboutMission ? candidate : undefined,
            );
          }
        }
        await deps.store.advanceCursor(ownerUserId, scanner, cursor, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failed.push({ scanner, error: message });
        await deps.store.recordFailure(ownerUserId, scanner, message).catch(() => {});
      }
    }),
  );
  if (deps.missions && !report.failed.some((f) => f.scanner === "mail")) {
    await relanceSweep(deps.missions, ownerUserId, now);
  }
  report.failed.sort((a, b) => a.scanner.localeCompare(b.scanner));
  reports.set(ownerUserId, report);
  return report;
}

/** A relance draft for each active mission that has been silent long enough. One failure does not stop the rest. */
async function relanceSweep(missions: MissionStore, ownerUserId: string, now: Date): Promise<void> {
  try {
    const waiting = await missions.list(ownerUserId, { open: true, review: ["active"], stage: ["applied", "talking"] });
    for (const mission of waiting) {
      try {
        await missions.ensureRelance(ownerUserId, mission.id, now);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "openduet-relance-error",
            error: error instanceof Error ? error.name : "UnknownError",
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "openduet-relance-error",
        error: error instanceof Error ? error.name : "UnknownError",
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
