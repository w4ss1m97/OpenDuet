import { queryOptions } from "@tanstack/react-query";
import { read } from "./queries";
import { cockpitPost } from "./quality";

/* Reminders (C4): types mirror server/src/openduet/cockpit/reminders.ts. Writes are body-less POSTs with a query string. */

export type Repeat = "none" | "daily" | "weekly";

export type ReminderItem = {
  id: string;
  kind: "user" | "auto";
  text: string;
  project: string;
  link: string | null;
  due: number;
  repeat: Repeat;
  state: "due" | "upcoming";
  since?: number;
};

export type RemindersResponse = {
  items: ReminderItem[];
  dueCount: number;
  notifications: { enabled: boolean; quietNow: boolean; lastSentAt: number | null };
  configError: string | null;
  storeError: string | null;
};

export const remindersKeys = { all: ["cockpit", "reminders"] as const };

export const remindersQueryOptions = () =>
  queryOptions({
    queryKey: remindersKeys.all,
    queryFn: ({ signal }): Promise<RemindersResponse> => read("/api/cockpit/reminders", signal),
    refetchInterval: 30_000,
    retry: false,
  });

/** The query string of an add: every value percent-encoded, so & = and unicode in the text survive. */
export function addQuery(input: { text: string; due: number; project: string; repeat: Repeat }): string {
  const e = encodeURIComponent;
  return `?text=${e(input.text.trim())}&due=${Math.floor(input.due)}&project=${e(input.project)}&repeat=${e(input.repeat)}`;
}

export const snoozeQuery = (until: number): string => `?until=${Math.floor(until)}`;

/** A `datetime-local` value ("2026-11-02T09:30") as epoch seconds in local time; null when empty or unreadable. */
export function dueFromLocal(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  return Math.floor(new Date(y, mo - 1, d, h, mi).getTime() / 1000);
}

const result = (r: { ok: boolean; error: string | null }) => ({ ok: r.ok, message: r.error });

export async function addReminder(input: { text: string; due: number; project: string; repeat: Repeat }) {
  return result(await cockpitPost(`/api/cockpit/reminders${addQuery(input)}`));
}

export async function actOnReminder(id: string, action: "done" | "snooze" | "delete", until?: number) {
  const q = action === "snooze" && until !== undefined ? snoozeQuery(until) : "";
  return result(await cockpitPost(`/api/cockpit/reminders/${encodeURIComponent(id)}/${action}${q}`));
}

export async function testNotification() {
  const r = await cockpitPost("/api/cockpit/notifications/test");
  return { ok: r.ok, message: r.status === 429 ? "One test a minute." : r.error };
}
