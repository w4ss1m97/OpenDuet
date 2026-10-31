import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../src/openduet/items/classify";
import {
  MAIL_QUERIES,
  type MailMessage,
  parseAmount,
  parseMail,
} from "../src/openduet/items/mail-parsers";

function fixture(name: string): MailMessage {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures/duet-mail", `${name}.json`), "utf8"),
  );
}

test("Malt message is a followup in missions, without a date", () => {
  const item = parseMail(fixture("malt"));
  expect(item).toMatchObject({
    kind: "followup",
    channelId: "missions",
    sourceApp: "gmail",
    sourceHash: "gmail:m-malt-1",
    sourceLink: "https://mail.google.com/mail/u/0/#all/m-malt-1",
    dateExplicit: false,
  });
  expect(item?.why).toContain("Malt");
});

test("Malt interview with date and time is an active interview", () => {
  const item = parseMail(fixture("malt-interview"));
  expect(item?.kind).toBe("interview");
  expect(item?.dueAt?.toISOString()).toBe("2026-11-12T13:00:00.000Z");
  expect(item?.allDay).toBe(false);
  expect(item?.dateExplicit).toBe(true);
  if (!item) throw new Error("no item");
  expect(classify(item)).toBe("active");
});

test("Free-Work and Collective are followups in missions", () => {
  expect(parseMail(fixture("free-work"))).toMatchObject({ kind: "followup", channelId: "missions" });
  expect(parseMail(fixture("collective"))).toMatchObject({ kind: "followup", channelId: "missions" });
});

test("LinkedIn direct message is a followup, job alerts are ignored", () => {
  expect(parseMail(fixture("linkedin"))).toMatchObject({ kind: "followup", channelId: "missions" });
  expect(parseMail(fixture("linkedin-jobs"))).toBeNull();
});

test("bill with amount and due date is an active bill in maison", () => {
  const item = parseMail(fixture("bill"));
  expect(item).toMatchObject({ kind: "bill", channelId: "maison", amount: 1234.56, allDay: true });
  expect(item?.dueAt?.toISOString()).toBe("2026-11-19T23:00:00.000Z");
  if (!item) throw new Error("no item");
  expect(classify(item)).toBe("active");
});

test("bill with unreadable amount has no amount and stays proposed", () => {
  const item = parseMail(fixture("bill-no-amount"));
  expect(item?.kind).toBe("bill");
  if (!item) throw new Error("no item");
  expect(item.amount).toBeUndefined();
  expect(item.dueAt?.toISOString()).toBe("2026-11-24T23:00:00.000Z");
  expect(classify(item)).toBe("proposed");
});

test("ANTAI notice is a fine with its amount and deadline", () => {
  const item = parseMail(fixture("antai"));
  expect(item).toMatchObject({ kind: "fine", amount: 135, dateExplicit: true });
  expect(item?.dueAt?.toISOString()).toBe("2026-11-20T23:00:00.000Z");
});

test("unrelated returns null", () => {
  expect(parseMail(fixture("unrelated"))).toBeNull();
});

test("parses French amounts", () => {
  expect(parseAmount("Total 1 234,56 € TTC")).toBe(1234.56);
  expect(parseAmount("Montant : 45€")).toBe(45);
  expect(parseAmount("45,00 EUR")).toBe(45);
  expect(parseAmount("1 050,00 €")).toBe(1050);
  expect(parseAmount("TJM à discuter")).toBeUndefined();
});

test("a day without a year takes the next occurrence after the message", () => {
  const item = parseMail({
    ...fixture("bill"),
    date: "2026-12-28T07:00:00.000Z",
    snippet: "Montant : 30 € à payer avant le 05/01.",
  });
  expect(item?.dueAt?.toISOString()).toBe("2027-01-04T23:00:00.000Z");
});

test("MAIL_QUERIES is one simple query per sender family, no OR or grouping", () => {
  for (const sender of ["from:malt.fr", "from:free-work.com", "from:collective.work", "from:linkedin.com", "from:antai.gouv.fr", "subject:facture"]) {
    expect(MAIL_QUERIES).toContain(sender);
  }
  for (const query of MAIL_QUERIES) expect(query).not.toMatch(/\bOR\b|[()]/);
});

test("an email whose date does not parse still yields an item", () => {
  const item = parseMail({ ...fixture("bill"), date: "" });
  expect(item).not.toBeNull();
  if (!item) throw new Error("no item");
  expect(item.dueAt?.toISOString()).toBe("2026-11-19T23:00:00.000Z");
});

test("amounts written ambiguously are not read", () => {
  expect(parseAmount("Total 1.234,56 €")).toBe(1234.56);
  expect(parseAmount("45,5 €")).toBeUndefined();
  expect(parseAmount("Remboursement -45 €")).toBeUndefined();
  expect(parseAmount("Montant 12345,00 €")).toBe(12345);
});

test("a bill takes the date after 'avant le', not the first date", () => {
  const item = parseMail({
    ...fixture("bill"),
    date: "2026-10-30T07:00:00.000Z",
    snippet: "Votre facture du 15/10 : 45 € à payer avant le 20/11.",
  });
  if (!item) throw new Error("no item");
  expect(item.dueAt?.toISOString()).toBe("2026-11-19T23:00:00.000Z");
  expect(item.dateExplicit).toBe(true);
});

test("a recent past day without a year stays in this year", () => {
  const item = parseMail({
    ...fixture("malt-interview"),
    date: "2026-10-30T07:00:00.000Z",
    snippet: "Retour sur votre entretien du 28/10/2026 à 10h.",
  });
  if (!item) throw new Error("no item");
  expect(item.dueAt?.toISOString()).toBe("2026-10-28T09:00:00.000Z");
  const noYear = parseMail({
    ...fixture("malt-interview"),
    date: "2026-10-30T07:00:00.000Z",
    snippet: "Retour sur votre entretien du 28/10 à 10h.",
  });
  expect(noYear?.dueAt?.toISOString()).toBe("2026-10-28T09:00:00.000Z");
});

test("several dates without a due keyword leave the date unconfirmed", () => {
  const item = parseMail({
    ...fixture("malt-interview"),
    snippet: "Entretien le 12/11/2026 à 14h ou le 13/11/2026 à 10h, à confirmer.",
  });
  expect(item?.dateExplicit).toBe(false);
});

test("impossible days and hours are not dates", () => {
  for (const snippet of ["Entretien le 12/11/2026 à 25h", "Entretien le 31/02/2026 à 10h"]) {
    const item = parseMail({ ...fixture("malt-interview"), snippet });
    expect(item?.dateExplicit).toBe(false);
  }
});
