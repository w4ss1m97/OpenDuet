import { describe, expect, test } from "bun:test";
import { draftMessage } from "../src/plugins/google-workspace-rest";

/** The pure message builder behind gmail_create_draft: headers, threading, and the PDF part. */

/** Headers unfolded and lowercased, plus everything after the blank line. */
function split(raw: string): { headers: Map<string, string>; rest: string } {
  const at = raw.indexOf("\r\n\r\n");
  const headers = new Map<string, string>();
  for (const line of raw
    .slice(0, at)
    .replace(/\r\n[ \t]+/g, " ")
    .split("\r\n")) {
    const colon = line.indexOf(":");
    headers.set(
      line.slice(0, colon).toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return { headers, rest: raw.slice(at + 4) };
}

const base = {
  to: ["Ana Pereira <ana@hearthandco.com>"],
  cc: [] as string[],
  subject: "Candidature freelance",
  body: "Bonjour,\nVoici ma candidature.",
};

describe("draftMessage without an attachment", () => {
  test("is a base64 text/plain message with plain headers", () => {
    const { headers, rest } = split(draftMessage(base));
    expect(headers.get("to")).toBe("Ana Pereira <ana@hearthandco.com>");
    expect(headers.has("cc")).toBe(false);
    expect(headers.get("subject")).toBe("Candidature freelance");
    expect(headers.get("mime-version")).toBe("1.0");
    expect(headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(headers.get("content-transfer-encoding")).toBe("base64");
    expect(headers.has("in-reply-to")).toBe(false);
    expect(Buffer.from(rest, "base64").toString("utf8")).toBe(
      "Bonjour,\r\nVoici ma candidature.",
    );
  });

  test("an empty recipient list writes no To header", () => {
    const { headers } = split(draftMessage({ ...base, to: [] }));
    expect(headers.has("to")).toBe(false);
  });

  test("a subject outside ASCII is encoded and decodes back", () => {
    const { headers } = split(
      draftMessage({ ...base, subject: "Relance — développeur ☕" }),
    );
    const subject = headers.get("subject") ?? "";
    expect(subject).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = subject
      .split(" ")
      .map((word) =>
        Buffer.from(word.replace(/^=\?UTF-8\?B\?|\?=$/g, ""), "base64").toString(
          "utf8",
        ),
      )
      .join("");
    expect(decoded).toBe("Relance — développeur ☕");
  });
});

describe("draftMessage in a thread", () => {
  test("prefixes Re:, and chains In-Reply-To and References", () => {
    const { headers } = split(
      draftMessage({
        ...base,
        subject: "Relance",
        parent: {
          messageId: "<n01@hearthandco.com>",
          references: "<earlier@hearthandco.com>",
        },
      }),
    );
    expect(headers.get("subject")).toBe("Re: Relance");
    expect(headers.get("in-reply-to")).toBe("<n01@hearthandco.com>");
    expect(headers.get("references")).toBe(
      "<earlier@hearthandco.com> <n01@hearthandco.com>",
    );
  });

  test("a subject already saying Re: is kept, and the chain falls back to In-Reply-To", () => {
    const { headers } = split(
      draftMessage({
        ...base,
        subject: "RE: Relance",
        parent: {
          messageId: "<n02@x.com>",
          inReplyTo: "<n01@x.com>",
        },
      }),
    );
    expect(headers.get("subject")).toBe("RE: Relance");
    expect(headers.get("references")).toBe("<n01@x.com> <n02@x.com>");
  });
});

describe("draftMessage with a PDF", () => {
  const pdf = Buffer.alloc(300, 7);
  const withPdf = () =>
    draftMessage({
      ...base,
      attachment: {
        filename: "CV-Wassim.pdf",
        mimeType: "application/pdf",
        contentBase64: pdf.toString("base64"),
      },
    });

  test("is multipart/mixed with a duet- boundary that no part contains", () => {
    const { headers, rest } = split(withPdf());
    const type = headers.get("content-type") ?? "";
    const boundary = /boundary="([^"]+)"/.exec(type)?.[1] ?? "";
    expect(type).toStartWith("multipart/mixed;");
    expect(boundary).toMatch(/^duet-[0-9a-f-]{36}$/);
    const parts = rest.split(`--${boundary}`);
    // preamble, text part, pdf part, closing "--"
    expect(parts).toHaveLength(4);
    expect(parts[3].trim()).toBe("--");
    expect(parts[1]).not.toContain(`${boundary}x`);
  });

  test("the text part is base64 UTF-8 and the PDF part carries filename and 76-char lines", () => {
    const { headers, rest } = split(withPdf());
    const boundary =
      /boundary="([^"]+)"/.exec(headers.get("content-type") ?? "")?.[1] ?? "";
    const [, text, file] = rest.split(`--${boundary}`);
    const textPart = split(text.replace(/^\r\n/, ""));
    expect(textPart.headers.get("content-type")).toBe(
      "text/plain; charset=UTF-8",
    );
    expect(
      Buffer.from(textPart.rest.trim(), "base64").toString("utf8"),
    ).toBe("Bonjour,\r\nVoici ma candidature.");

    const filePart = split(file.replace(/^\r\n/, ""));
    expect(filePart.headers.get("content-type")).toBe(
      'application/pdf; name="CV-Wassim.pdf"',
    );
    expect(filePart.headers.get("content-disposition")).toBe(
      'attachment; filename="CV-Wassim.pdf"',
    );
    expect(filePart.headers.get("content-transfer-encoding")).toBe("base64");
    const lines = filePart.rest.trim().split("\r\n");
    expect(lines.every((line) => line.length <= 76)).toBe(true);
    expect(lines[0]).toHaveLength(76);
    expect(Buffer.from(lines.join(""), "base64").equals(pdf)).toBe(true);
  });
});
