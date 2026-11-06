import { describe, expect, test } from "bun:test";
import { parseMaster, type CvMaster } from "../src/openduet/job-offers/cv-schema";
import { escapeHtml, renderCvHtml } from "../src/openduet/job-offers/cv-render";

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

describe("renderCvHtml", () => {
  const html = renderCvHtml(master, { highlight: ["AWS"] });
  test("CSP meta first in head", () => {
    expect(html).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  });
  test("French labels", () => {
    for (const l of ["Profil", "Certifications", "Expérience professionnelle", "Compétences techniques", "Langues"]) expect(html).toContain(l);
  });
  test("escapes everything", () => {
    expect(html).toContain("Jean &lt;Dupont&gt;");
    expect(html).toContain("Acme &amp; Co");
    expect(html).not.toContain("<Dupont>");
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
  test("highlight bold, no images, @page", () => {
    expect(html).toContain("<b>AWS</b>");
    expect(html).not.toContain("<b>Go</b>");
    expect(html).not.toContain("<img");
    expect(html).toContain("@page");
  });
  test("linkedin only if https", () => {
    expect(html).toContain("https://linkedin.com/in/jd");
    const bad = { ...master, header: { ...master.header, linkedin: "javascript:alert(1)" } } as CvMaster;
    expect(renderCvHtml(bad)).not.toContain("javascript:");
  });
});
