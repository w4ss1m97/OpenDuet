import { expect, test } from "bun:test";
import { createDbProfileSource } from "../src/openduet/job-offers/profile";
import { cvMasterFixture } from "./fixtures/cv-master";

/** A master CV in the database wins over the profile file; without one the file is used. */

const file = { text: async () => "profil du fichier" };

test("a master wins over the file, capped at 8000 characters", async () => {
  const text = await createDbProfileSource(
    { getMaster: async () => ({ content: cvMasterFixture }) as never },
    file,
  ).text("owner");
  expect(text).toContain("Acme");
  expect(text).not.toContain("profil du fichier");
  expect(text!.length).toBeLessThanOrEqual(8000);
});

test("no master falls back to the file", async () => {
  const source = createDbProfileSource({ getMaster: async () => null }, file);
  expect(await source.text("owner")).toBe("profil du fichier");
  expect(await createDbProfileSource({ getMaster: async () => null }, { text: async () => null }).text("o")).toBeNull();
});
