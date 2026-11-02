import { describe, expect, it } from "bun:test";
import { dedupKey } from "../src/openduet/revision/cards";
import {
  buildDeepPrompt,
  checkNumbers,
  deepBullets,
  deepDetailsSchema,
  deepKeyOf,
  parseDeepCards,
  referenceOf,
} from "../src/openduet/revision/deep-cards";
import { cvMasterFixture as master } from "./fixtures/cv-master";

const details = (over: Record<string, unknown> = {}) => ({
  star: { situation: "Une plateforme de facturation.", task: "Exposer les données.", action: "J'ai conçu l'API.", result: "Une API stable." },
  underTheHood: "Les routes valident l'entrée puis lisent PostgreSQL.",
  architecture: ["Client → API : requêtes REST", "API → PostgreSQL : lecture", "API → Client : JSON"],
  traps: [
    { question: "Comment versionner l'API ?", answer: "Par préfixe d'URL." },
    { question: "Et la pagination ?", answer: "Curseur." },
    { question: "Les erreurs ?", answer: "Codes HTTP." },
  ],
  lab: ["Créer une table", "Écrire une route", "La tester"],
  value: "Livraison plus rapide pour le client.",
  rescue: ["contexte", "action", "résultat"],
  ...over,
});
const pick = (bulletId: string, d = details()) => ({ bulletId, ...d });
const answer = (...cards: unknown[]) => JSON.stringify({ cards });
const ids = ["acme-api", "acme-ci", "acme-perf", "globex-etl", "globex-k8s"];
const parse = (a: string, allowed = ids) => parseDeepCards(a, master, "h1", allowed);

describe("deep bullets", () => {
  it("lists every bullet, most recent experience first (open end first)", () => {
    expect(deepBullets(master).map((b) => b.id)).toEqual(ids);
  });
  it("sorts by end then start, descending, with no end counting as latest", () => {
    const m = structuredClone(master);
    m.experiences[0].end = "2021-01";
    m.experiences[0].start = "2019-01";
    // globex ends 2022-12 > acme 2021-01
    expect(deepBullets(m)[0].id).toBe("globex-etl");
  });
  it("the key hashes the id and the normalized text: an edited bullet gets a new key", () => {
    const [first] = deepBullets(master);
    expect(deepKeyOf(first)).toBe(dedupKey("deep", { bulletIds: [first.id], bulletText: first.text }));
    expect(deepKeyOf({ ...first, text: `${first.text} Et plus.` })).not.toBe(deepKeyOf(first));
    expect(deepKeyOf({ ...first, text: ` ${first.text.toUpperCase()} ` })).toBe(deepKeyOf(first));
    expect(dedupKey("deep", { bulletIds: ["a"], bulletText: "x" })).not.toBe(dedupKey("story", { bulletIds: ["a"] }));
  });
});

describe("deep prompt", () => {
  it("lists the bullets with ids, forbids new facts, asks for JSON", () => {
    const p = buildDeepPrompt(master, deepBullets(master).slice(0, 2));
    expect(p).toContain("[acme-api]");
    expect(p).toContain("[acme-ci]");
    expect(p).not.toContain("[acme-perf]");
    expect(p).toContain("Conception d'une API REST");
    expect(p).toContain("PostgreSQL"); // the environment line
    expect(p).toContain("bulletId");
    expect(p.toLowerCase()).toContain("n'invente");
  });
});

describe("parseDeepCards", () => {
  it("builds a deep card: question, answer by code, one bullet, details", () => {
    const { cards, rejected } = parse(answer(pick("acme-api")));
    expect(rejected).toEqual([]);
    expect(cards).toHaveLength(1);
    const c = cards[0];
    expect(c.kind).toBe("deep");
    expect(c.question).toBe("Expliquez : Conception d'une API REST en TypeScript et PostgreSQL.");
    expect(c.answer).toContain("- Conception d'une API REST en TypeScript et PostgreSQL.");
    expect(c.answer).toContain("Développeur Full-Stack — Acme (2023-01–en cours)");
    expect(c.bulletIds).toEqual(["acme-api"]);
    expect(c.masterHash).toBe("h1");
    expect(c.details).toEqual(details());
    expect(c.dedupKey).toBe(deepKeyOf(deepBullets(master)[0]));
    expect(c.topic.length).toBeLessThanOrEqual(60);
  });

  it("drops unknown or not-requested bullet ids and duplicates, keeps the others", () => {
    const { cards } = parse(answer(pick("nope"), pick("acme-ci"), pick("acme-ci"), pick("acme-api")), ["acme-api"]);
    expect(cards.map((c) => c.bulletIds[0])).toEqual(["acme-api"]);
  });

  it("drops a card citing several bullets", () => {
    const { cards } = parse(answer({ ...pick("acme-api"), bulletId: undefined, bulletIds: ["acme-api", "acme-ci"] }));
    expect(cards).toEqual([]);
  });

  it("drops a card that breaks the limits and keeps the good one", () => {
    const long = Array(61).fill("mot").join(" ");
    const bad = [
      pick("acme-api", details({ star: { situation: long, task: "t", action: "a", result: "r" } })),
      pick("acme-ci", details({ architecture: ["a", "b"] })),
      pick("acme-perf", details({ traps: [{ question: "q", answer: "a" }] })),
      pick("globex-etl", details({ rescue: ["a", "b", "x".repeat(31)] })),
    ];
    const { cards } = parse(answer(...bad, pick("globex-k8s")));
    expect(cards.map((c) => c.bulletIds[0])).toEqual(["globex-k8s"]);
  });

  it("caps: traps 3-4 answers 50 words, underTheHood 120 words, architecture lines 120 chars", () => {
    expect(deepDetailsSchema.safeParse(details()).success).toBe(true);
    const w = (n: number) => Array(n).fill("mot").join(" ");
    expect(deepDetailsSchema.safeParse(details({ underTheHood: w(121) })).success).toBe(false);
    expect(deepDetailsSchema.safeParse(details({ underTheHood: w(120) })).success).toBe(true);
    expect(
      deepDetailsSchema.safeParse(details({ traps: Array(5).fill({ question: "q", answer: "a" }) })).success,
    ).toBe(false);
    expect(
      deepDetailsSchema.safeParse(details({ traps: Array(3).fill({ question: "q", answer: w(51) }) })).success,
    ).toBe(false);
    expect(
      deepDetailsSchema.safeParse(details({ architecture: ["a", "b", "x".repeat(121)] })).success,
    ).toBe(false);
    expect(deepDetailsSchema.safeParse({ ...details(), extra: 1 }).success).toBe(false);
  });

  it("drops a card with an invented number and reports its bullet as rejected", () => {
    const invented = details({ star: { situation: "s", task: "t", action: "a", result: "Latence divisée par 3." } });
    const { cards, rejected } = parse(answer(pick("acme-perf", invented), pick("acme-api")));
    expect(cards.map((c) => c.bulletIds[0])).toEqual(["acme-api"]);
    expect(rejected).toEqual(["acme-perf"]);
  });

  it("a number in value or rescue is checked too; one from the context/environment/dates is fine", () => {
    const inValue = details({ value: "Économie de 40 % de coûts." });
    const inRescue = details({ rescue: ["a", "b", "100 req/s"] });
    const fine = details({ value: "Une équipe de 8 personnes servie depuis 2023.", rescue: ["8", "b", "c"] });
    const { cards, rejected } = parse(answer(pick("acme-api", inValue), pick("acme-ci", inRescue), pick("acme-perf", fine)));
    expect(cards.map((c) => c.bulletIds[0])).toEqual(["acme-perf"]);
    expect(rejected).toEqual(["acme-api", "acme-ci"]);
  });

  it("numbers in underTheHood, architecture or traps are not guarded", () => {
    const d = details({ underTheHood: "HTTP 404 et 500, port 5432." });
    expect(parse(answer(pick("acme-api", d))).cards).toHaveLength(1);
  });

  it("an unreadable answer throws RevisionAnswerError", () => {
    expect(() => parse("pas du json")).toThrow();
  });
});

describe("checkNumbers", () => {
  it("compares numbers with , normalised to .", () => {
    expect(checkNumbers("réduit de 2,5 s", "2.5 s")).toBe(true);
    expect(checkNumbers("réduit de 2.5 s", "2,5 s")).toBe(true);
    expect(checkNumbers("réduit de 3 s", "2,5 s")).toBe(false);
    expect(checkNumbers("aucun chiffre", "x")).toBe(true);
  });
});

describe("referenceOf", () => {
  it("is the card answer plus its details as text", () => {
    const { cards } = parse(answer(pick("acme-api")));
    const ref = referenceOf({ answer: cards[0].answer, details: cards[0].details ?? null });
    expect(ref).toContain("Conception d'une API REST");
    expect(ref).toContain("Par préfixe d'URL.");
    expect(ref).toContain("Client → API");
  });
});
