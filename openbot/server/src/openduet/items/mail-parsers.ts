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

/** The senders Duet reads for items. The caller adds `newer_than:`. */
export const MAIL_QUERY =
  "from:(malt.fr OR malt.com OR free-work.com OR collective.work OR linkedin.com OR antai.gouv.fr) OR subject:(facture OR échéance OR prélèvement OR \"à payer\" OR invoice)";

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

/** "1 234,56 €", "45€", "45,00 EUR" → number. Undefined when no amount is written. */
export function parseAmount(text: string): number | undefined {
  const match = text.match(
    /(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[,.](\d{2}))?\s?(?:€|EUR\b)/,
  );
  if (!match?.[1]) return undefined;
  const units = match[1].replace(/[   ]/g, "");
  return Number(`${units}.${match[2] ?? "00"}`);
}

type FoundDate = { at: Date; allDay: boolean };

/** The first date written in French in `text`; a day without a year is the next one after `sent`. */
export function parseFrenchDate(text: string, sent: Date): FoundDate | undefined {
  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  const named = text.match(
    new RegExp(`\\b(\\d{1,2})(?:er)? (${MONTHS.join("|")})(?: (\\d{4}))?`, "i"),
  );
  let day: number;
  let month: number;
  let year: number | undefined;
  let rest: string;
  if (numeric && (!named || (numeric.index ?? 0) <= (named.index ?? 0))) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    year = numeric[3] ? Number(numeric[3]) : undefined;
    rest = text.slice((numeric.index ?? 0) + numeric[0].length);
  } else if (named) {
    day = Number(named[1]);
    month = MONTHS.indexOf((named[2] ?? "").toLowerCase()) + 1;
    year = named[3] ? Number(named[3]) : undefined;
    rest = text.slice((named.index ?? 0) + named[0].length);
  } else return undefined;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  const time = rest.match(/^\s*(?:à|a|,)?\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})?/i);
  const hour = time ? Number(time[1]) : 0;
  const minute = time?.[2] ? Number(time[2]) : 0;
  const sentParts = parisParts(sent);
  let at = parisDate(year ?? sentParts.year, month, day, hour, minute);
  if (year === undefined && at.getTime() < parisDate(sentParts.year, sentParts.month, sentParts.day).getTime())
    at = parisDate(sentParts.year + 1, month, day, hour, minute);
  return { at, allDay: !time };
}

function candidate(
  m: MailMessage,
  kind: ItemKind,
  channelId: string,
  why: string,
  text: string,
): ItemCandidate {
  const found = parseFrenchDate(text, new Date(m.date));
  const amount = kind === "bill" || kind === "fine" ? parseAmount(text) : undefined;
  return {
    kind,
    title: m.subject.trim() || why,
    why,
    dueAt: found?.at,
    allDay: found?.allDay,
    amount,
    channelId,
    sourceApp: "gmail",
    sourceLink: `https://mail.google.com/mail/u/0/#all/${m.id}`,
    sourceHash: `gmail:${m.id}`,
    dateExplicit: found !== undefined,
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
    const interview = INTERVIEW.test(text) && parseFrenchDate(text, new Date(m.date));
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
