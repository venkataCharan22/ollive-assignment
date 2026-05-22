export type ProviderName = "openai" | "anthropic" | "google" | "groq" | "mock";

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Conversation/session identifier. Ties multiple inference calls together
   * for downstream analytics. Created by the caller (chatbot app).
   */
  conversationId: string;
  /**
   * Optional caller-supplied request id. If omitted, the SDK generates one.
   */
  requestId?: string;
  /**
   * Free-form tags forwarded to the ingestion service. Useful for splitting
   * traffic in dashboards (e.g. { feature: "summarize" }).
   */
  tags?: Record<string, string>;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  requestId: string;
  text: string;
  usage: TokenUsage;
  finishReason?: string;
}

export interface InferenceLog {
  requestId: string;
  conversationId: string;
  provider: ProviderName;
  model: string;
  status: "ok" | "error" | "cancelled";
  /** ISO timestamp when the request was issued */
  startedAt: string;
  /** ISO timestamp when the response finished (or errored) */
  finishedAt: string;
  /** End-to-end latency in milliseconds */
  latencyMs: number;
  /** Streaming-only: time to first token in milliseconds */
  ttftMs?: number;
  streamed: boolean;
  usage: TokenUsage;
  /** Redacted preview of the user's last message (max 500 chars) */
  inputPreview: string;
  /** Redacted preview of the assistant response (max 500 chars) */
  outputPreview: string;
  /** Full request messages, optionally redacted. Kept for replay/debugging. */
  messages: ChatMessage[];
  /** Full output text, optionally redacted. */
  output?: string;
  errorCode?: string;
  errorMessage?: string;
  tags?: Record<string, string>;
  sdkVersion: string;
}

export interface OlliveClientConfig {
  provider: ProviderName;
  /** API key for the chosen provider. Mock provider ignores this. */
  apiKey?: string;
  ingestion: {
    /** Base URL of the ingestion service, e.g. http://localhost:4000 */
    url: string;
    /** Shared secret sent as X-Ollive-Key */
    apiKey: string;
    /**
     * If true, log shipping failures throw. Default false — we don't want
     * observability to break the user-facing chat path.
     */
    failOpen?: boolean;
  };
  /** Apply PII redaction to message bodies before sending logs. Default true. */
  redact?: boolean;
}
