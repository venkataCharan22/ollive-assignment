/**
 * PII redaction. Runs before logs leave the SDK so sensitive content never
 * hits the ingestion service. The ingestion worker applies the same rules
 * defensively (defense-in-depth: an old SDK or a misconfigured client
 * shouldn't be able to leak raw PII into the database).
 *
 * Coverage is deliberately conservative — high-confidence patterns only.
 * Aggressive redaction in an LLM context destroys the very content we need
 * to debug a bad response. The right place for stricter policy is a
 * downstream redaction service (Presidio, custom NER).
 */

const PATTERNS: Array<{ name: string; re: RegExp; tag: string }> = [
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    tag: "[REDACTED_EMAIL]",
  },
  {
    // E.164-ish + common separators. Requires 10+ digits to avoid false positives.
    name: "phone",
    re: /(?<!\d)(\+?\d{1,3}[ -]?)?(\(?\d{3}\)?[ -]?)?\d{3}[ -]?\d{4}(?!\d)/g,
    tag: "[REDACTED_PHONE]",
  },
  {
    // Visa/MC/Amex/Discover-ish. 13-19 digits with optional spaces/dashes.
    name: "credit_card",
    re: /\b(?:\d[ -]*?){13,19}\b/g,
    tag: "[REDACTED_CC]",
  },
  {
    // US SSN. Indian Aadhaar (12 digits) is covered by the long-number CC rule.
    name: "ssn",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    tag: "[REDACTED_SSN]",
  },
  {
    // Common API key shapes. Catches sk-..., key-..., bearer tokens.
    name: "api_key",
    re: /\b(sk|pk|api|key|token|bearer)[-_][A-Za-z0-9]{20,}\b/gi,
    tag: "[REDACTED_KEY]",
  },
];

export interface RedactionStats {
  /** Total replacements made, keyed by pattern name. */
  counts: Record<string, number>;
}

export function redact(input: string, enabled = true): { text: string; stats: RedactionStats } {
  if (!enabled || !input) return { text: input, stats: { counts: {} } };
  const counts: Record<string, number> = {};
  let out = input;
  for (const { name, re, tag } of PATTERNS) {
    let n = 0;
    out = out.replace(re, () => {
      n += 1;
      return tag;
    });
    if (n > 0) counts[name] = n;
  }
  return { text: out, stats: { counts } };
}

export function redactMessages<T extends { content: string }>(
  messages: T[],
  enabled = true,
): { messages: T[]; stats: RedactionStats } {
  const aggregate: Record<string, number> = {};
  const out = messages.map((m) => {
    const { text, stats } = redact(m.content, enabled);
    for (const [k, v] of Object.entries(stats.counts)) {
      aggregate[k] = (aggregate[k] ?? 0) + v;
    }
    return { ...m, content: text };
  });
  return { messages: out, stats: { counts: aggregate } };
}

export function preview(text: string, max = 500): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
