import { proactiveInitiator } from "../../proactive/restriction";
import { CALENDAR_LIST, type CallTool, displayName, GMAIL_READ, GMAIL_SEARCH } from "../brief";
import type { AnarlogMeeting, AnarlogSource } from "../missions/anarlog";
import {
  DEBRIEF_MAX_AGE_MS,
  DEBRIEF_MIN_AGE_MS,
  MAX_DEBRIEFS_PER_RUN,
  buildDebriefPrompt,
  debriefDue,
  matchMeeting,
  parseDebrief,
  startsInMatchWindow,
} from "../missions/debrief";
import type { DebriefStore } from "../missions/debrief-store";
import { contactOf, missionSignal, namesCompany } from "../missions/mail-signal";
import { MAX_PREPS_PER_RUN, PREP_WINDOW_MS, buildPrepPrompt, matchEventMission, parsePrep, prepDue } from "../missions/prep";
import type { PrepStore } from "../missions/prep-store";
import { IllegalTransitionError, type MatchedBy, type MissionStore, UntrustedMatchError } from "../missions/store";
import type { MissionSignal, Stage } from "../missions/stages";
import type { Complete } from "../triage";
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
  /** Interview prep sheets. Needs `missions`; absent, no sheet is written. `timeoutMs` bounds one generation (60 s). */
  prep?: { store: PrepStore; complete: Complete; timeoutMs?: number };
  /** Interview debriefs from Anarlog recordings. Needs `missions`; absent, no debrief is written. `timeoutMs` bounds one generation (90 s). */
  debrief?: { store: DebriefStore; source: AnarlogSource; complete: Complete; timeoutMs?: number };
};

type ScanResult = {
  candidates: ItemCandidate[];
  cursor: unknown;
  /** Mail scanner only: the messages read, and which of them came from a mission contact. */
  mails?: { messages: MailMessage[]; fromContacts: Set<string> };
  /** Calendar scanner only: the events read, to tie each interview to its mission. */
  events?: CalendarEvent[];
};

const SIGNAL_STAGE: Record<MissionSignal, Stage> = {
  rejection: "refused",
  offer: "offer",
  invite: "interview",
  reply: "talking",
};
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

/**
 * Ties each interview in the calendar to its mission. A contact among the attendees is proof enough to
 * move the mission to `interview` (forward only, so a later stage stays); a company in the title only links.
 * Idempotent: a failed run is simply read again.
 */
async function linkInterviews(
  deps: Required<Pick<IntakeDeps, "missions" | "store">>,
  ownerUserId: string,
  events: CalendarEvent[],
): Promise<void> {
  const interviews = events.filter((e) => parseEvent(e) !== null);
  if (interviews.length === 0) return;
  const open = await deps.missions.list(ownerUserId, { open: true, review: ["active"] });
  for (const event of interviews) {
    const found = matchEventMission(event, open);
    if (!found) continue;
    const sourceHash = `gcal:${event.id}`;
    const linked = await deps.store.linkMission(ownerUserId, sourceHash, found.mission.id);
    // Only the mission the interview is actually tied to moves; an earlier (or manual) link wins.
    if (found.by !== "contact" || linked !== found.mission.id) continue;
    try {
      // The events table has no 'calendar' source: 'app' is the closest, a person-made change rather than a mail.
      await deps.missions.advance(ownerUserId, found.mission.id, {
        to: "interview",
        source: "app",
        sourceHash,
        matchedBy: "contact",
      });
    } catch (error) {
      if (!(error instanceof IllegalTransitionError)) throw error;
    }
  }
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
      const events = found.events ?? [];
      return {
        candidates: events.flatMap((e) => parseEvent(e) ?? []),
        cursor: {},
        events,
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
        const { candidates, cursor, mails, events } = await withDeadline(
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
        if (deps.missions && events) {
          await linkInterviews({ missions: deps.missions, store: deps.store }, ownerUserId, events);
        }
        await deps.store.advanceCursor(ownerUserId, scanner, cursor, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failed.push({ scanner, error: message });
        await deps.store.recordFailure(ownerUserId, scanner, message).catch(() => {});
      }
    }),
  );
  if (deps.missions && deps.debrief) {
    await debriefSweep(
      { missions: deps.missions, store: deps.store, debrief: deps.debrief, preps: deps.prep?.store },
      ownerUserId,
      now,
    );
  }
  if (deps.missions && !report.failed.some((f) => f.scanner === "mail")) {
    await relanceSweep(deps.missions, ownerUserId, now);
  }
  if (deps.missions && deps.prep) {
    await prepSweep({ missions: deps.missions, store: deps.store, prep: deps.prep, call }, ownerUserId, now);
  }
  report.failed.sort((a, b) => a.scanner.localeCompare(b.scanner));
  reports.set(ownerUserId, report);
  return report;
}

/** A relance draft for each active mission that has been silent long enough. One failure does not stop the rest. */
async function relanceSweep(missions: MissionStore, ownerUserId: string, now: Date): Promise<void> {
  try {
    const waiting = await missions.list(ownerUserId, { open: true, review: ["active"], stage: ["applied", "talking", "interview"] });
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

const PREP_MAIL_SEARCH = 5;
const PREP_MAIL_READ = 3;
const PREP_EVENTS = 20;
const PREP_TIMEOUT_MS = 60_000;

type Call = (ref: string, args: Record<string, unknown>) => Promise<unknown>;

function logPrepError(error: unknown): void {
  console.error(
    JSON.stringify({
      type: "openduet-prep-error",
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * A sheet for each interview due within 72 hours whose mission is open and active: at most three
 * generations a run, each attempt counted, each failure kept as the sheet's state. Never throws:
 * the sweep failing must not fail the intake.
 */
async function prepSweep(
  deps: Required<Pick<IntakeDeps, "missions" | "store" | "prep">> & { call: Call },
  ownerUserId: string,
  now: Date,
): Promise<void> {
  try {
    const { missions, prep, call } = deps;
    const upcoming = await deps.store.listUpcomingInterviews(ownerUserId, now, new Date(now.getTime() + PREP_WINDOW_MS));
    let generated = 0;
    for (const item of upcoming) {
      if (generated >= MAX_PREPS_PER_RUN) break;
      if (!item.missionId) continue;
      try {
        const mission = await missions.get(ownerUserId, item.missionId).catch(() => null);
        const current = await prep.store.getByItem(ownerUserId, item.id);
        if (!prepDue(item, mission, current, now) || !mission) continue;
        await prep.store.ensurePending(ownerUserId, item.id, mission.id);
        const claim = await prep.store.claim(ownerUserId, item.id);
        if (!claim?.claimedAt) continue;
        generated += 1;
        try {
          const events = await missions.listEvents(ownerUserId, mission.id, PREP_EVENTS);
          const mails = await prepMails(call, mission.contactEmails);
          const prompt = buildPrepPrompt({
            mission,
            events,
            interview: { title: item.title, dueAt: item.dueAt },
            mails,
          });
          const controller = new AbortController();
          const text = await withDeadline(prep.complete(prompt, controller.signal), prep.timeoutMs ?? PREP_TIMEOUT_MS).catch(
            (error) => {
              controller.abort();
              throw error;
            },
          );
          await prep.store.complete(ownerUserId, item.id, claim.claimedAt, parsePrep(text));
        } catch (error) {
          logPrepError(error);
          await prep.store.fail(ownerUserId, item.id, claim.claimedAt, error instanceof Error ? error.name : "UnknownError");
        }
      } catch (error) {
        logPrepError(error);
      }
    }
  } catch (error) {
    logPrepError(error);
  }
}

/** The first mails with the mission's contacts, read in full. None when the mission has no contact. */
async function prepMails(call: Call, contacts: string[]): Promise<{ from: string; subject: string; body: string }[]> {
  if (contacts.length === 0) return [];
  const list = contacts.slice(0, 20).join(" OR ");
  const found = (await call(GMAIL_SEARCH, {
    query: `from:(${list}) OR to:(${list}) newer_than:90d`,
    maxResults: PREP_MAIL_SEARCH,
  })) as { messages?: MailMessage[] };
  const mails: { from: string; subject: string; body: string }[] = [];
  for (const m of (found.messages ?? []).slice(0, PREP_MAIL_READ)) {
    const read = (await call(GMAIL_READ, { id: m.id })) as { from?: string; subject?: string; body?: string };
    mails.push({ from: read.from ?? m.from, subject: read.subject ?? m.subject, body: read.body ?? m.snippet });
  }
  return mails;
}

const DEBRIEF_TIMEOUT_MS = 90_000;
const DEBRIEF_TRANSCRIPT_MS = 60_000;
const LIST_MARGIN_MS = 15 * 60_000;

function logDebriefError(error: unknown): void {
  console.error(
    JSON.stringify({
      type: "openduet-debrief-error",
      error: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * The Anarlog recording of this interview, once it has a finished transcript: null when no meeting, or
 * several, fit. `used` holds the meetings other debriefs already own. `meetings` caches getMeeting calls.
 */
export async function findInterviewRecording(
  source: AnarlogSource,
  interview: { dueAt: Date | null },
  mission: { contactEmails: string[] },
  summaries: { id: string; startedAt: Date }[],
  used: ReadonlySet<string>,
  meetings: Map<string, AnarlogMeeting> = new Map(),
): Promise<AnarlogMeeting | null> {
  const candidates: AnarlogMeeting[] = [];
  for (const summary of summaries) {
    if (!startsInMatchWindow(interview, summary.startedAt)) continue;
    let meeting = meetings.get(summary.id);
    if (!meeting) {
      meeting = await source.getMeeting(summary.id);
      meetings.set(summary.id, meeting);
    }
    candidates.push(meeting);
  }
  return matchMeeting(interview, mission, candidates, used);
}

/**
 * A debrief for each recent interview whose recording has a finished transcript: at most two generations
 * a run, each attempt counted, each failure kept as the debrief's state. No due interview means no call
 * to Anarlog at all. Never throws: the sweep failing must not fail the intake. The transcript is only
 * held in memory for the prompt.
 */
async function debriefSweep(
  deps: Required<Pick<IntakeDeps, "missions" | "store" | "debrief">> & { preps?: PrepStore },
  ownerUserId: string,
  now: Date,
): Promise<void> {
  try {
    const { missions, debrief } = deps;
    const ended = await deps.store.listEndedInterviews(
      ownerUserId,
      new Date(now.getTime() - DEBRIEF_MAX_AGE_MS),
      new Date(now.getTime() - DEBRIEF_MIN_AGE_MS),
    );
    const due: { item: (typeof ended)[number]; mission: Awaited<ReturnType<MissionStore["get"]>>; ownMeeting: string | null }[] = [];
    for (const item of ended) {
      if (!item.missionId) continue;
      const mission = await missions.get(ownerUserId, item.missionId).catch(() => null);
      const current = await debrief.store.getByItem(ownerUserId, item.id);
      if (mission && debriefDue(item, mission, current, now)) {
        due.push({ item, mission, ownMeeting: current?.anarlogMeetingId ?? null });
      }
    }
    if (due.length === 0) return;

    const summaries = await debrief.source.listMeetings(new Date(now.getTime() - DEBRIEF_MAX_AGE_MS - LIST_MARGIN_MS));
    const used = await debrief.store.listUsedMeetingIds(ownerUserId);
    const meetings = new Map<string, AnarlogMeeting>();
    let generated = 0;
    for (const { item, mission, ownMeeting } of due) {
      if (generated >= MAX_DEBRIEFS_PER_RUN) break;
      try {
        const others = new Set(used);
        if (ownMeeting) others.delete(ownMeeting);
        const meeting = await findInterviewRecording(debrief.source, item, mission, summaries, others, meetings);
        if (!meeting || !meeting.transcriptReady) continue;
        const row = await debrief.store.ensurePending(ownerUserId, item.id, mission.id, meeting.id);
        if (!row) continue;
        used.add(meeting.id);
        const claim = await debrief.store.claim(ownerUserId, item.id);
        if (!claim?.claimedAt) continue;
        generated += 1;
        try {
          const transcript = await debrief.source.transcript(meeting.id, new Date(Date.now() + DEBRIEF_TRANSCRIPT_MS));
          const sheet = deps.preps ? await deps.preps.getByItem(ownerUserId, item.id) : null;
          const prompt = buildDebriefPrompt({
            mission,
            prep: sheet?.status === "ready" ? sheet.content : null,
            transcript: transcript.text,
            cut: transcript.cut,
          });
          const controller = new AbortController();
          const text = await withDeadline(debrief.complete(prompt, controller.signal), debrief.timeoutMs ?? DEBRIEF_TIMEOUT_MS).catch(
            (error) => {
              controller.abort();
              throw error;
            },
          );
          await debrief.store.complete(ownerUserId, item.id, claim.claimedAt, parseDebrief(text), meeting.endedAt);
        } catch (error) {
          logDebriefError(error);
          await debrief.store.fail(ownerUserId, item.id, claim.claimedAt, error instanceof Error ? error.name : "UnknownError");
        }
      } catch (error) {
        logDebriefError(error);
      }
    }
  } catch (error) {
    logDebriefError(error);
  }
}
