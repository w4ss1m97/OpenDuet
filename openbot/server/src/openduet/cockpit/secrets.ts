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

const CONTENT_PATTERNS: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
];

/** True when the text holds something that looks like a credential: the caller drops the whole file. */
export function containsSecret(text: string): boolean {
  return CONTENT_PATTERNS.some((p) => p.test(text));
}
