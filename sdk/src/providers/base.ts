import type { ChatMessage, ChatResponse, ProviderName, TokenUsage } from "../types";

export interface ProviderChatArgs {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderStreamEvent {
  type: "delta" | "done" | "error";
  /** Incremental token text for "delta" events. */
  delta?: string;
  /** Final usage. May be approximate for providers that don't report it on stream end. */
  usage?: TokenUsage;
  finishReason?: string;
  errorMessage?: string;
}

export interface Provider {
  readonly name: ProviderName;
  chat(args: ProviderChatArgs): Promise<ChatResponse>;
  stream(args: ProviderChatArgs): AsyncIterable<ProviderStreamEvent>;
}

/** Rough token estimate fallback for providers that don't return usage on stream. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Heuristic: ~4 chars per token for English. Good enough for dashboards.
  return Math.ceil(text.length / 4);
}
