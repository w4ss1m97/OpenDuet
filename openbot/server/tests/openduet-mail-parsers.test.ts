import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../src/openduet/items/classify";
import {
  MAIL_QUERY,
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
  expect(item?.amount).toBeUndefined();
  expect(item?.dueAt?.toISOString()).toBe("2026-11-24T23:00:00.000Z");
  if (!item) throw new Error("no item");
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

test("MAIL_QUERY names every sender family", () => {
  for (const sender of ["malt.fr", "free-work.com", "collective.work", "linkedin.com", "antai.gouv.fr", "facture"]) {
    expect(MAIL_QUERY).toContain(sender);
  }
});
