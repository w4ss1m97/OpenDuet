import { describe, expect, test } from "bun:test";
import { parseMaster, type CvMaster } from "../src/openduet/job-offers/cv-schema";
import { matchSkills } from "../src/openduet/job-offers/cv-tailor";

const master: CvMaster = parseMaster({
  header: { name: "Jean <Dupont>", email: "j@x.fr", linkedin: "https://linkedin.com/in/jd" },
  titles: ["Dev Backend", "Ingénieur DevOps"],
  profiles: ["Profil A", "Profil B"],
  certifications: [{ year: 2022, name: "AWS SAA" }],
  experiences: [
    { id: "e1", role: "Lead", company: "Acme & Co", start: "2020-01", end: null, bullets: [
      { id: "e1-a", text: "Migré vers k8s" }, { id: "e1-b", text: "Pipeline CI" }, { id: "e1-c", text: "Mentoring" } ], environment: ["Terraform"] },
    { id: "e2", role: "Dev", company: "Beta", start: "2018-02", end: "2019-12", bullets: [
      { id: "e2-a", text: "API REST" }, { id: "e2-b", text: "Tests" } ], environment: [] },
  ],
  skills: [{ id: "s1", group: "Langages", items: ["TypeScript", "Go"] }, { id: "s2", group: "Cloud", items: ["AWS", "Kubernetes"] }],
  languages: [{ name: "Français", level: "Natif" }],
});

describe("matchSkills", () => {
  test("covers via items, environments, bullets", () => {
    const r = matchSkills(master, ["Go", "Terraform", "API REST", "Rust"]);
    expect(r.covered).toEqual(["Go", "Terraform", "API REST"]);
    expect(r.missing).toEqual(["Rust"]);
  });
  test("aliases", () => {
    expect(matchSkills(master, ["k8s", "ts", "amazon web services", "tf"]).missing).toEqual([]);
  });
  test("whole word only", () => {
    expect(matchSkills(master, ["Tes", "Ope", "G"]).covered).toEqual([]);
  });
  test("case and accents", () => {
    expect(matchSkills(master, ["MIGRE", "typescript"]).covered).toEqual(["MIGRE", "typescript"]);
  });
  test("no skills", () => {
    expect(matchSkills(master, [])).toEqual({ covered: [], missing: [] });
  });
});
