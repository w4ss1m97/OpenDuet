/*
 * What the project explorer must never read, and what it drops after reading. Shared with other
 * cockpit readers: one list, so a new reader cannot forget a pattern.
 */

const KEY_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "crt", "cer", "der", "mobileprovision"]);
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg"]);
const EXACT_NAMES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", "google-services.json", "googleservice-info.plist",
]);
const NAME_PREFIXES = [".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "credentials", "secrets", "service-account"];

/** True for a repo-relative path whose content the cockpit must not read (name only, case-insensitive). */
export function isNeverRead(path: string): boolean {
  const segments = path.split("/").map((s) => s.toLowerCase());
  const name = segments[segments.length - 1] ?? "";
  if (segments.slice(0, -1).some((s) => SECRET_DIRS.has(s))) return true;
  if (EXACT_NAMES.has(name) || name.includes(".tfstate")) return true;
  if (NAME_PREFIXES.some((p) => name.startsWith(p))) {
    if (name.startsWith("service-account")) return name.endsWith(".json");
    return true;
  }
  const dot = name.lastIndexOf(".");
  return dot > 0 && KEY_EXTENSIONS.has(name.slice(dot + 1));
}

export type SecretSeverity = "high" | "medium";
export type SecretPattern = { type: string; severity: SecretSeverity; re: RegExp };

/** Every credential shape the cockpit looks for. Order matters: the first match on a line names it. */
export const SECRET_PATTERNS: SecretPattern[] = [
  { type: "private key", severity: "high", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { type: "AWS access key id", severity: "high", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: "GCP service-account key", severity: "high", re: /"private_key_id"\s*:\s*"[0-9a-f]{20,}"/ },
  { type: "GCP API key", severity: "medium", re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { type: "Stripe live key", severity: "high", re: /\b[sr]k_live_[0-9A-Za-z]{20,}/ },
  { type: "GitHub token", severity: "high", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { type: "Telegram bot token", severity: "high", re: /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/ },
  { type: "Slack token", severity: "high", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { type: "Anthropic API key", severity: "high", re: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { type: "API key (sk-)", severity: "high", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
];

/** True when the text holds something that looks like a credential: the caller drops the whole file. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.re.test(text));
}

const MAX_LINE_CHARS = 2000;

/** Where credential-looking text sits: line number, pattern type and severity. The matched text is never returned. */
export function findSecretLines(text: string): Array<{ line: number; type: string; severity: SecretSeverity }> {
  const hits: Array<{ line: number; type: string; severity: SecretSeverity }> = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > MAX_LINE_CHARS) continue;
    const found = SECRET_PATTERNS.find((p) => p.re.test(line));
    if (found) hits.push({ line: i + 1, type: found.type, severity: found.severity });
  }
  return hits;
}
