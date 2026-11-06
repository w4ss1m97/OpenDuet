import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  type FakeGoogle,
  startFakeGoogle,
} from "../../scripts/fake-google/server";
import { callTool } from "../src/plugins/google-workspace-rest";

/** gmail_create_draft against the fake Google, over a real socket. */

let fake: FakeGoogle;
let connection: { url: string; token: string };

beforeAll(async () => {
  fake = startFakeGoogle({ port: 0 });
  // The fake consents automatically; any token it issued will do.
  const consent = await fetch(
    `${fake.url}/o/oauth2/v2/auth?redirect_uri=http://127.0.0.1:3001/cb`,
    { redirect: "manual" },
  );
  const code = new URL(consent.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  const tokens = await (
    await fetch(`${fake.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: "c",
        client_secret: "s",
        redirect_uri: "http://127.0.0.1:3001/cb",
      }),
    })
  ).json();
  connection = { url: fake.url, token: tokens.access_token };
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(async () => {
  await fetch(`${fake.url}/__fake/reset`, { method: "POST" });
});

const drafts = async () =>
  (await (await fetch(`${fake.url}/__fake/drafts`)).json()) as {
    id: string;
    messageId: string;
    threadId: string;
    to: string[];
    cc: string[];
    subject: string;
    body: string;
    inReplyTo: string | null;
    references: string | null;
    attachments: { filename: string; mimeType: string; contentBase64: string }[];
  }[];
const sent = async () =>
  (await (await fetch(`${fake.url}/__fake/sent`)).json()) as unknown[];

const draft = {
  to: ["ana@hearthandco.com"],
  subject: "Candidature",
  body: "Bonjour,\nMa candidature.",
};

describe("gmail_create_draft", () => {
  test("an unthreaded draft is stored in the fake and nothing is sent", async () => {
    const result = await callTool(connection, "gmail_create_draft", draft);
    expect(result.isError).toBe(false);
    const out = JSON.parse(result.text);
    expect(out.draft).toBe(true);
    expect(out.id).toBeString();
    expect(out.messageId).toBeString();
    expect(out.threadId).toBeString();
    const stored = await drafts();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(out.id);
    expect(stored[0].to).toEqual(["ana@hearthandco.com"]);
    expect(stored[0].subject).toBe("Candidature");
    expect(stored[0].body).toBe("Bonjour,\nMa candidature.");
    expect(await sent()).toEqual([]);
  });

  test("a threaded draft reads the thread and replies to its last message", async () => {
    const delivered = await (
      await fetch(`${fake.url}/__fake/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "Ana Ruiz <ana@example.com>",
          subject: "Mission data",
          body: "Salut",
        }),
      })
    ).json();
    const result = await callTool(connection, "gmail_create_draft", {
      ...draft,
      subject: "Relance",
      threadId: delivered.threadId,
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).threadId).toBe(delivered.threadId);
    const [stored] = await drafts();
    expect(stored.subject).toBe("Re: Relance");
    expect(stored.inReplyTo).toMatch(/^<.+@example\.com>$/);
    expect(stored.references).toContain(stored.inReplyTo ?? "?");
    expect(stored.threadId).toBe(delivered.threadId);
    expect(await sent()).toEqual([]);
  });

  test("a line break in a recipient, the subject or the filename is refused with no request", async () => {
    const before = (await drafts()).length;
    const pdf = Buffer.from("%PDF-1.4 x").toString("base64");
    for (const args of [
      { ...draft, to: ["a@x.com\r\nBcc: z@y.com"] },
      { ...draft, cc: ["a@x.com\nBcc: z@y.com"] },
      { ...draft, subject: "Hi\r\nBcc: z@y.com" },
      {
        ...draft,
        attachment: {
          filename: "a\r\nb.pdf",
          mimeType: "application/pdf",
          contentBase64: pdf,
        },
      },
    ]) {
      const result = await callTool(connection, "gmail_create_draft", args);
      expect(result.isError).toBe(true);
    }
    expect(await drafts()).toHaveLength(before);
  });

  test("bad addresses, empty or oversized bodies are refused", async () => {
    for (const args of [
      { ...draft, to: ["not-an-address"] },
      { ...draft, body: "   " },
      { ...draft, body: "x".repeat(20_001) },
      { ...draft, subject: "" },
    ]) {
      expect((await callTool(connection, "gmail_create_draft", args)).isError).toBe(
        true,
      );
    }
    expect(await drafts()).toEqual([]);
  });

  test("an empty recipient list is allowed", async () => {
    const result = await callTool(connection, "gmail_create_draft", {
      ...draft,
      to: [],
    });
    expect(result.isError).toBe(false);
    expect((await drafts())[0].to).toEqual([]);
  });

  test("a PDF is attached; a non-PDF, a bad filename or an oversized file is refused", async () => {
    const pdf = Buffer.from("%PDF-1.4 hello");
    const ok = await callTool(connection, "gmail_create_draft", {
      ...draft,
      attachment: {
        filename: "CV-Wassim.pdf",
        mimeType: "application/pdf",
        contentBase64: pdf.toString("base64"),
      },
    });
    expect(ok.isError).toBe(false);
    const [stored] = await drafts();
    expect(stored.attachments).toHaveLength(1);
    expect(stored.attachments[0].filename).toBe("CV-Wassim.pdf");
    expect(
      Buffer.from(stored.attachments[0].contentBase64, "base64").equals(pdf),
    ).toBe(true);

    const bad = [
      { filename: "a.pdf", mimeType: "text/html", contentBase64: "aGk=" },
      { filename: "../a.pdf", mimeType: "application/pdf", contentBase64: "aGk=" },
      {
        filename: "big.pdf",
        mimeType: "application/pdf",
        contentBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
      },
    ];
    for (const attachment of bad) {
      expect(
        (await callTool(connection, "gmail_create_draft", { ...draft, attachment }))
          .isError,
      ).toBe(true);
    }
    expect(await drafts()).toHaveLength(1);
  });

  test("a thread that does not exist is refused and nothing is stored", async () => {
    const result = await callTool(connection, "gmail_create_draft", {
      ...draft,
      threadId: "nope",
    });
    expect(result.isError).toBe(true);
    expect(await drafts()).toEqual([]);
  });

  test("messages/send is never reached", async () => {
    await callTool(connection, "gmail_create_draft", draft);
    expect(await sent()).toEqual([]);
  });
});
