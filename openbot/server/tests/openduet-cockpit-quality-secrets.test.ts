import { describe, expect, test } from "bun:test";
import { SECRET_PATTERNS, containsSecret, findSecretLines } from "../src/openduet/cockpit/secrets";

const AKIA = `${"AKIA"}${"A".repeat(16)}`;
const GHP = `${"ghp"}_${"a".repeat(40)}`;

describe("secret patterns", () => {
  test("one list of {type, severity, re}", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(10);
    for (const p of SECRET_PATTERNS) {
      expect(typeof p.type).toBe("string");
      expect(["high", "medium"]).toContain(p.severity);
      expect(p.re).toBeInstanceOf(RegExp);
      expect(p.re.global).toBe(false);
    }
  });

  test("line numbers and types, never the match text", () => {
    const text = `ok\nkey=${AKIA}\n\n"private_key_id": "${"a".repeat(24)}"\nx ${"AIza"}${"B".repeat(35)}\n`;
    const hits = findSecretLines(text);
    expect(hits).toEqual([
      { line: 2, type: "AWS access key id", severity: "high" },
      { line: 4, type: "GCP service-account key", severity: "high" },
      { line: 5, type: "GCP API key", severity: "medium" },
    ]);
    expect(JSON.stringify(hits)).not.toContain(AKIA);
  });

  test("first pattern per line wins", () => {
    const hits = findSecretLines(`${AKIA} ${GHP}`);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.type).toBe("AWS access key id");
    expect(findSecretLines(`${"sk-ant"}-${"a".repeat(30)}`)[0]!.type).toBe("Anthropic API key");
    expect(findSecretLines(`${"sk"}-${"a".repeat(30)}`)[0]!.type).toBe("API key (sk-)");
  });

  test("python-only patterns are present", () => {
    expect(findSecretLines(`${"sk"}_live_${"a".repeat(24)}`)[0]!.type).toBe("Stripe live key");
    expect(findSecretLines(`1234567890:AA${"a".repeat(33)}`)[0]!.type).toBe("Telegram bot token");
    expect(findSecretLines("-----BEGIN OPENSSH PRIVATE KEY-----")[0]!.type).toBe("private key");
  });

  test("lines over 2000 characters are skipped; CRLF counted once", () => {
    expect(findSecretLines(`${"x".repeat(2001)}${AKIA}`)).toEqual([]);
    expect(findSecretLines(`a\r\nb\r\n${AKIA}`)[0]!.line).toBe(3);
  });

  test("containsSecret still catches the explorer cases", () => {
    for (const t of [
      "-----BEGIN RSA PRIVATE KEY-----", AKIA, `${"ghp"}_${"a".repeat(30)}`, `${"github_pat"}_${"a".repeat(30)}`,
      `${"sk-ant"}-${"a".repeat(20)}`, `${"sk"}-${"a".repeat(30)}`, `${"xoxb"}-${"1".repeat(12)}`, `${"AIza"}${"c".repeat(35)}`,
    ]) expect(containsSecret(t)).toBe(true);
    expect(containsSecret("just some text")).toBe(false);
  });
});
