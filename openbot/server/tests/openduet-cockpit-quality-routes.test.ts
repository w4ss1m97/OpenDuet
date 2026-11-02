import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CockpitService } from "../src/openduet/cockpit/collect";
import type { QualityResult } from "../src/openduet/cockpit/quality-parse";
import { highFindings, score, suggestions } from "../src/openduet/cockpit/quality-score";
import { createQualityService } from "../src/openduet/cockpit/quality-service";
import { createQualityStore } from "../src/openduet/cockpit/quality-store";
import { cockpitExtraAttention, createCockpitApp } from "../src/openduet/cockpit/server";
import { CFG, healthy } from "./quality-fixtures.helper";

const PORT = 3002;
const ORIGIN = "http://localhost:3010";
const LOCAL = { ip: { address: "127.0.0.1" } };
const NOW = Date.parse("2026-10-10T12:00:00Z");
const service: CockpitService = { snapshot: async () => ({ projects: [], attention: [], names: [], generatedAt: 1 }), project: async () => null };
const projects = ["A", "B"].map((name) => ({ name, path: `/p/${name}` }));

let dir: string;
let n = 0;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "q-routes-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function result(project: string, tweak: (s: ReturnType<typeof healthy>) => void = () => undefined): QualityResult {
  const s = { ...healthy(), project, scannedAt: NOW / 1000 };
  tweak(s);
  return { ...s, ...score(s, CFG), suggestions: suggestions(project, s, "main", CFG), highFindings: highFindings(s) };
}

function build(over: { scan?: (name: string) => Promise<QualityResult>; withQuality?: boolean } = {}) {
  const clock = { t: NOW };
  const store = createQualityStore({ path: join(dir, `s${n++}.json`), now: () => clock.t });
  const scans: string[] = [];
  const quality = createQualityService({
    store, listProjects: async () => projects, now: () => clock.t, config: async () => ({ config: CFG, error: null }),
    scan: async (p) => { scans.push(p.name); return over.scan ? over.scan(p.name) : result(p.name); },
  });
  const app = createCockpitApp({ getPort: () => PORT, origins: new Set([ORIGIN]), service, quality: over.withQuality === false ? undefined : quality, now: () => clock.t });
  const call = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
    app.request(`http://127.0.0.1:${PORT}${path}`, { method: init.method ?? "GET", headers: { Host: `127.0.0.1:${PORT}`, ...init.headers } }, LOCAL as object);
  const post = (path: string, headers: Record<string, string> = { Origin: ORIGIN }) => call(path, { method: "POST", headers });
  return { call, post, store, quality, scans, clock };
}

describe("quality reads", () => {
  test("no service: 404", async () => {
    const { call } = build({ withQuality: false });
    expect((await call("/api/cockpit/quality")).status).toBe(404);
    expect((await call("/api/cockpit/quality/A")).status).toBe(404);
  });
  test("summary, detail with trend and suggestions, unknown 404", async () => {
    const { call, store } = build();
    await store.saveScan(result("A", (s) => { s.hygiene.ci = false; }));
    const sum = await (await call("/api/cockpit/quality")).json();
    expect(sum.projects.map((p: { name: string }) => p.name)).toEqual(["A"]);
    expect(sum.status.queue).toEqual([]);
    const detail = await call("/api/cockpit/quality/A");
    expect(detail.status).toBe(200);
    const body = await detail.json();
    expect(body.trend).toHaveLength(1);
    expect(body.suggestions.length).toBeGreaterThan(0);
    expect(body.suggestions[0].dismissedUntil).toBe(0);
    expect((await call("/api/cockpit/quality/Nope")).status).toBe(404);
  });
});

describe("the write guard", () => {
  const url = "/api/cockpit/quality/scan?project=A";
  test("no Origin and a foreign Origin are 403", async () => {
    const { post, scans } = build();
    expect((await post(url, {})).status).toBe(403);
    expect((await post(url, { Origin: "http://evil.example" })).status).toBe(403);
    expect(scans).toEqual([]);
  });
  test("a body or Transfer-Encoding is 400", async () => {
    const { post } = build();
    expect((await post(url, { Origin: ORIGIN, "Content-Length": "2" })).status).toBe(400);
    expect((await post(url, { Origin: ORIGIN, "Transfer-Encoding": "chunked" })).status).toBe(400);
  });
  test("a repeated parameter is 400", async () => {
    const { post } = build();
    expect((await post("/api/cockpit/quality/scan?project=A&project=B")).status).toBe(400);
  });
  test("OPTIONS is 405 with no CORS answer; PUT and DELETE are 405", async () => {
    const { call } = build();
    const options = await call(url, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    expect(options.status).toBe(405);
    expect(options.headers.get("access-control-allow-origin")).toBeNull();
    expect(options.headers.get("access-control-allow-methods")).toBeNull();
    for (const method of ["PUT", "DELETE", "PATCH"]) expect((await call(url, { method, headers: { Origin: ORIGIN } })).status).toBe(405);
    expect((await call("/api/cockpit/reminders", { method: "DELETE", headers: { Origin: ORIGIN } })).status).toBe(405);
  });
  test("the 31st write in a minute is 429 with Retry-After, and the window then moves", async () => {
    const { post, clock } = build();
    for (let i = 0; i < 30; i++) expect((await post("/api/cockpit/quality/scan?project=Nope")).status).toBe(404);
    const res = await post("/api/cockpit/quality/scan?project=Nope");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    clock.t += 61_000;
    expect((await post("/api/cockpit/quality/scan?project=Nope")).status).toBe(404);
  });
});

describe("scan and dismiss", () => {
  test("scan answers 202, a second ask for the same project is deduped, and the scan lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { post, quality, scans } = build({ scan: async (name) => { await gate; return result(name); } });
    const first = await post("/api/cockpit/quality/scan?project=A");
    expect(first.status).toBe(202);
    expect((await first.json()).queued).toEqual(["A"]);
    const second = await post("/api/cockpit/quality/scan?project=A");
    expect(second.status).toBe(202);
    expect((await second.json()).queued).toEqual([]);
    release();
    await quality.idle();
    expect(scans).toEqual(["A"]);
  });
  test("missing project 400, unknown project 404", async () => {
    const { post } = build();
    expect((await post("/api/cockpit/quality/scan")).status).toBe(400);
    expect((await post("/api/cockpit/quality/scan?project=")).status).toBe(400);
    expect((await post("/api/cockpit/quality/scan?project=Nope")).status).toBe(404);
  });
  test("all twice within 5 minutes is 429; after 5 minutes it is fine", async () => {
    const { post, quality, clock } = build();
    expect((await post("/api/cockpit/quality/scan?project=all")).status).toBe(202);
    await quality.idle();
    const again = await post("/api/cockpit/quality/scan?project=all");
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(0);
    clock.t += 301_000;
    expect((await post("/api/cockpit/quality/scan?project=all")).status).toBe(202);
  });
  test("dismiss: bad key 400, unknown project and unknown suggestion 404, good key hides it 30 days", async () => {
    const { post, call, store } = build();
    await store.saveScan(result("A", (s) => { s.hygiene.ci = false; }));
    const key = (await (await call("/api/cockpit/quality/A")).json()).suggestions[0].key as string;
    expect((await post("/api/cockpit/quality/A/dismiss?key=zz")).status).toBe(400);
    expect((await post("/api/cockpit/quality/A/dismiss")).status).toBe(400);
    expect((await post(`/api/cockpit/quality/Nope/dismiss?key=${key}`)).status).toBe(404);
    expect((await post(`/api/cockpit/quality/A/dismiss?key=${"0".repeat(16)}`)).status).toBe(404);
    const ok = await post(`/api/cockpit/quality/A/dismiss?key=${key}`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).until).toBe(NOW / 1000 + 30 * 86400);
    const after = await (await call("/api/cockpit/quality/A")).json();
    expect(after.suggestions.find((s: { key: string }) => s.key === key).dismissedUntil).toBe(NOW / 1000 + 30 * 86400);
  });
});

describe("attention", () => {
  test("quality high findings are merged with the usage lines", async () => {
    const { store, quality } = build();
    await store.saveScan(result("A", (s) => { s.security.local = [{ file: "src/a.ts", line: 3, type: "AWS access key id", severity: "high" }]; }));
    const usage = { attention: async () => [{ project: "overall", severity: "medium" as const, message: "budget", link: null }] };
    const lines = await cockpitExtraAttention(usage as never, undefined, quality)();
    expect(lines.map((l) => l.message)).toContain("budget");
    const q = lines.find((l) => l.project === "A");
    expect(q).toMatchObject({ severity: "high", link: "/cockpit/quality/A" });
    expect(JSON.stringify(lines)).not.toContain("AKIA");
  });
  test("a failing quality source costs only itself", async () => {
    const broken = { summary: async () => { throw new Error("x"); } };
    const usage = { attention: async () => [{ project: "overall", severity: "medium" as const, message: "budget", link: null }] };
    expect(await cockpitExtraAttention(usage as never, undefined, broken as never)()).toHaveLength(1);
  });
});
