import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type HostRunner,
  NOTES_OSASCRIPT,
  parseNotes,
  scanNotes,
} from "../src/openduet/items/notes-scanner";

const output = readFileSync(
  join(import.meta.dir, "fixtures/duet-notes/osascript-output.txt"),
  "utf8",
);

test("parses checklist and keyword lines from fixture", () => {
  const found = parseNotes(output);
  expect(found.map((c) => [c.kind, c.title])).toEqual([
    ["idea", "une newsletter DevOps hebdo"],
    ["todo", "Acheter le domaine duet.fr"],
    ["todo", "relire le contrat Acme"],
    ["todo", "Pain"],
    ["todo", "appeler le plombier"],
    ["todo", "Relancer Camille chez Société Exemple"],
    ["todo", "mettre à jour le CV"],
  ]);
  for (const c of found) {
    expect(c.sourceApp).toBe("apple_notes");
    expect(c.dateExplicit).toBe(false);
  }
  expect(found[0]?.why).toBe("Note « Idées side projects »");
});

test("hash is per line, so unchanged lines are ignored", () => {
  const before = parseNotes(output).map((c) => c.sourceHash);
  const edited = output.replace("TODO relire le contrat Acme", "TODO relire le contrat Acme\\nTODO envoyer la facture");
  const after = parseNotes(edited).map((c) => c.sourceHash);
  expect(after.filter((h) => !before.includes(h))).toHaveLength(1);
  expect(before.every((h) => after.includes(h))).toBe(true);
});

test("the command is one fixed string, so one always-allow grant covers every run", () => {
  expect(NOTES_OSASCRIPT.startsWith("osascript -l JavaScript -e ")).toBe(true);
  expect(NOTES_OSASCRIPT).not.toContain("'\"'");
});

test("scanNotes keeps notes modified after the cursor", async () => {
  const run: HostRunner = async () => ({ ok: true, output });
  const now = new Date("2026-11-07T00:00:00Z");
  const result = await scanNotes(run, new Date("2026-11-01T00:00:00Z"), 1000, now);
  if (!result.ok) throw new Error(result.error);
  expect(result.candidates).toHaveLength(5);
  expect(result.cursor).toEqual({ since: now.toISOString() });
});

test("notes scanner reports unreadable when host call is refused or times out", async () => {
  const refused: HostRunner = async () => ({ ok: false, error: "refused" });
  const throws: HostRunner = async () => {
    throw new Error("bridge offline");
  };
  const hangs: HostRunner = () => new Promise(() => {});
  expect(await scanNotes(refused, null, 50)).toEqual({ ok: false, error: "refused" });
  expect(await scanNotes(throws, null, 50)).toEqual({ ok: false, error: "bridge offline" });
  const timedOut = await scanNotes(hangs, null, 50);
  expect(timedOut.ok).toBe(false);
});

test("output that is not JSON is unreadable, not empty", async () => {
  const garbage: HostRunner = async () => ({ ok: true, output: "execution error: Notes got an error" });
  expect((await scanNotes(garbage, null, 50)).ok).toBe(false);
});
