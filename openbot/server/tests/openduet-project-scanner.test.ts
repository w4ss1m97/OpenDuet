import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjects,
  type Project,
  type ProjectReader,
  scanProject,
} from "../src/openduet/items/project-scanner";

const project: Project = { id: "openduet", name: "OpenDuet", path: "~/src/OpenDuet" };
const now = new Date("2026-11-07T10:00:00Z");

const NOTES = `# Session notes
## State
- stuff
## Exact next step
Wassim reviews the plan + picks execution.
More detail.
`;

function reader(notes: string | null, commit: string | null): ProjectReader {
  return { file: async () => notes, lastCommit: async () => commit };
}

test("uses the Exact next step line", async () => {
  const item = await scanProject(project, reader(NOTES, "feat(duet): add tables"), now);
  expect(item).toMatchObject({
    kind: "project_status",
    title: "OpenDuet — Wassim reviews the plan + picks execution.",
    why: "Dernier commit : feat(duet): add tables",
    channelId: "projets",
    sourceApp: "project",
    dateExplicit: false,
  });
});

test('missing notes gives "pas de notes"', async () => {
  const item = await scanProject(project, reader(null, null), now);
  expect(item.title).toBe("OpenDuet — pas de notes");
  expect(item.why).toBe("Aucun commit lu");
});

test("one hash per project, so each day updates the same item", () => {
  return Promise.all([
    scanProject(project, reader(NOTES, null), now),
    scanProject(project, reader(NOTES, null), new Date("2026-11-08T10:00:00Z")),
  ]).then(([a, b]) => {
    expect(a.sourceHash).toBe("project:openduet");
    expect(b.sourceHash).toBe(a.sourceHash);
  });
});

test("loadProjects returns [] without file", () => {
  expect(loadProjects(mkdtempSync(join(tmpdir(), "duet-")))).toEqual([]);
});

test("loadProjects reads projects.yaml and rejects shell characters in paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "duet-"));
  writeFileSync(join(dir, "projects.yaml"), "projects:\n  - id: openduet\n    name: OpenDuet\n    path: ~/src/OpenDuet\n");
  expect(loadProjects(dir)).toEqual([project]);
  writeFileSync(join(dir, "projects.yaml"), "projects:\n  - id: x\n    name: X\n    path: ~/src/x; rm -rf ~\n");
  expect(() => loadProjects(dir)).toThrow();
});
