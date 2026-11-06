import { describe, expect, it } from "bun:test";
import type { NewRevisionCard } from "../src/openduet/revision/store";
import { createRevisionGenerator, type CardRow, type RevisionSink } from "../src/openduet/revision/generate";
import { deepBullets, deepKeyOf } from "../src/openduet/revision/deep-cards";
import type { CvMaster } from "../src/openduet/job-offers/cv-schema";
import { cvMasterFixture } from "./fixtures/cv-master";

function fakeSink() {
  const cards: (NewRevisionCard & { owner: string })[] = [];
  const touched: { owner: string; keys: string[]; hash: string }[] = [];
  const sink: RevisionSink = {
    async insertCards(owner, news) {
      for (const c of news) if (!cards.some((x) => x.owner === owner && x.dedupKey === c.dedupKey)) cards.push({ ...c, owner });
    },
    async topicsFor(owner, s) {
      return cards
        .filter((c) => c.owner === owner && c.kind === "concept" && (s.skillGroupId ? c.skillGroupId === s.skillGroupId : c.offerId === s.offerId))
        .map((c) => c.topic);
    },
    async listByOffer(owner, id): Promise<CardRow[]> {
      return cards.filter((c) => c.owner === owner && c.offerId === id);
    },
    async list(owner, o): Promise<CardRow[]> {
      return cards.filter((c) => c.owner === owner && (!o.kind || c.kind === o.kind));
    },
    async countDue() {
      return { dueToday: 0 };
    },
    async deepKeys(owner) {
      return new Set(cards.filter((c) => c.owner === owner && c.kind === "deep").map((c) => c.dedupKey));
    },
    async touchDeep(owner, keys, hash) {
      touched.push({ owner, keys, hash });
    },
  };
  return { sink, cards, touched };
}

const concepts = (prefix: string, n: number) =>
  JSON.stringify({
    cards: Array.from({ length: n }, (_, i) => ({ topic: `${prefix} ${i}`, question: "Q", answer: "R", keyPoints: ["a", "b"] })),
  });

function setup(complete?: (p: string) => Promise<string>) {
  const { sink, cards } = fakeSink();
  const prompts: string[] = [];
  const fake = async (p: string) => {
    prompts.push(p);
    if (complete) return complete(p);
    if (p.includes("questions comportementales"))
      return JSON.stringify({ stories: [{ question: "Q", theme: "T", bulletIds: ["acme-api"] }] });
    const m = p.match(/groupe de compétences « (.+?) »/);
    if (m) return concepts(m[1], 5);
    return concepts("offre", 9);
  };
  const gen = createRevisionGenerator({
    store: sink,
    complete: fake,
    getMaster: async (o) => (o === "nomaster" ? null : { content: cvMasterFixture, contentHash: "h1" }),
    timeoutMs: 1000,
  });
  return { gen, cards, prompts };
}

describe("revision generator", () => {
  it("fills the deck in at most 9 calls, then a rerun makes none", async () => {
    const { gen, cards, prompts } = setup();
    expect(gen.start("u")).toBe("started");
    await gen.idle("u");
    expect(prompts.length).toBe(3); // 2 groups + 1 story
    expect(cards.filter((c) => c.kind === "concept")).toHaveLength(10);
    expect(cards.filter((c) => c.kind === "story")).toHaveLength(1);
    expect(cards.filter((c) => c.kind === "pitch")).toHaveLength(1);
    gen.start("u");
    await gen.idle("u");
    expect(prompts.length).toBe(3);
    const s = await gen.status("u");
    expect(s).toMatchObject({ running: false, lastError: null, counts: { concept: 10, story: 1, pitch: 1 } });
  });

  it("skips a group that already has 4 concept cards", async () => {
    const { gen, cards, prompts } = setup();
    for (let i = 0; i < 4; i++)
      cards.push({ owner: "u", kind: "concept", topic: `t${i}`, skillGroupId: "sk-lang", question: "q", answer: "a", keyPoints: [], bulletIds: [], masterHash: "h", dedupKey: `k${i}` });
    gen.start("u");
    await gen.idle("u");
    expect(prompts.some((p) => p.includes("« Langages »"))).toBe(false);
    expect(prompts.some((p) => p.includes("« Outils »"))).toBe(true);
  });

  it("a throwing call sets lastError and the other groups continue", async () => {
    const { gen, cards } = setup(async (p) => {
      if (p.includes("« Langages »")) throw new Error("boom");
      if (p.includes("questions comportementales")) return JSON.stringify({ stories: [] });
      return concepts("o", 5);
    });
    gen.start("u");
    await gen.idle("u");
    expect((await gen.status("u")).lastError).toBe("boom");
    expect(cards.filter((c) => c.kind === "concept")).toHaveLength(5);
    expect(cards.some((c) => c.kind === "pitch")).toBe(true);
  });

  it("single-flight per owner", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { gen } = setup(async () => {
      await gate;
      return "{}";
    });
    expect(gen.start("u")).toBe("started");
    expect(gen.start("u")).toBe("in_progress");
    expect(gen.start("other")).toBe("started");
    expect((await gen.status("u")).running).toBe(true);
    release();
    await gen.idle("u");
    await gen.idle("other");
    expect((await gen.status("u")).running).toBe(false);
    expect(gen.start("u")).toBe("started");
    await gen.idle("u");
  });

  it("no master: lastError no_master", async () => {
    const { gen } = setup();
    gen.start("nomaster");
    await gen.idle("nomaster");
    expect((await gen.status("nomaster")).lastError).toBe("no_master");
  });

  describe("per offer", () => {
    const offer = { id: "o1", title: "Dev", company: "X", skills: ["TypeScript", "Rust"], description: "d" };
    it("one call, 8 cards max tagged with the offer; second call returns them without a call", async () => {
      const { gen, prompts } = setup();
      const first = await gen.generateForOffer("u", offer, {});
      expect(prompts.length).toBe(1);
      expect(first).toHaveLength(8);
      expect(first.every((c) => (c as { offerId?: string }).offerId === "o1")).toBe(true);
      const again = await gen.generateForOffer("u", offer, {});
      expect(prompts.length).toBe(1);
      expect(again).toHaveLength(8);
    });
    it("regenerate asks again, existing topics in the prompt", async () => {
      const { gen, prompts } = setup();
      await gen.generateForOffer("u", offer, {});
      await gen.generateForOffer("u", offer, { regenerate: true });
      expect(prompts.length).toBe(2);
      expect(prompts[1]).toContain("offre 0");
    });
    it("no master throws no_master", async () => {
      const { gen } = setup();
      await expect(gen.generateForOffer("nomaster", offer, {})).rejects.toThrow("no_master");
    });
  });

  describe("deep cards", () => {
    const details = {
      star: { situation: "s", task: "t", action: "a", result: "r" },
      underTheHood: "u",
      architecture: ["A → B : x", "B → C : y", "C → D : z"],
      traps: [
        { question: "q1", answer: "a" },
        { question: "q2", answer: "a" },
        { question: "q3", answer: "a" },
      ],
      lab: ["1", "2", "3"],
      value: "v",
      rescue: ["a", "b", "c"],
    };
    /** Answers every bullet id listed in the prompt, except those in `skip`. */
    const deepAnswer = (p: string, over: (id: string) => Record<string, unknown> = () => ({}), skip: string[] = []) => {
      const found = [...p.matchAll(/^\[([a-z0-9-]+)\] /gm)].map((m) => m[1]).filter((id) => !skip.includes(id));
      return JSON.stringify({ cards: found.map((id) => ({ bulletId: id, ...details, ...over(id) })) });
    };
    const bigMaster = (): CvMaster => {
      const m = structuredClone(cvMasterFixture);
      m.experiences = Array.from({ length: 4 }, (_, e) => ({
        ...cvMasterFixture.experiences[0],
        id: `exp-${e}`,
        start: `20${10 + e}-01`,
        end: `20${10 + e}-12`,
        bullets: Array.from({ length: 4 }, (_, b) => ({ id: `e${e}-b${b}`, text: `Réalisation ${e}-${b}.` })),
      }));
      return m;
    };
    function deepSetup(master: CvMaster = cvMasterFixture, hash = "h1", complete?: (p: string) => Promise<string>) {
      const { sink, cards, touched } = fakeSink();
      const prompts: string[] = [];
      const gen = createRevisionGenerator({
        store: sink,
        complete: async (p) => {
          prompts.push(p);
          return complete ? complete(p) : deepAnswer(p);
        },
        getMaster: async (o) => (o === "nomaster" ? null : { content: master, contentHash: hash }),
        timeoutMs: 1000,
      });
      return { gen, cards, prompts, touched };
    }

    it("5 bullets: 3 calls of at most 2 bullets, most recent first, one deep card each", async () => {
      const { gen, cards, prompts } = deepSetup();
      expect(gen.startDeep("u")).toBe("started");
      await gen.idle("u");
      expect(prompts.length).toBe(3);
      expect(prompts[0]).toContain("[acme-api]");
      expect(prompts[0]).toContain("[acme-ci]");
      expect(prompts[0]).not.toContain("[acme-perf]");
      expect(cards.filter((c) => c.kind === "deep")).toHaveLength(5);
      // The existing fill is untouched by startDeep.
      expect(cards.some((c) => c.kind !== "deep")).toBe(false);
    });

    it("at most 6 calls per run (12 bullets), the rest on the next run; a rerun fills only the gap", async () => {
      const { gen, cards, prompts } = deepSetup(bigMaster());
      gen.startDeep("u");
      await gen.idle("u");
      expect(prompts.length).toBe(6);
      expect(cards).toHaveLength(12);
      gen.startDeep("u");
      await gen.idle("u");
      expect(prompts.length).toBe(8); // 4 left, 2 calls
      expect(cards).toHaveLength(16);
      gen.startDeep("u");
      await gen.idle("u");
      expect(prompts.length).toBe(8);
    });

    it("archived cards count as present (the store's deepKeys includes them); unchanged ones are touched with the new hash", async () => {
      const { gen, cards, prompts, touched } = deepSetup(cvMasterFixture, "h2");
      const [first] = deepBullets(cvMasterFixture);
      cards.push({ owner: "u", kind: "deep", topic: "t", question: "q", answer: "a", keyPoints: [], bulletIds: [first.id], masterHash: "h1", dedupKey: deepKeyOf(first), details });
      gen.startDeep("u");
      await gen.idle("u");
      expect(prompts.join("\n")).not.toContain(`[${first.id}]`);
      expect(touched).toEqual([{ owner: "u", keys: [deepKeyOf(first)], hash: "h2" }]);
    });

    it("an edited bullet is generated again; the old card stays", async () => {
      const edited = structuredClone(cvMasterFixture);
      edited.experiences[0].bullets[0].text = "Conception d'une API GraphQL.";
      const { gen, cards } = deepSetup(edited);
      const old = deepBullets(cvMasterFixture)[0];
      cards.push({ owner: "u", kind: "deep", topic: "t", question: "q", answer: "a", keyPoints: [], bulletIds: [old.id], masterHash: "h1", dedupKey: deepKeyOf(old), details });
      gen.startDeep("u");
      await gen.idle("u");
      expect(cards.filter((c) => c.kind === "deep")).toHaveLength(6);
    });

    it("a failing batch sets lastError, the other batches still run", async () => {
      let n = 0;
      const { gen, cards } = deepSetup(cvMasterFixture, "h1", async (p) => {
        if (++n === 2) throw new Error("boom");
        return deepAnswer(p);
      });
      gen.startDeep("u");
      await gen.idle("u");
      expect((await gen.status("u")).deep.lastError).toBe("boom");
      expect(cards.filter((c) => c.kind === "deep")).toHaveLength(3); // 2 + 0 + 1
    });

    it("a bullet dropped by the number guard is skipped on the next runs, until the hash changes", async () => {
      const bad = (id: string) => (id === "acme-perf" ? { value: "Gain de 99 %." } : {});
      let hash = "h1";
      const { sink, cards } = fakeSink();
      const prompts: string[] = [];
      const gen = createRevisionGenerator({
        store: sink,
        complete: async (p) => {
          prompts.push(p);
          return deepAnswer(p, bad);
        },
        getMaster: async () => ({ content: cvMasterFixture, contentHash: hash }),
        timeoutMs: 1000,
      });
      gen.startDeep("u");
      await gen.idle("u");
      expect(cards.filter((c) => c.kind === "deep")).toHaveLength(4);
      const calls = prompts.length;
      gen.startDeep("u");
      await gen.idle("u");
      expect(prompts.length).toBe(calls); // acme-perf is not retried
      hash = "h2";
      gen.startDeep("u");
      await gen.idle("u");
      expect(prompts.length).toBe(calls + 1);
    });

    it("single-flight, separate from the existing fill", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { gen } = deepSetup(cvMasterFixture, "h1", async (p) => {
        await gate;
        return deepAnswer(p);
      });
      expect(gen.startDeep("u")).toBe("started");
      expect(gen.startDeep("u")).toBe("in_progress");
      expect(gen.start("u")).toBe("started");
      expect(gen.startDeep("other")).toBe("started");
      const s = await gen.status("u");
      expect(s.deep.running).toBe(true);
      release();
      await gen.idle("u");
      await gen.idle("other");
      const done = await gen.status("u");
      expect(done.deep).toEqual({ running: false, lastError: null });
      expect(done.counts.deep).toBe(5);
    });

    it("no master: deep lastError no_master", async () => {
      const { gen } = deepSetup();
      gen.startDeep("nomaster");
      await gen.idle("nomaster");
      expect((await gen.status("nomaster")).deep.lastError).toBe("no_master");
    });
  });
});
