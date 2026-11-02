import { z } from "zod";
import type { CvMaster } from "../job-offers/cv-schema";
import type { DeepDetails } from "../../db/schema/openduet-revision";
import { buildStoryAnswer, dedupKey, jsonObject, listOf } from "./cards";
import type { NewRevisionCard } from "./store";

/** Deep cards: one per CV bullet. Code writes question and answer (selection-only); the model writes the coaching `details`. */

export type DeepBullet = {
  id: string;
  text: string;
  experience: { role: string; company: string; start: string; end: string | null; context?: string; environment: string[] };
};

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;
const words = (max: number) =>
  z.string().trim().min(1).refine((s) => wordCount(s) <= max, `max ${max} words`);
const line = (max: number) => z.string().trim().min(1).max(max);

export const deepDetailsSchema = z
  .object({
    star: z
      .object({ situation: words(60), task: words(60), action: words(60), result: words(60) })
      .strict(),
    underTheHood: words(120),
    architecture: z.array(line(120)).min(3).max(8),
    traps: z
      .array(z.object({ question: line(200), answer: words(50) }).strict())
      .min(3)
      .max(4),
    lab: z.array(line(160)).min(3).max(6),
    value: words(40),
    rescue: z.array(line(30)).min(3).max(5),
  })
  .strict() satisfies z.ZodType<DeepDetails>;

/** Every bullet of the master, most recent experience first (no end date = ongoing = latest), then latest start. */
export function deepBullets(master: CvMaster): DeepBullet[] {
  const experiences = [...master.experiences].sort(
    (a, b) => (b.end ?? "9999-12").localeCompare(a.end ?? "9999-12") || b.start.localeCompare(a.start),
  );
  return experiences.flatMap((e) =>
    e.bullets.map((b) => ({
      id: b.id,
      text: b.text,
      experience: { role: e.role, company: e.company, start: e.start, end: e.end, context: e.context, environment: e.environment },
    })),
  );
}

export const deepKeyOf = (b: Pick<DeepBullet, "id" | "text">) =>
  dedupKey("deep", { bulletIds: [b.id], bulletText: b.text });

const NUMBER = /\d+(?:[.,]\d+)?/g;
const numbersOf = (text: string) => (text.match(NUMBER) ?? []).map((n) => n.replace(",", "."));

/** True when every number in `text` also appears in `source` (comma and dot decimals alike). */
export function checkNumbers(text: string, source: string): boolean {
  const known = new Set(numbersOf(source));
  return numbersOf(text).every((n) => known.has(n));
}

const sourceOf = (b: DeepBullet) =>
  [
    b.text,
    b.experience.role,
    b.experience.company,
    b.experience.start,
    b.experience.end ?? "",
    b.experience.context ?? "",
    ...b.experience.environment,
  ].join("\n");

/** One call for up to 2 bullets, listed with their ids, experience header and environment line. */
export function buildDeepPrompt(master: CvMaster, bullets: DeepBullet[]): string {
  const items = bullets.map((b) =>
    [
      `[${b.id}] ${b.text}`,
      `  Poste : ${b.experience.role} — ${b.experience.company} (${b.experience.start}–${b.experience.end ?? "en cours"})`,
      b.experience.context ? `  Contexte : ${b.experience.context}` : "",
      b.experience.environment.length ? `  Environnement : ${b.experience.environment.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    `Tu prépares un freelance (${master.titles[0]}) à défendre chaque ligne de son CV en entretien technique. Pour chacune des réalisations ci-dessous, écris une fiche de coaching en français.`,
    'Réponds par un seul objet JSON et rien d\'autre : {"cards": [{"bulletId": "id", "star": {"situation": "...", "task": "...", "action": "...", "result": "..."} (60 mots max chacun), "underTheHood": "comment la technologie fonctionne (120 mots max)", "architecture": ["A → B : pourquoi"] (3 à 8 lignes, 120 caractères max), "traps": [{"question": "question de relance (200 caractères max)", "answer": "... (50 mots max)"}] (3 à 4), "lab": ["étape d\'un exercice pratique"] (3 à 6 étapes, 160 caractères max), "value": "pourquoi cela comptait pour le client : coût, risque, vitesse (40 mots max)", "rescue": ["mot-clé"] (3 à 5, 30 caractères max)}]}. Une fiche par identifiant, utilise uniquement les identifiants ci-dessous.',
    "N'invente aucun fait sur le candidat : reprends seulement ce que la réalisation, le poste, le contexte et l'environnement disent. Les chiffres de star.result, value et rescue doivent figurer dans la réalisation ; sinon parle sans chiffre.",
    "",
    ...items,
  ].join("\n");
}

export type DeepParse = { cards: NewRevisionCard[]; rejected: string[] };

/**
 * Reads deep cards; each is checked alone and a bad one is dropped. Only ids in `allowed` count, one card per
 * bullet. `rejected` lists the bullets dropped for a number the CV does not contain.
 */
export function parseDeepCards(answer: string, master: CvMaster, masterHash: string, allowed: string[]): DeepParse {
  const bullets = new Map(deepBullets(master).map((b) => [b.id, b]));
  const cards: NewRevisionCard[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of listOf(jsonObject(answer), "cards")) {
    if (!raw || typeof raw !== "object") continue;
    const { bulletId, ...rest } = raw as Record<string, unknown>;
    if (typeof bulletId !== "string" || !allowed.includes(bulletId) || seen.has(bulletId)) continue;
    const bullet = bullets.get(bulletId);
    if (!bullet) continue;
    const parsed = deepDetailsSchema.safeParse(rest);
    if (!parsed.success) continue;
    seen.add(bulletId);
    const d = parsed.data;
    const guarded = [d.star.situation, d.star.task, d.star.action, d.star.result, d.value, ...d.rescue].join("\n");
    if (!checkNumbers(guarded, sourceOf(bullet))) {
      rejected.push(bulletId);
      continue;
    }
    cards.push({
      kind: "deep",
      topic: bullet.text.slice(0, 60),
      skillGroupId: null,
      offerId: null,
      question: `Expliquez : ${bullet.text}`,
      answer: buildStoryAnswer(master, [bulletId]),
      keyPoints: [],
      bulletIds: [bulletId],
      masterHash,
      dedupKey: deepKeyOf(bullet),
      details: d,
    });
  }
  return { cards, rejected };
}

/** The text a mock answer is graded against: the card answer, then every part of its details. */
export function referenceOf(card: { answer: string; details: DeepDetails | null }): string {
  const d = card.details;
  if (!d) return card.answer;
  return [
    card.answer,
    `Situation : ${d.star.situation}`,
    `Tâche : ${d.star.task}`,
    `Action : ${d.star.action}`,
    `Résultat : ${d.star.result}`,
    `Sous le capot : ${d.underTheHood}`,
    ...d.architecture,
    ...d.traps.map((t) => `${t.question} ${t.answer}`),
    `Valeur : ${d.value}`,
  ].join("\n");
}
