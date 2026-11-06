import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQualityStore, parisDay } from "../src/openduet/cockpit/quality-store";
import { score, suggestions, highFindings } from "../src/openduet/cockpit/quality-score";
import { CFG, healthy } from "./quality-fixtures.helper";

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "q-store-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function result(project: string, scannedAt: number, readme = true) {
  const s = { ...healthy(), project, scannedAt };
  s.hygiene = { ...s.hygiene, readme };
  return { ...s, ...score(s, CFG), suggestions: suggestions(project, s, "main", CFG), highFindings: highFindings(s) };
}
const T = (iso: string) => Date.parse(iso);

describe("quality store", () => {
  test("parisDay follows the Paris calendar", () => {
    expect(parisDay(T("2026-10-01T21:30:00Z") / 1000, "Europe/Paris")).toBe("2026-10-01");
    expect(parisDay(T("2026-10-01T22:30:00Z") / 1000, "Europe/Paris")).toBe("2026-10-02");
  });

  test("missing file is empty without error; save then read; file 0600, dir 0700", async () => {
    const path = join(dir, "a", "q.json");
    const store = createQualityStore({ path, now: () => T("2026-10-02T10:00:00Z") });
    expect(await store.read()).toMatchObject({ error: null, data: { version: 1, scans: {}, history: {}, dismissed: {} } });
    await store.saveScan(result("p", T("2026-10-02T10:00:00Z") / 1000));
    const { data, error } = await store.read();
    expect(error).toBeNull();
    expect(data.scans.p!.grade).toBe("A");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "a"))).mode & 0o777).toBe(0o700);
  });

  test("one history row per Paris day, last wins; 90 days kept", async () => {
    const path = join(dir, "h.json");
    let nowMs = T("2026-10-01T21:30:00Z");
    const store = createQualityStore({ path, now: () => nowMs });
    await store.saveScan(result("p", nowMs / 1000, false));
    nowMs = T("2026-10-01T21:50:00Z");
    await store.saveScan(result("p", nowMs / 1000, true));
    nowMs = T("2026-10-01T22:30:00Z"); // next Paris day
    await store.saveScan(result("p", nowMs / 1000));
    let hist = (await store.read()).data.history.p!;
    expect(hist.map((r) => r.day)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(hist[0]!.score).toBe(100);
    for (let i = 0; i < 100; i++) {
      nowMs += 86_400_000;
      await store.saveScan(result("p", nowMs / 1000));
    }
    hist = (await store.read()).data.history.p!;
    expect(hist).toHaveLength(90);
    expect(hist[89]!.day).toBe(parisDay(nowMs / 1000, "Europe/Paris"));
  });

  test("dismissal lasts 30 days and expired ones are dropped on the next write", async () => {
    const path = join(dir, "d.json");
    let nowMs = T("2026-10-01T10:00:00Z");
    const store = createQualityStore({ path, now: () => nowMs });
    const until = await store.dismiss("abcdef0123456789");
    expect(until).toBe(nowMs / 1000 + 30 * 86400);
    expect((await store.read()).data.dismissed).toEqual({ abcdef0123456789: until });
    nowMs += 31 * 86400_000;
    await store.dismiss("1111111111111111");
    expect(Object.keys((await store.read()).data.dismissed)).toEqual(["1111111111111111"]);
  });

  test("invalid or unreadable store reads as empty with an error, and is replaced on save", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{not json");
    const store = createQualityStore({ path, now: () => T("2026-10-02T10:00:00Z") });
    const r = await store.read();
    expect(r.data.scans).toEqual({});
    expect(r.error).toContain("invalid");
    await writeFile(path, JSON.stringify({ version: 1, scans: { p: { nope: true } }, history: {}, dismissed: {} }));
    expect((await store.read()).error).not.toBeNull();
    await store.saveScan(result("p", T("2026-10-02T10:00:00Z") / 1000));
    expect((await store.read()).error).toBeNull();
    expect(JSON.parse(await readFile(path, "utf8")).scans.p.project).toBe("p");
  });

  test("concurrent saves do not lose a project", async () => {
    const path = join(dir, "c.json");
    const store = createQualityStore({ path, now: () => T("2026-10-02T10:00:00Z") });
    await Promise.all(["a", "b", "c", "d"].map((n) => store.saveScan(result(n, 1))));
    expect(Object.keys((await store.read()).data.scans).sort()).toEqual(["a", "b", "c", "d"]);
  });
});
