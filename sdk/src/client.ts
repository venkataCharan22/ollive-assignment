import { randomUUID } from "node:crypto";
import { OpenAIProvider } from "./providers/openai";
import { AnthropicProvider } from "./providers/anthropic";
import { GoogleProvider } from "./providers/google";
import { GroqProvider } from "./providers/groq";
import { MockProvider } from "./providers/mock";
import type { Provider } from "./providers/base";
import { IngestionTransport } from "./transport";
import { preview, redact, redactMessages } from "./redact";
import type {
  ChatRequest,
  ChatResponse,
  InferenceLog,
  OlliveClientConfig,
  ProviderName,
  TokenUsage,
} from "./types";

const SDK_VERSION = "0.1.0";

/**
 * OlliveClient — the only thing the chatbot imports.
 *
 * Wraps a foundation-model provider and emits an InferenceLog for every call
 * (success, error, or cancellation). The log is shipped to the ingestion
 * service asynchronously so observability never blocks the user-facing path.
 */
export class OlliveClient {
  private readonly provider: Provider;
  private readonly transport: IngestionTransport;
  private readonly providerName: ProviderName;
  private readonly redactEnabled: boolean;

  constructor(config: OlliveClientConfig) {
    this.providerName = config.provider;
    this.provider = pickProvider(config);
    this.transport = new IngestionTransport({
      url: config.ingestion.url,
      apiKey: config.ingestion.apiKey,
      failOpen: config.ingestion.failOpen ?? true,
    });
    this.redactEnabled = config.redact ?? true;
  }

  /** Non-streaming chat. Returns the full response, logs once. */
  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const requestId = req.requestId ?? randomUUID();
    const startedAt = new Date();
    const t0 = performance.now();
    try {
      const res = await this.provider.chat({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        signal,
      });
      const t1 = performance.now();
      this.emit(this.buildLog({
        req,
        requestId,
        provider: this.providerName,
        status: signal?.aborted ? "cancelled" : "ok",
        startedAt,
        finishedAt: new Date(),
        latencyMs: Math.round(t1 - t0),
        streamed: false,
        usage: res.usage,
        outputText: res.text,
        finishReason: res.finishReason,
      }));
      return { ...res, requestId };
    } catch (err) {
      const t1 = performance.now();
      const e = err as Error & { code?: string };
      const cancelled = signal?.aborted || /aborted/i.test(e.message);
      this.emit(this.buildLog({
        req,
        requestId,
        provider: this.providerName,
        status: cancelled ? "cancelled" : "error",
        startedAt,
        finishedAt: new Date(),
        latencyMs: Math.round(t1 - t0),
        streamed: false,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        outputText: "",
        errorCode: e.code ?? e.name,
        errorMessage: e.message,
      }));
      throw err;
    }
  }

  /**
   * Streaming chat. Yields text deltas to the caller (for SSE forwarding)
   * and emits one consolidated InferenceLog once the stream ends or errors.
   */
  async *chatStream(
    req: ChatRequest,
    signal?: AbortSignal,
  ): AsyncIterable<{ delta?: string; done?: boolean; error?: string }> {
    const requestId = req.requestId ?? randomUUID();
    const startedAt = new Date();
    const t0 = performance.now();
    let ttftMs: number | undefined;
    let aggregated = "";
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: string | undefined;
    let errorMessage: string | undefined;
    let cancelled = false;

    try {
      for await (const ev of this.provider.stream({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature,
        maxTokens: req.maxTokens,
        signal,
      })) {
        if (ev.type === "delta" && ev.delta) {
          if (ttftMs === undefined) ttftMs = Math.round(performance.now() - t0);
          aggregated += ev.delta;
          yield { delta: ev.delta };
        } else if (ev.type === "done") {
          if (ev.usage) usage = ev.usage;
          finishReason = ev.finishReason;
          yield { done: true };
        } else if (ev.type === "error") {
          errorMessage = ev.errorMessage;
          cancelled = /aborted/i.test(ev.errorMessage ?? "");
          yield { error: ev.errorMessage };
        }
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
      }
    } catch (err) {
      const e = err as Error;
      errorMessage = e.message;
      cancelled = signal?.aborted || /aborted/i.test(e.message);
      yield { error: e.message };
    } finally {
      const t1 = performance.now();
      this.emit(this.buildLog({
        req,
        requestId,
        provider: this.providerName,
        status: errorMessage ? (cancelled ? "cancelled" : "error") : "ok",
        startedAt,
        finishedAt: new Date(),
        latencyMs: Math.round(t1 - t0),
        ttftMs,
        streamed: true,
        usage,
        outputText: aggregated,
        finishReason,
        errorCode: errorMessage ? "stream_error" : undefined,
        errorMessage,
      }));
    }
  }

  /** Drain any in-flight log shipments. Call before process exit if you care. */
  flush(timeoutMs?: number): Promise<void> {
    return this.transport.flush(timeoutMs);
  }

  private emit(log: InferenceLog): void {
    this.transport.send(log);
  }

  private buildLog(args: {
    req: ChatRequest;
    requestId: string;
    provider: ProviderName;
    status: InferenceLog["status"];
    startedAt: Date;
    finishedAt: Date;
    latencyMs: number;
    ttftMs?: number;
    streamed: boolean;
    usage: TokenUsage;
    outputText: string;
    finishReason?: string;
    errorCode?: string;
    errorMessage?: string;
  }): InferenceLog {
    const { messages: redactedMessages } = redactMessages(args.req.messages, this.redactEnabled);
    const { text: redactedOutput } = redact(args.outputText, this.redactEnabled);
    const lastUser = [...args.req.messages].reverse().find((m) => m.role === "user");
    const { text: inputPreviewText } = redact(lastUser?.content ?? "", this.redactEnabled);
    return {
      requestId: args.requestId,
      conversationId: args.req.conversationId,
      provider: args.provider,
      model: args.req.model,
      status: args.status,
      startedAt: args.startedAt.toISOString(),
      finishedAt: args.finishedAt.toISOString(),
      latencyMs: args.latencyMs,
      ttftMs: args.ttftMs,
      streamed: args.streamed,
      usage: args.usage,
      inputPreview: preview(inputPreviewText),
      outputPreview: preview(redactedOutput),
      messages: redactedMessages,
      output: redactedOutput,
      errorCode: args.errorCode,
      errorMessage: args.errorMessage,
      tags: args.req.tags,
      sdkVersion: SDK_VERSION,
    };
  }
}

function pickProvider(config: OlliveClientConfig): Provider {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(config.apiKey ?? "");
    case "anthropic":
      return new AnthropicProvider(config.apiKey ?? "");
    case "google":
      return new GoogleProvider(config.apiKey ?? "");
    case "groq":
      return new GroqProvider(config.apiKey ?? "");
    case "mock":
      return new MockProvider();
    default: {
      const _exhaustive: never = config.provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}
