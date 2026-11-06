import { expect, test } from "bun:test";
import { hardFilter, isIdf } from "../src/openduet/job-offers/filter";

const base = { contract: "freelance", rateUnit: "day", tjmMin: 600, tjmMax: 700, remote: "onsite", location: "Paris" } as const;
const f = (o: Record<string, unknown>) => hardFilter({ ...base, ...o } as never);

test("kept offer", () => expect(f({})).toEqual({ status: "new", filterReason: null, tjmUnknown: false }));
test("salaried contract or yearly rate", () => {
  expect(f({ contract: "salaried" }).filterReason).toBe("salaried");
  expect(f({ rateUnit: "year", tjmMax: 60000 }).filterReason).toBe("salaried");
  expect(f({ contract: "salaried", tjmMax: 100 }).filterReason).toBe("salaried");
});
test("low tjm uses max, then min, hour x 7", () => {
  expect(f({ tjmMin: 300, tjmMax: 450 })).toMatchObject({ status: "filtered", filterReason: "low_tjm" });
  expect(f({ tjmMin: 300, tjmMax: 600 }).status).toBe("new");
  expect(f({ tjmMin: 450, tjmMax: null }).filterReason).toBe("low_tjm");
  expect(f({ rateUnit: "hour", tjmMin: 60, tjmMax: 60 }).filterReason).toBe("low_tjm");
  expect(f({ rateUnit: "hour", tjmMin: 80, tjmMax: 80 }).status).toBe("new");
});
test("unknown tjm kept and flagged", () => {
  expect(f({ tjmMin: null, tjmMax: null })).toEqual({ status: "new", filterReason: null, tjmUnknown: true });
  expect(f({ rateUnit: "unknown", tjmMin: 300, tjmMax: 300 }).tjmUnknown).toBe(true);
});
test("outside IDF only for onsite/hybrid with known location", () => {
  expect(f({ location: "Lyon" }).filterReason).toBe("outside_idf");
  expect(f({ remote: "hybrid", location: "Toulouse" }).filterReason).toBe("outside_idf");
  expect(f({ remote: "full", location: "Lyon" }).status).toBe("new");
  expect(f({ location: null }).status).toBe("new");
  expect(f({ remote: "unknown", location: "Lyon" }).status).toBe("new");
  expect(f({ location: "La Défense" }).status).toBe("new");
});
test("first match wins: salaried before low tjm before location", () => {
  expect(f({ contract: "salaried", location: "Lyon" }).filterReason).toBe("salaried");
  expect(f({ tjmMax: 300, location: "Lyon" }).filterReason).toBe("low_tjm");
});
test("isIdf", () => {
  for (const l of ["Paris", "Paris 8e", "Île-de-France", "IDF", "Ile de France", "75008 Paris", "92100 Boulogne", "91300 Massy", "95000", "77000 Melun", "78000", "Issy-les-Moulineaux", "Saint-Denis", "Vélizy", "Créteil", "Saclay"])
    expect(isIdf(l)).toBe(true);
  for (const l of ["Lyon", "69000 Lyon", "Marseille", "Lille", "Nantes", "33000 Bordeaux", "Remote"]) expect(isIdf(l)).toBe(false);
});
