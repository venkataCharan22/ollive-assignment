import type { ProviderName } from "@ollive/llm-sdk";

export interface ModelOption {
  provider: ProviderName;
  model: string;
  label: string;
  envKey?: string; // env var that must be set for this provider
}

/**
 * Catalogue surfaced in the UI model picker. Real deployments would pull this
 * from a config service. The `envKey` field is consulted server-side to
 * decide whether the model is available given the current env.
 */
export const MODELS: ModelOption[] = [
  { provider: "openai", model: "gpt-4o-mini", label: "OpenAI · gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  { provider: "openai", model: "gpt-4o", label: "OpenAI · gpt-4o", envKey: "OPENAI_API_KEY" },
  { provider: "anthropic", model: "claude-3-5-sonnet-latest", label: "Anthropic · claude-3.5-sonnet", envKey: "ANTHROPIC_API_KEY" },
  { provider: "anthropic", model: "claude-3-5-haiku-latest", label: "Anthropic · claude-3.5-haiku", envKey: "ANTHROPIC_API_KEY" },
  { provider: "google", model: "gemini-1.5-flash", label: "Google · gemini-1.5-flash", envKey: "GOOGLE_API_KEY" },
  { provider: "google", model: "gemini-1.5-pro", label: "Google · gemini-1.5-pro", envKey: "GOOGLE_API_KEY" },
  { provider: "groq", model: "llama-3.3-70b-versatile", label: "Groq · Llama 3.3 70B", envKey: "GROQ_API_KEY" },
  { provider: "groq", model: "llama-3.1-8b-instant", label: "Groq · Llama 3.1 8B (fastest)", envKey: "GROQ_API_KEY" },
  { provider: "groq", model: "mixtral-8x7b-32768", label: "Groq · Mixtral 8x7B", envKey: "GROQ_API_KEY" },
  { provider: "groq", model: "gemma2-9b-it", label: "Groq · Gemma 2 9B", envKey: "GROQ_API_KEY" },
  { provider: "mock", model: "mock-fast", label: "Mock · fast (no key needed)" },
  { provider: "mock", model: "mock-error", label: "Mock · always-errors (for testing the dashboard)" },
];

export function availableModels(): ModelOption[] {
  return MODELS.filter((m) => !m.envKey || !!process.env[m.envKey] || m.provider === "mock");
}

export function apiKeyFor(provider: ProviderName): string | undefined {
  switch (provider) {
    case "openai": return process.env.OPENAI_API_KEY;
    case "anthropic": return process.env.ANTHROPIC_API_KEY;
    case "google": return process.env.GOOGLE_API_KEY;
    case "groq": return process.env.GROQ_API_KEY;
    case "mock": return undefined;
  }
}
