import { expect, test } from "bun:test";
import { parseMaster } from "../src/openduet/job-offers/cv-schema";
import { cvMasterFixture } from "./fixtures/cv-master";

const clone = () => structuredClone(cvMasterFixture);

test("a realistic master is accepted", () => {
  expect(parseMaster(cvMasterFixture).header.name).toBe("Wassim Suilah");
});

test("a bad slug is rejected", () => {
  const cv = clone();
  cv.experiences[0].id = "Bad Slug";
  expect(() => parseMaster(cv)).toThrow();
});

test("a duplicate id across experiences and bullets is rejected", () => {
  const cv = clone();
  cv.experiences[1].bullets[0].id = cv.experiences[0].id;
  expect(() => parseMaster(cv)).toThrow();
  const cv2 = clone();
  cv2.skills[0].id = "acme-api";
  expect(() => parseMaster(cv2)).toThrow();
});

test("an http linkedin is rejected", () => {
  const cv = clone();
  cv.header.linkedin = "http://www.linkedin.com/in/x";
  expect(() => parseMaster(cv)).toThrow();
});

test("an oversize master is rejected", () => {
  const cv = clone();
  cv.certifications = [];
  cv.experiences = Array.from({ length: 12 }, (_, i) => ({
    ...clone().experiences[0],
    id: `exp-${i}`,
    context: "x".repeat(600),
    bullets: Array.from({ length: 12 }, (_, j) => ({ id: `e${i}-b${j}`, text: "y".repeat(300) })),
    environment: Array.from({ length: 30 }, (_, k) => "z".repeat(60) + k).map((s) => s.slice(0, 60)),
  }));
  expect(() => parseMaster(cv)).toThrow("master_too_large");
});
