import { parisDayAt } from "./paris-time";
import type { ItemCandidate, ItemStatus } from "./types";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Active only when Duet read it plainly: an interview with its date, or a bill or fine with its date
 * and amount. Everything else waits for the person as a card.
 */
export function classify(c: ItemCandidate): ItemStatus {
  if (!c.dateExplicit || !c.dueAt) return "proposed";
  if (c.kind === "interview") return "active";
  if ((c.kind === "bill" || c.kind === "fine") && c.amount !== undefined) return "active";
  return "proposed";
}

/** The default reminders for an item, Paris time, future only, soonest first. */
export function defaultRemindAt(c: ItemCandidate, now: Date): Date[] {
  const due = c.dueAt;
  if (!due) return [];
  let reminders: Date[];
  switch (c.kind) {
    case "interview":
      reminders = [parisDayAt(due, -1, 18)];
      if (!c.allDay) reminders.push(new Date(due.getTime() - HOUR_MS));
      break;
    case "bill":
    case "fine":
      reminders = [parisDayAt(due, -3, 9), parisDayAt(due, 0, 9)];
      break;
    case "deadline":
      reminders = [parisDayAt(due, -1, 9)];
      break;
    default:
      return [];
  }
  return reminders
    .filter((at) => at.getTime() > now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());
}
