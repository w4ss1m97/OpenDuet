import type { OfferStatus } from "../../db/schema/openduet-job-offers";

/** A score at or above this is shown in the brief; below it the offer stays `scored`. */
export const SHOW_THRESHOLD = 75;
/** A source or a score that failed this many times is left alone. */
export const MAX_SOURCE_ATTEMPTS = 3;
export const MAX_SCORE_ATTEMPTS = 3;

const NEXT: Record<OfferStatus, readonly OfferStatus[]> = {
  new: ["shown", "scored", "dismissed", "applied"],
  scored: ["dismissed", "applied"],
  shown: ["dismissed", "applied"],
  filtered: ["dismissed", "applied"],
  dismissed: ["applied"],
  applied: [],
};

/**
 * Where an offer may go from `from`. An offer is inserted as `new` or `filtered`; scoring moves `new` to
 * `shown` or `scored`; Wassim may dismiss or apply from any live state; `applied` is terminal.
 */
export function canTransition(from: OfferStatus, to: OfferStatus): boolean {
  return NEXT[from].includes(to);
}
