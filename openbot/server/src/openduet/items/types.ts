/** Shared shapes for Duet items. Pure: parsers import this without loading the database. */

export const ITEM_KINDS = [
  "interview",
  "followup",
  "bill",
  "fine",
  "deadline",
  "idea",
  "todo",
  "project_status",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_STATUSES = ["proposed", "active", "done", "dismissed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export type Scanner = "mail" | "calendar" | "notes" | "projects";

/** What a scanner read, before it is classified and stored. */
export type ItemCandidate = {
  kind: ItemKind;
  title: string;
  why?: string;
  dueAt?: Date;
  /** The source gave a day without a time (all-day event, "avant le 20/11"). */
  allDay?: boolean;
  amount?: number;
  currency?: string;
  channelId?: string;
  sourceApp: string;
  sourceLink?: string;
  sourceHash: string;
  /** The date (and amount, for bills and fines) was read from the source, not guessed. */
  dateExplicit: boolean;
};
