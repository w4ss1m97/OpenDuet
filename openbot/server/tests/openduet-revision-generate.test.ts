import { describe, expect, it } from "bun:test";
import type { NewRevisionCard } from "../src/openduet/revision/store";
import { createRevisionGenerator, type CardRow, type RevisionSink } from "../src/openduet/revision/generate";
import { cvMasterFixture } from "./fixtures/cv-master";

function fakeSink() {
  const cards: (NewRevisionCard & { owner: string })[] = [];
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
  };
  return { sink, cards };
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
});
