/** Which mails are job-offer alerts from a freelance platform. Pure. */

export type Platform = "malt" | "free-work" | "collective";

const DOMAINS: Record<Platform, string[]> = {
  malt: ["malt.fr", "malt.com"],
  "free-work": ["free-work.com"],
  collective: ["collective.work"],
};

const OFFER_SUBJECT =
  /alerte|nouvelles? (offres?|missions?|projets?)|offres? pour vous|(missions?|projets?) qui|proposition de projet|nouveau projet|new project|opportunit|sélection|correspond/i;
const CONVERSATION = /candidature|vous a (envoyé|écrit)|message de|a répondu|entretien/i;

export const PLATFORM_DOMAINS = DOMAINS;

function senderDomain(from: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  return (address.split("@").pop() ?? "").trim().toLowerCase();
}

/** The platform a sender belongs to, subdomains included, null for anyone else. */
export function platformOf(from: string): Platform | null {
  const domain = senderDomain(from);
  for (const [platform, domains] of Object.entries(DOMAINS) as [Platform, string[]][])
    if (domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return platform;
  return null;
}

/** A platform's alert mail with offers in it, not a conversation with a client. */
export function isOfferSource(mail: { from: string; subject: string; snippet?: string; body?: string | null }): boolean {
  if (!platformOf(mail.from)) return false;
  if (!OFFER_SUBJECT.test(mail.subject)) return false;
  return !CONVERSATION.test(`${mail.subject}\n${mail.snippet ?? ""}\n${mail.body ?? ""}`);
}
