/** The cheap rules that drop an offer before any model sees it. Pure. */

export const MIN_DAY_RATE = 500;
const HOURS_PER_DAY = 7;

export type FilterReason = "salaried" | "low_tjm" | "outside_idf";
export type FilterInput = {
  contract: "freelance" | "salaried" | "unknown";
  rateUnit: "day" | "hour" | "year" | "unknown";
  tjmMin: number | null;
  tjmMax: number | null;
  remote: "full" | "hybrid" | "onsite" | "unknown";
  location: string | null;
};
export type FilterResult = { status: "new" | "filtered"; filterReason: FilterReason | null; tjmUnknown: boolean };

const IDF_WORDS = [
  "paris", "ile de france", "idf", "la defense", "boulogne", "issy", "nanterre", "courbevoie", "puteaux",
  "levallois", "saint denis", "montreuil", "massy", "saclay", "versailles", "velizy", "creteil",
  "neuilly", "clichy", "rueil", "malakoff", "montrouge", "vincennes", "saint ouen", "gennevilliers", "palaiseau",
];
const IDF_POSTCODE = /\b(75|77|78|91|92|93|94|95)\d{3}\b/;

/** Whether a place is in Île-de-France. */
export function isIdf(location: string): boolean {
  const text = location
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[-'’]/g, " ");
  if (IDF_POSTCODE.test(text)) return true;
  return IDF_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(text));
}

/** First matching rule wins. A rate or a place that is unknown never drops an offer. */
export function hardFilter(offer: FilterInput): FilterResult {
  const filtered = (filterReason: FilterReason, tjmUnknown = false): FilterResult => ({ status: "filtered", filterReason, tjmUnknown });
  if (offer.contract === "salaried" || offer.rateUnit === "year") return filtered("salaried");

  const amount = offer.tjmMax ?? offer.tjmMin;
  let day: number | null = null;
  if (amount !== null) {
    if (offer.rateUnit === "day") day = amount;
    else if (offer.rateUnit === "hour") day = amount * HOURS_PER_DAY;
  }
  const tjmUnknown = day === null;
  if (day !== null && day < MIN_DAY_RATE) return filtered("low_tjm");

  if ((offer.remote === "onsite" || offer.remote === "hybrid") && offer.location?.trim() && !isIdf(offer.location))
    return filtered("outside_idf", tjmUnknown);
  return { status: "new", filterReason: null, tjmUnknown };
}
