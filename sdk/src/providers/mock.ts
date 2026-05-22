import type { ChatResponse, ProviderName } from "../types";
import { estimateTokens, type Provider, type ProviderChatArgs, type ProviderStreamEvent } from "./base";

/**
 * Mock provider. Lets the whole stack run without any API keys, so reviewers
 * can boot Docker Compose and see the dashboards immediately.
 *
 * It returns a deterministic response that paraphrases the last user message,
 * streaming it token-by-token with realistic ~30ms delays.
 */
export class MockProvider implements Provider {
  readonly name: ProviderName = "mock";

  private generate(messages: ProviderChatArgs["messages"], model: string): string {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const seed = (last?.content ?? "hello").slice(0, 200).replace(/\s+/g, " ").trim();
    if (model === "mock-error") {
      throw new Error("Mock provider: simulated upstream failure");
    }
    return (
      `[mock:${model}] Here's a structured take on "${seed}":\n\n` +
      `1. I'm a deterministic mock so reviewers don't need API keys.\n` +
      `2. Real providers (OpenAI / Anthropic / Gemini) plug in behind the same Provider interface.\n` +
      `3. Every call you see in the dashboard came through the @ollive/llm-sdk wrapper — same code path, ` +
      `different transport.`
    );
  }

  async chat(args: ProviderChatArgs): Promise<ChatResponse> {
    if (args.signal?.aborted) throw new Error("aborted");
    const text = this.generate(args.messages, args.model);
    // Simulate latency.
    await new Promise((r) => setTimeout(r, 120));
    const promptTokens = args.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    const completionTokens = estimateTokens(text);
    return {
      requestId: cryptoRandom(),
      text,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      finishReason: "stop",
    };
  }

  async *stream(args: ProviderChatArgs): AsyncIterable<ProviderStreamEvent> {
    let text: string;
    try {
      text = this.generate(args.messages, args.model);
    } catch (err) {
      yield { type: "error", errorMessage: (err as Error).message };
      return;
    }
    // Split into chunks of ~12 chars so the stream looks like real tokens.
    const chunks = text.match(/.{1,12}/gs) ?? [];
    for (const chunk of chunks) {
      if (args.signal?.aborted) {
        yield { type: "error", errorMessage: "aborted" };
        return;
      }
      await new Promise((r) => setTimeout(r, 30));
      yield { type: "delta", delta: chunk };
    }
    const promptTokens = args.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    const completionTokens = estimateTokens(text);
    yield {
      type: "done",
      finishReason: "stop",
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
