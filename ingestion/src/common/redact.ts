/**
 * Defense-in-depth redaction inside the ingestion worker. The SDK already
 * redacts on the client side; this guarantees a buggy or out-of-date SDK
 * can't leak raw PII into the database.
 *
 * Patterns are deliberately kept identical to the SDK's. If we wanted
 * different policy server-side (e.g. stricter), we'd version the rules.
 */

const PATTERNS: Array<{ name: string; re: RegExp; tag: string }> = [
  { name: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, tag: "[REDACTED_EMAIL]" },
  { name: "phone", re: /(?<!\d)(\+?\d{1,3}[ -]?)?(\(?\d{3}\)?[ -]?)?\d{3}[ -]?\d{4}(?!\d)/g, tag: "[REDACTED_PHONE]" },
  { name: "credit_card", re: /\b(?:\d[ -]*?){13,19}\b/g, tag: "[REDACTED_CC]" },
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g, tag: "[REDACTED_SSN]" },
  { name: "api_key", re: /\b(sk|pk|api|key|token|bearer)[-_][A-Za-z0-9]{20,}\b/gi, tag: "[REDACTED_KEY]" },
];

export function redactText(input: string | null | undefined, enabled: boolean): string {
  if (!enabled || !input) return input ?? "";
  let out = input;
  for (const { re, tag } of PATTERNS) out = out.replace(re, tag);
  return out;
}
