import type { MissionSignal } from "./stages";

/** Reads what a mail means for a mission, from its words only. No LLM, no database. */

type Mail = { from: string; subject: string; snippet: string; body?: string };

const REJECTION =
  /regret|malheureusement|ne donnons pas suite|pas été retenu|n'a pas été retenue|ne sera pas retenu|candidature n'a pas|unfortunately|not (?:be )?moving forward|decided not to proceed/i;
const OFFER =
  /proposition de mission|offre de mission ferme|souhaitons vous proposer|promesse d'embauche|bon pour accord|proposition commerciale|contrat à vous proposer|offer letter|pleased to offer/i;
const INVITE =
  /entretien|interview|rendez-vous|\brdv\b|visio|disponible|disponibilités|échange téléphonique|appel/i;
/** A platform telling a person about openings, not about their own application. */
const JOB_ALERT =
  /alerte|nouvelles? offres?|offres? (?:d'emploi )?pour vous|job alerts?|recommandations? d'emploi|jobs? you may like|offres? qui correspondent/i;

const PLATFORM_DOMAINS = ["malt.fr", "malt.com", "free-work.com", "collective.work", "linkedin.com"];
const LEGAL_SUFFIXES = /\b(?:sas|sasu|sarl|eurl|sa|inc|ltd|gmbh)\b/g;

function domainOf(from: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  return address.split("@")[1]?.trim().toLowerCase() ?? "";
}

function isPlatform(from: string): boolean {
  const domain = domainOf(from);
  return PLATFORM_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** rejection > offer > invite > reply. Null for a job alert, which never says anything about a mission. */
export function missionSignal(mail: Mail): MissionSignal | null {
  const text = `${mail.subject}\n${mail.snippet}\n${mail.body ?? ""}`;
  if (REJECTION.test(text)) return "rejection";
  if (isPlatform(mail.from) && JOB_ALERT.test(mail.subject)) return null;
  if (JOB_ALERT.test(mail.subject) && !/candidature/i.test(text)) return null;
  if (OFFER.test(text)) return "offer";
  if (INVITE.test(text)) return "invite";
  return "reply";
}

/** "Société Générale" and "societe generale SAS" are the same company. Empty stays empty. */
export function companyKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(LEGAL_SUFFIXES, "")
    .replace(/[^a-z0-9]/g, "");
}

/** The lowercase address of the person who wrote, null for a platform or a no-reply sender. */
export function contactOf(from: string): string | null {
  const address = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  if (isPlatform(address)) return null;
  if (/^(?:no-?reply|donotreply|do-not-reply|notifications?|mailer-daemon)@/.test(address)) return null;
  return address;
}
