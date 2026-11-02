import { parisDate, parisParts } from "../items/paris-time";

/** Paris weeks, Monday 00:00 to the next Monday 00:00. Pure, built on the Paris clock helpers. */

export type ParisWeek = {
  start: Date;
  end: Date;
  /** The Monday, YYYY-MM-DD. */
  label: string;
};

/** 1 = Monday .. 7 = Sunday, on the Paris calendar date. */
export function parisWeekday(date: Date): number {
  const p = parisParts(date);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The Paris week that holds `date`. Counted on calendar days, so a DST change cannot shift it. */
export function parisWeekOf(date: Date): ParisWeek {
  const p = parisParts(date);
  const monday = p.day - (parisWeekday(date) - 1);
  const start = parisDate(p.year, p.month, monday);
  const end = parisDate(p.year, p.month, monday + 7);
  const s = parisParts(start);
  return { start, end, label: `${s.year}-${pad(s.month)}-${pad(s.day)}` };
}

/** `YYYY-MM-DD`, a real calendar date, normalised to its Monday. Null otherwise. */
export function parseWeekParam(value: string): ParisWeek | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return parisWeekOf(parisDate(y, m, d, 12));
}

/** On a Monday the last completed week, otherwise the week so far. */
export function defaultWeek(now: Date): ParisWeek {
  return parisWeekday(now) === 1 ? parisWeekOf(new Date(now.getTime() - 86_400_000)) : parisWeekOf(now);
}

/** `n` weeks ending with `week`, oldest first, stepped by calendar days. */
export function previousWeeks(week: ParisWeek, n: number): ParisWeek[] {
  const p = parisParts(week.start);
  return Array.from({ length: n }, (_, i) => parisWeekOf(parisDate(p.year, p.month, p.day - 7 * (n - 1 - i), 12)));
}
