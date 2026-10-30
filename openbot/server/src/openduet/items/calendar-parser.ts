import { parisDate } from "./paris-time";
import type { ItemCandidate } from "./types";

/** One event as `google-workspace/calendar_list_events` returns it. `start` is a date or a date-time. */
export type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  location?: string;
};

const INTERVIEW = /entretien|interview|call client|qualif|échange avec|rdv client/i;

/** An interview or client meeting becomes an item; any other event is not Duet's to keep. */
export function parseEvent(e: CalendarEvent): ItemCandidate | null {
  if (!e.start || !INTERVIEW.test(`${e.summary}\n${e.location ?? ""}`)) return null;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(e.start);
  const dueAt = allDay
    ? parisDate(Number(e.start.slice(0, 4)), Number(e.start.slice(5, 7)), Number(e.start.slice(8, 10)))
    : new Date(e.start);
  if (Number.isNaN(dueAt.getTime())) return null;
  return {
    kind: "interview",
    title: e.summary,
    why: "Agenda Google",
    dueAt,
    allDay,
    channelId: "missions",
    sourceApp: "gcal",
    sourceHash: `gcal:${e.id}:${e.start}`,
    dateExplicit: true,
  };
}
