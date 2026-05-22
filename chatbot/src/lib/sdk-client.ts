import { OlliveClient, type ProviderName } from "@ollive/llm-sdk";
import { apiKeyFor } from "./providers";

const INGESTION_URL = process.env.INGESTION_URL ?? "http://localhost:4000";
const INGESTION_KEY = process.env.INGESTION_API_KEY ?? "dev-ingest-key-change-me";
const REDACT = (process.env.PII_REDACTION ?? "true") !== "false";

/**
 * Builds a per-request OlliveClient. We don't memoise because the provider
 * changes per-call (one chat might use OpenAI, the next Anthropic) and the
 * cost of construction is trivial (the heavy lifting is on the first network
 * request inside each provider SDK).
 */
export function makeClient(provider: ProviderName): OlliveClient {
  return new OlliveClient({
    provider,
    apiKey: apiKeyFor(provider),
    ingestion: { url: INGESTION_URL, apiKey: INGESTION_KEY },
    redact: REDACT,
  });
}
