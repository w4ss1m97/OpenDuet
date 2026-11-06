import { expect, test } from "bun:test";
import { isOfferSource, platformOf } from "../src/openduet/job-offers/sources";

const mail = (from: string, subject: string, snippet = "") => ({ from, subject, snippet });

test("platformOf maps sender domains, subdomains included", () => {
  expect(platformOf("Malt <no-reply@malt.fr>")).toBe("malt");
  expect(platformOf("hello@mail.malt.com")).toBe("malt");
  expect(platformOf("Free-Work <alerts@free-work.com>")).toBe("free-work");
  expect(platformOf("Collective <hi@collective.work>")).toBe("collective");
  expect(platformOf("x@notmalt.fr")).toBeNull();
  expect(platformOf("x@linkedin.com")).toBeNull();
});

test("isOfferSource needs a platform sender and an offer subject", () => {
  expect(isOfferSource(mail("Malt <a@malt.fr>", "Nouvelles missions pour vous"))).toBe(true);
  expect(isOfferSource(mail("a@free-work.com", "Votre alerte emploi"))).toBe(true);
  expect(isOfferSource(mail("a@collective.work", "Nouveau projet : data engineer"))).toBe(true);
  expect(isOfferSource(mail("a@gmail.com", "Nouvelles missions pour vous"))).toBe(false);
  expect(isOfferSource(mail("a@malt.fr", "Votre facture"))).toBe(false);
});

test("isOfferSource refuses conversations", () => {
  expect(isOfferSource(mail("a@malt.fr", "Nouveau projet", "Acme vous a écrit"))).toBe(false);
  expect(isOfferSource(mail("a@malt.fr", "Proposition de projet : entretien demain"))).toBe(false);
  expect(isOfferSource(mail("a@free-work.com", "Alerte", "Une candidature a répondu"))).toBe(false);
});
