import { parseMaster, type CvMaster } from "../job-offers/cv-schema";
import { askModel, OFFER_CALL_TIMEOUT_MS } from "../job-offers/pipeline";
import type { Complete } from "../triage";
import {
  buildConceptPrompt,
  buildOfferConceptPrompt,
  buildPitch,
  buildStoryPrompt,
  type OfferText,
  parseConcepts,
  parseStories,
} from "./cards";
import type { NewRevisionCard } from "./store";

/** Background fill of the revision deck (gap filling, single-flight per owner) and the per-offer inline call. */

export const MIN_CONCEPTS_PER_GROUP = 4;

export type CardRow = { kind: string; topic: string; skillGroupId?: string | null; bulletIds?: string[] | null };

/** The slice of the revision store the generator uses. */
export interface RevisionSink {
  insertCards(owner: string, cards: NewRevisionCard[]): Promise<unknown>;
  topicsFor(owner: string, scope: { skillGroupId?: string; offerId?: string }): Promise<string[]>;
  listByOffer(owner: string, offerId: string): Promise<CardRow[]>;
  list(owner: string, opts: { kind?: "concept" | "story" | "pitch"; limit?: number }): Promise<CardRow[]>;
  countDue(owner: string, now: Date): Promise<{ dueToday: number }>;
}

export type MasterRow = { content: unknown; contentHash: string };

export class RevisionError extends Error {
  constructor(readonly code: "no_master") {
    super(code);
    this.name = "RevisionError";
  }
}

export type RevisionStatus = {
  running: boolean;
  lastError: string | null;
  counts: { concept: number; story: number; pitch: number; due: number };
};

export function createRevisionGenerator(deps: {
  store: RevisionSink;
  complete: Complete;
  getMaster: (owner: string) => Promise<MasterRow | null>;
  timeoutMs?: number;
  now?: () => Date;
}) {
  const timeout = deps.timeoutMs ?? OFFER_CALL_TIMEOUT_MS;
  const running = new Map<string, Promise<void>>();
  const lastErrors = new Map<string, string>();
  const now = deps.now ?? (() => new Date());

  async function load(owner: string): Promise<{ master: CvMaster; hash: string } | null> {
    const row = await deps.getMaster(owner);
    return row ? { master: parseMaster(row.content), hash: row.contentHash } : null;
  }

  async function fill(owner: string): Promise<void> {
    const loaded = await load(owner);
    if (!loaded) throw new RevisionError("no_master");
    const { master, hash } = loaded;
    const errors: string[] = [];
    const attempt = async (work: () => Promise<void>) => {
      try {
        await work();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    };

    for (const group of master.skills.slice(0, 8)) {
      await attempt(async () => {
        const topics = await deps.store.topicsFor(owner, { skillGroupId: group.id });
        if (topics.length >= MIN_CONCEPTS_PER_GROUP) return;
        const answer = await askModel(deps.complete, buildConceptPrompt(master, group, topics), timeout);
        await deps.store.insertCards(owner, parseConcepts(answer, { masterHash: hash, skillGroupId: group.id, max: 5 }));
      });
    }

    await attempt(async () => {
      const stories = await deps.store.list(owner, { kind: "story", limit: 100 });
      if (stories.length > 0) return;
      const answer = await askModel(deps.complete, buildStoryPrompt(master, []), timeout);
      await deps.store.insertCards(owner, parseStories(answer, master, hash));
    });

    await attempt(() => Promise.resolve(deps.store.insertCards(owner, [buildPitch(master, hash)])).then(() => undefined));

    if (errors.length) throw new Error(errors[0]);
  }

  return {
    /** Starts the background fill. One run per owner at a time. */
    start(owner: string): "started" | "in_progress" {
      if (running.has(owner)) return "in_progress";
      lastErrors.delete(owner);
      const job = fill(owner)
        .catch((error) => {
          lastErrors.set(owner, error instanceof Error ? error.message : String(error));
        })
        .finally(() => running.delete(owner));
      running.set(owner, job);
      return "started";
    },

    /** Resolves when the owner's run (if any) has ended; for tests and shutdown. */
    async idle(owner: string): Promise<void> {
      await running.get(owner);
    },

    async status(owner: string): Promise<RevisionStatus> {
      const [concepts, stories, pitches, due] = await Promise.all([
        deps.store.list(owner, { kind: "concept", limit: 100 }),
        deps.store.list(owner, { kind: "story", limit: 100 }),
        deps.store.list(owner, { kind: "pitch", limit: 100 }),
        deps.store.countDue(owner, now()).then((c) => c.dueToday),
      ]);
      return {
        running: running.has(owner),
        lastError: lastErrors.get(owner) ?? null,
        counts: { concept: concepts.length, story: stories.length, pitch: pitches.length, due },
      };
    },

    /** One inline call: up to 8 concept cards for an offer. Existing ones come back unless `regenerate`. */
    async generateForOffer(owner: string, offer: OfferText & { id: string }, opts: { regenerate?: boolean } = {}) {
      const existing = await deps.store.listByOffer(owner, offer.id);
      if (existing.length > 0 && !opts.regenerate) return existing;
      const loaded = await load(owner);
      if (!loaded) throw new RevisionError("no_master");
      const topics = await deps.store.topicsFor(owner, { offerId: offer.id });
      const answer = await askModel(deps.complete, buildOfferConceptPrompt(loaded.master, offer, topics, 8), timeout);
      await deps.store.insertCards(owner, parseConcepts(answer, { masterHash: loaded.hash, offerId: offer.id, max: 8 }));
      return deps.store.listByOffer(owner, offer.id);
    },
  };
}

export type RevisionGenerator = ReturnType<typeof createRevisionGenerator>;
