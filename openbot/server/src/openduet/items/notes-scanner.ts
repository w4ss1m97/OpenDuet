import { createHash } from "node:crypto";
import type { ItemCandidate, ItemKind } from "./types";

/** Runs one shell command on the person's Mac through the desktop app and returns its output. */
export type HostRunner = (
  command: string,
) => Promise<{ ok: boolean; output?: string; error?: string }>;

/**
 * Lists the notes changed in the last 30 days as JSON `[{id,name,modified,body}]`, body as plain
 * text. One fixed string on purpose: the Mac's "always allow" covers an exact command, so the window
 * is fixed here and the scanner filters by its own cursor. Read-only: nothing here writes to Notes.
 */
const NOTES_JXA = [
  'const n = Application("Notes");',
  "const cut = new Date(Date.now() - 30 * 864e5);",
  "const ids = n.notes.id(), names = n.notes.name(), mods = n.notes.modificationDate();",
  "const out = [];",
  "for (let i = 0; i < ids.length; i++) if (mods[i] > cut)",
  "  out.push({ id: ids[i], name: names[i], modified: mods[i].toISOString(), body: n.notes.byId(ids[i]).plaintext() });",
  "JSON.stringify(out);",
].join(" ");
export const NOTES_OSASCRIPT = `osascript -l JavaScript -e '${NOTES_JXA}'`;

type Note = { id: string; name: string; modified: string; body: string };

const RULES: { pattern: RegExp; kind: ItemKind }[] = [
  { pattern: /^(?:-\s*\[ \]|☐|□)\s*(.+)$/, kind: "todo" },
  { pattern: /^(?:TODO|À faire|A faire)\s*[:\-–]?\s*(.+)$/i, kind: "todo" },
  { pattern: /^Penser à\s+(.+)$/i, kind: "todo" },
  { pattern: /^(Relancer\s+.+)$/i, kind: "todo" },
  { pattern: /^Id[ée]e\b\s*[:\-–]?\s*(.+)$/i, kind: "idea" },
];

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function linesOf(note: Note): ItemCandidate[] {
  const found: ItemCandidate[] = [];
  for (const raw of note.body.split("\n")) {
    const line = raw.trim();
    for (const rule of RULES) {
      const title = line.match(rule.pattern)?.[1]?.trim();
      if (!title) continue;
      found.push({
        kind: rule.kind,
        title: title.slice(0, 140),
        why: `Note « ${note.name} »`,
        sourceApp: "apple_notes",
        sourceLink: note.name,
        sourceHash: `notes:${note.id}:${sha1(line.toLowerCase().replace(/\s+/g, " "))}`,
        dateExplicit: false,
      });
      break;
    }
  }
  return found;
}

/** Every idea and to-do line in the notes printed by {@link NOTES_OSASCRIPT}. */
export function parseNotes(json: string, since: Date | null = null): ItemCandidate[] {
  const notes = JSON.parse(json) as Note[];
  return notes
    .filter((note) => !since || new Date(note.modified).getTime() > since.getTime())
    .flatMap(linesOf);
}

export async function scanNotes(
  run: HostRunner,
  since: Date | null,
  timeoutMs = 60_000,
  now = new Date(),
): Promise<
  | { ok: true; candidates: ItemCandidate[]; cursor: { since: string } }
  | { ok: false; error: string }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: "Le Mac n'a pas répondu à temps." }),
      timeoutMs,
    );
  });
  try {
    const result = await Promise.race([run(NOTES_OSASCRIPT), timeout]);
    if (!result.ok) return { ok: false, error: result.error ?? "Notes illisibles." };
    try {
      return {
        ok: true,
        candidates: parseNotes(result.output ?? "", since),
        cursor: { since: now.toISOString() },
      };
    } catch {
      return { ok: false, error: "La sortie de Notes n'est pas lisible." };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
