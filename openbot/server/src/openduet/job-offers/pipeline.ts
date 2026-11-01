import type { Complete } from "../triage";
import { buildExtractPrompt, dedupKey, type ExtractedOffer, type OfferOrigin, parseExtraction } from "./extract";
import { hardFilter } from "./filter";
import { profileHash } from "./profile";
import { buildScorePrompt, parseScore } from "./score";
import type { OfferStore } from "./store";

/** The steps shared by the intake sweep and the paste route: ask the model, read offers, score an offer. */

export const OFFER_CALL_TIMEOUT_MS = 60_000;
const TIMED_OUT = "Source illisible : pas de réponse à temps.";

/** Rejects when `work` has not settled in time. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TIMED_OUT)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** One LLM call, bounded; the call is aborted when the deadline passes. */
export async function askModel(complete: Complete, prompt: string, timeoutMs = OFFER_CALL_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  return withDeadline(complete(prompt, controller.signal), timeoutMs).catch((error) => {
    controller.abort();
    throw error;
  });
}

/**
 * Reads the offers out of a mail or a pasted text and stores them (hard filter and dedup key applied).
 * `max` keeps only the first offers. Returns how many were found and the stored rows.
 */
export async function extractAndStore(
  store: OfferStore,
  owner: string,
  sourceId: string,
  platform: OfferOrigin,
  input: { subject: string; body: string; max?: number; url?: string | null },
  ask: (prompt: string) => Promise<string>,
): Promise<{ found: number; stored: { id: string; dedupKey: string; created: boolean }[] }> {
  const all = parseExtraction(await ask(buildExtractPrompt({ platform, subject: input.subject, body: input.body })));
  const found = input.max === undefined ? all : all.slice(0, input.max);
  const stored = await store.insertOffers(
    owner,
    sourceId,
    found.map((offer) => ({
      ...offer,
      url: offer.url ?? input.url ?? null,
      platform,
      dedupKey: dedupKey(platform, offer),
      ...hardFilter(offer),
    })),
  );
  return { found: found.length, stored };
}

/**
 * Claims the offer, scores it against the profile and stores the result; a failure is kept as the offer's
 * state and rethrown never: the offer just stays `new`. False when there was nothing to score.
 */
export async function scoreOffer(
  store: OfferStore,
  owner: string,
  id: string,
  profile: string,
  ask: (prompt: string) => Promise<string>,
  onError: (error: unknown) => void,
): Promise<boolean> {
  const claim = await store.claimScore(owner, id);
  if (!claim?.claimedAt) return false;
  try {
    const offer: ExtractedOffer = {
      title: claim.title,
      company: claim.company,
      tjmMin: claim.tjmMin,
      tjmMax: claim.tjmMax,
      rateUnit: claim.rateUnit,
      contract: claim.contract,
      remote: claim.remote,
      location: claim.location,
      durationMonths: claim.durationMonths,
      startAsap: claim.startAsap,
      url: claim.url,
      skills: claim.skills,
      description: claim.description ?? "",
    };
    const score = parseScore(await ask(buildScorePrompt(profile, offer)));
    await store.completeScore(owner, claim.id, claim.claimedAt, { ...score, profileHash: profileHash(profile) });
  } catch (error) {
    onError(error);
    await store.failScore(owner, claim.id, claim.claimedAt, error instanceof Error ? error.name : "UnknownError");
  }
  return true;
}
