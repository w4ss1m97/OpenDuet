import { parisDate, parisParts } from "./paris-time";
import type { ItemCandidate, ItemKind } from "./types";

/** One message as `google-workspace/gmail_search_messages` returns it: metadata and snippet only. */
export type MailMessage = {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  body?: string;
};

/**
 * The searches Duet runs for items, one per sender family, each with its own result cap so a busy
 * LinkedIn week cannot push a bill out. Plain operators only. The caller adds `newer_than:`.
 */
export const MAIL_QUERIES = [
  "from:malt.fr",
  "from:malt.com",
  "from:free-work.com",
  "from:collective.work",
  "from:linkedin.com",
  "from:antai.gouv.fr",
  "subject:facture",
  "subject:échéance",
  "subject:prélèvement",
  "subject:invoice",
];

const MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

const INTERVIEW = /entretien|interview|rendez-vous|\brdv\b|visio/i;
const BILL = /facture|échéance|prélèvement|à payer|invoice/i;
const LINKEDIN_MESSAGE = /message|inmail|sent you|vous a écrit/i;

type Source = { name: string; domains: string[] };
const PLATFORMS: Source[] = [
  { name: "Malt", domains: ["malt.fr", "malt.com"] },
  { name: "Free-Work", domains: ["free-work.com"] },
  { name: "Collective", domains: ["collective.work"] },
  { name: "LinkedIn", domains: ["linkedin.com"] },
];

function senderDomain(from: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  return address.split("@")[1]?.trim().toLowerCase() ?? "";
}

function fromDomain(domain: string, domains: string[]): boolean {
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * "1 234,56 €", "1.234,56 €", "45€", "45,00 EUR" → number. Undefined when no amount is written or
 * when it reads two ways: a negative (a refund) or a single decimal digit ("45,5 €").
 */
export function parseAmount(text: string): number | undefined {
  const match = text.match(
    /(?<![\d.,-])(-?)(\d{1,3}(?:[ .\u00a0\u202f]\d{3})+|\d+)(?:[,.](\d+))?\s?(?:€|EUR\b)/,
  );
  if (!match?.[2] || match[1] === "-") return undefined;
  if (match[3] !== undefined && match[3].length !== 2) return undefined;
  const units = match[2].replace(/[ .\u00a0\u202f]/g, "");
  return Number(`${units}.${match[3] ?? "00"}`);
}

type FoundDate = { at: Date; allDay: boolean; index: number };

/** A day without a year this far back is taken as next year's ("avant le 05/01" sent in December). */
const ROLL_FORWARD_MS = 60 * 24 * 60 * 60 * 1000;

function realDay(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Every real date written in French in `text`, in order; a missing year is read around `sent`. */
export function findFrenchDates(text: string, sent: Date): FoundDate[] {
  const sentParts = parisParts(sent);
  const found: FoundDate[] = [];
  const patterns: [RegExp, (m: RegExpExecArray) => [number, number, number | undefined]][] = [
    [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g, (m) => [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined]],
    [
      new RegExp(`\\b(\\d{1,2})(?:er)? (${MONTHS.join("|")})(?: (\\d{4}))?`, "gi"),
      (m) => [Number(m[1]), MONTHS.indexOf((m[2] ?? "").toLowerCase()) + 1, m[3] ? Number(m[3]) : undefined],
    ],
  ];
  for (const [pattern, read] of patterns) {
    for (const m of text.matchAll(pattern)) {
      const [day, month, year] = read(m as RegExpExecArray);
      const rest = text.slice((m.index ?? 0) + m[0].length);
      const time = rest.match(/^\s*(?:à|a|,)?\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})?/i);
      const hour = time ? Number(time[1]) : 0;
      const minute = time?.[2] ? Number(time[2]) : 0;
      if (month < 1 || month > 12 || hour > 23 || minute > 59) continue;
      let y = year ?? sentParts.year;
      if (!realDay(y, month, day)) continue;
      let at = parisDate(y, month, day, hour, minute);
      if (year === undefined && sent.getTime() - at.getTime() > ROLL_FORWARD_MS) {
        y += 1;
        if (!realDay(y, month, day)) continue;
        at = parisDate(y, month, day, hour, minute);
      }
      found.push({ at, allDay: !time, index: m.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

const DUE_KEYWORD = /avant le|échéance|à payer|au plus tard|date limite/i;

/**
 * The date that matters and whether it was read plainly. A bill or fine takes the first date after
 * its due keyword; otherwise one date is plain, and several different ones are left to the person.
 */
function chooseDate(text: string, sent: Date, due: boolean) {
  const dates = findFrenchDates(text, sent);
  if (dates.length === 0) return { found: undefined, explicit: false };
  if (due) {
    const keyword = text.search(DUE_KEYWORD);
    const after = keyword >= 0 ? dates.find((d) => d.index > keyword) : undefined;
    if (after) return { found: after, explicit: true };
  }
  const distinct = new Set(dates.map((d) => d.at.getTime()));
  return { found: dates[0], explicit: distinct.size === 1 };
}

function sentAt(m: MailMessage): Date {
  const sent = new Date(m.date);
  return Number.isNaN(sent.getTime()) ? new Date() : sent;
}

function candidate(
  m: MailMessage,
  kind: ItemKind,
  channelId: string,
  why: string,
  text: string,
): ItemCandidate {
  const due = kind === "bill" || kind === "fine";
  const { found, explicit } = chooseDate(text, sentAt(m), due);
  return {
    kind,
    title: m.subject.trim() || why,
    why,
    dueAt: found?.at,
    allDay: found?.allDay,
    amount: due ? parseAmount(text) : undefined,
    channelId,
    sourceApp: "gmail",
    sourceLink: `https://mail.google.com/mail/u/0/#all/${m.id}`,
    sourceHash: `gmail:${m.id}`,
    dateExplicit: explicit,
  };
}

/** What Duet keeps from one email, or null when it is not about a mission, a bill or a fine. */
export function parseMail(m: MailMessage): ItemCandidate | null {
  const domain = senderDomain(m.from);
  const text = `${m.subject}\n${m.snippet}\n${m.body ?? ""}`;

  if (fromDomain(domain, ["antai.gouv.fr"]))
    return candidate(m, "fine", "maison", "Amende (ANTAI)", text);

  const platform = PLATFORMS.find((p) => fromDomain(domain, p.domains));
  if (platform) {
    if (platform.name === "LinkedIn" && !LINKEDIN_MESSAGE.test(m.subject)) return null;
    const interview = INTERVIEW.test(text) && findFrenchDates(text, sentAt(m)).length > 0;
    return candidate(
      m,
      interview ? "interview" : "followup",
      "missions",
      `${platform.name} : à suivre`,
      text,
    );
  }

  if (BILL.test(text)) return candidate(m, "bill", "maison", "Facture à payer", text);
  return null;
}
