/** Wall-clock time in Europe/Paris, where Wassim lives, without a date library. */

const TIME_ZONE = "Europe/Paris";

const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export type ParisParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function parisParts(date: Date): ParisParts {
  const part = (type: string) =>
    Number(formatter.formatToParts(date).find((p) => p.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function offsetMs(date: Date): number {
  const p = parisParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(date.getTime() / 60000) * 60000;
}

/** The instant at which Paris clocks show this date and time. Day overflow (day 0, day 32) rolls. */
export function parisDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wall - offsetMs(new Date(wall));
  instant = wall - offsetMs(new Date(instant));
  return new Date(instant);
}

/** Same Paris day as `date`, shifted by `days`, at `hour`:`minute` Paris time. */
export function parisDayAt(date: Date, days: number, hour: number, minute = 0): Date {
  const p = parisParts(date);
  return parisDate(p.year, p.month, p.day + days, hour, minute);
}
