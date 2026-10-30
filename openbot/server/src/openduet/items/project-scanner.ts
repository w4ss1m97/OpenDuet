import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parisParts } from "./paris-time";
import type { HostRunner } from "./notes-scanner";
import type { ItemCandidate } from "./types";

/** A path the scanner can put in a shell command as is: no spaces, quotes or separators. */
const SAFE_PATH = /^[~\w./-]+$/;

const projectSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  name: z.string().min(1),
  path: z.string().regex(SAFE_PATH),
});
export type Project = z.infer<typeof projectSchema>;

const fileSchema = z.object({ projects: z.array(projectSchema).default([]) });

/** The projects listed in `projects.yaml` of the tenant package; none when the file is absent. */
export function loadProjects(dir: string): Project[] {
  const file = join(dir, "projects.yaml");
  if (!existsSync(file)) return [];
  return fileSchema.parse(parse(readFileSync(file, "utf8")) ?? {}).projects;
}

export type ProjectReader = {
  file(path: string): Promise<string | null>;
  lastCommit(path: string): Promise<string | null>;
};

/** Reads through the Mac bridge: one fixed command per project, so each can be always allowed. */
export function hostProjectReader(run: HostRunner): ProjectReader {
  const output = async (command: string) => {
    const result = await run(command);
    return result.ok ? (result.output?.trim() ?? null) || null : null;
  };
  return {
    file: (path) => output(`cat ${path}`),
    lastCommit: (path) => output(`git -C ${path} log -1 --format=%s`),
  };
}

function nextStep(notes: string): string | null {
  const after = notes.split(/^##\s*Exact next step\s*$/im)[1];
  return after?.split("\n").find((line) => line.trim())?.trim() ?? null;
}

/** Where the project stands today: its notes' next step and its last commit. One item per day. */
export async function scanProject(
  p: Project,
  read: ProjectReader,
  now = new Date(),
): Promise<ItemCandidate> {
  const [notes, commit] = await Promise.all([
    read.file(`${p.path}/.claude/session-notes.md`),
    read.lastCommit(p.path),
  ]);
  const day = parisParts(now);
  const date = `${day.year}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
  return {
    kind: "project_status",
    title: `${p.name} — ${(notes && nextStep(notes)) ?? "pas de notes"}`,
    why: commit ? `Dernier commit : ${commit}` : "Aucun commit lu",
    channelId: "projets",
    sourceApp: "project",
    sourceLink: p.path,
    sourceHash: `project:${p.id}:${date}`,
    dateExplicit: false,
  };
}
