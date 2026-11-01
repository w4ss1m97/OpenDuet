import { describe, expect, test } from "bun:test";
import type { CockpitService } from "../src/openduet/cockpit/collect";
import type { ExplainService, GenerateOutcome } from "../src/openduet/cockpit/explain";
import type { ExploreResult, ExploreService } from "../src/openduet/cockpit/explore";
import { createCockpitApp } from "../src/openduet/cockpit/server";
import type { ExploreFacts, Explanation } from "../src/openduet/cockpit/types";

const PORT = 3002;
const ORIGIN = "http://localhost:3010";
const ORIGINS = new Set([ORIGIN, "tauri://localhost"]);
const LOCAL = { ip: { address: "127.0.0.1" } };
const HEAD = "a".repeat(40);

const facts: ExploreFacts = {
  head: HEAD, generatedAt: 1, files: 1, bytes: 1, truncated: false, languages: [], tree: [], treeTruncated: false,
  manifests: [], workflows: [], docs: [], entryPoints: [], tags: [], releases: null,
};
const explanation: Explanation = { summary: "s", sections: [], modules: [], diagram: { nodes: [], edges: [] } };
const result = (head: string | null = HEAD): ExploreResult => ({ name: "My Project", root: "/tmp/p", facts: { ...facts, head }, excerpts: [] });

const service: CockpitService = { snapshot: async () => ({ projects: [], attention: [], names: [], generatedAt: 1 }), project: async () => null };

function build(opts: { head?: string | null; outcome?: GenerateOutcome; withExplain?: boolean } = {}) {
  const generated: string[] = [];
  const explore: ExploreService = { explore: async (name) => (name === "My Project" ? result(opts.head === undefined ? HEAD : opts.head) : null) };
  const explain: ExplainService = {
    status: async (input) => ({ head: input.facts.head, promptVersion: 1, estimate: { inputTokens: 10, maxOutputTokens: 8192 }, cached: null, staleCached: null }),
    generate: async (_input, head) => {
      generated.push(head);
      return opts.outcome ?? { kind: "ok", result: { head, promptVersion: 1, cached: false, generatedAt: 5, explanation } };
    },
  };
  const app = createCockpitApp({ getPort: () => PORT, origins: ORIGINS, service, explore, explain: opts.withExplain === false ? undefined : explain });
  const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    app.request(`http://127.0.0.1:${PORT}${path}`, { method: init.method ?? "GET", headers: { Host: `127.0.0.1:${PORT}`, ...init.headers } }, LOCAL as object);
  return { call, generated };
}

const EXPLAIN = "/api/cockpit/projects/My%20Project/explain";
const post = (path = `${EXPLAIN}?head=${HEAD}`, headers: Record<string, string> = { Origin: ORIGIN }) => ({ method: "POST", headers, path });

describe("explore and explain GET routes", () => {
  test("GET /explore answers the facts", async () => {
    const { call } = build();
    const res = await call("/api/cockpit/projects/My%20Project/explore");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).head).toBe(HEAD);
  });
  test("GET /explain answers head, version, estimate, cached, staleCached", async () => {
    const { call } = build();
    const res = await call(EXPLAIN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ head: HEAD, promptVersion: 1, estimate: { inputTokens: 10, maxOutputTokens: 8192 }, cached: null, staleCached: null });
  });
  test("an unknown project is 404 on both", async () => {
    const { call } = build();
    expect((await call("/api/cockpit/projects/nope/explore")).status).toBe(404);
    expect((await call("/api/cockpit/projects/nope/explain")).status).toBe(404);
  });
  test("an unknown path is 404", async () => {
    const { call } = build();
    expect((await call("/api/cockpit/projects/My%20Project/other")).status).toBe(404);
  });
});

describe("POST explain", () => {
  const run = (b: ReturnType<typeof build>, p = post(), extra: Record<string, string> = {}) =>
    b.call(p.path, { method: p.method, headers: { ...p.headers, ...extra } });

  test("no Origin is 403 and nothing is generated", async () => {
    const b = build();
    const res = await run(b, post(undefined, {}));
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(b.generated).toEqual([]);
  });
  test("a foreign Origin is 403 without ACAO", async () => {
    const b = build();
    const res = await run(b, post(undefined, { Origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(b.generated).toEqual([]);
  });
  test("an allowed Origin gets 200, the explanation and ACAO", async () => {
    const b = build();
    const res = await run(b);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await res.json()).toEqual({ head: HEAD, promptVersion: 1, cached: false, generatedAt: 5, explanation });
    expect(b.generated).toEqual([HEAD]);
  });
  test("a body or Transfer-Encoding is 400", async () => {
    const b = build();
    expect((await run(b, post(), { "Content-Length": "2" })).status).toBe(400);
    expect((await run(b, post(), { "Transfer-Encoding": "chunked" })).status).toBe(400);
    expect((await run(b, post(), { "Content-Length": "0" })).status).toBe(200);
    expect(b.generated.length).toBe(1);
  });
  test("a missing or malformed head is 400, a different head is 409", async () => {
    const b = build();
    expect((await run(b, post(EXPLAIN))).status).toBe(400);
    expect((await run(b, post(`${EXPLAIN}?head=zzz`))).status).toBe(400);
    const res = await run(b, post(`${EXPLAIN}?head=${"b".repeat(40)}`));
    expect(res.status).toBe(409);
    expect(b.generated).toEqual([]);
  });
  test("an empty repo (no head) is 409", async () => {
    const b = build({ head: null });
    expect((await run(b)).status).toBe(409);
  });
  test("an unknown project is 404", async () => {
    const b = build();
    expect((await run(b, post(`/api/cockpit/projects/nope/explain?head=${HEAD}`))).status).toBe(404);
  });
  test("429 when busy, 429 with Retry-After when over the hourly limit", async () => {
    const busy = await run(build({ outcome: { kind: "busy" } }));
    expect(busy.status).toBe(429);
    const rate = await run(build({ outcome: { kind: "rate", retryAfterSeconds: 120 } }));
    expect(rate.status).toBe(429);
    expect(rate.headers.get("retry-after")).toBe("120");
  });
  test("502 when the model fails, 503 without a completer", async () => {
    expect((await run(build({ outcome: { kind: "error" } }))).status).toBe(502);
    expect((await run(build({ outcome: { kind: "unavailable" } }))).status).toBe(503);
    expect((await run(build({ withExplain: false }))).status).toBe(503);
  });
  test("POST anywhere else is 405, OPTIONS is 405 everywhere", async () => {
    const b = build();
    for (const path of ["/api/cockpit/projects", "/api/cockpit/projects/My%20Project", "/api/cockpit/projects/My%20Project/explore", "/api/cockpit/projects/My%20Project/explain/x"]) {
      const res = await b.call(path, { method: "POST", headers: { Origin: ORIGIN } });
      expect(res.status).toBe(405);
    }
    for (const path of ["/api/cockpit/projects", EXPLAIN]) {
      const res = await b.call(path, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
      expect(res.status).toBe(405);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await b.call(EXPLAIN, { method: "PUT", headers: { Origin: ORIGIN } })).status).toBe(405);
  });
  test("the Host and loopback checks still come first", async () => {
    const b = build();
    expect((await b.call(post().path, { method: "POST", headers: { Origin: ORIGIN, Host: "evil.example" } })).status).toBe(403);
    expect(b.generated).toEqual([]);
  });
});

describe("listener timeout", () => {
  test("keeps a generation's connection open longer than the 120 s model call", async () => {
    const { COCKPIT_IDLE_TIMEOUT_S } = await import("../src/openduet/cockpit/server");
    expect(COCKPIT_IDLE_TIMEOUT_S).toBeGreaterThan(120);
    expect(COCKPIT_IDLE_TIMEOUT_S).toBeLessThanOrEqual(255);
  });
});
