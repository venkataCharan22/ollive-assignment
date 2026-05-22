import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatResponse, ProviderName } from "../types";
import { estimateTokens, type Provider, type ProviderChatArgs, type ProviderStreamEvent } from "./base";

export class AnthropicProvider implements Provider {
  readonly name: ProviderName = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("AnthropicProvider requires an apiKey");
    this.client = new Anthropic({ apiKey });
  }

  private split(messages: ChatMessage[]): {
    system?: string;
    rest: Array<{ role: "user" | "assistant"; content: string }>;
  } {
    let system: string | undefined;
    const rest: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const m of messages) {
      if (m.role === "system") {
        system = system ? `${system}\n\n${m.content}` : m.content;
      } else {
        rest.push({ role: m.role, content: m.content });
      }
    }
    return { system, rest };
  }

  async chat(args: ProviderChatArgs): Promise<ChatResponse> {
    const { system, rest } = this.split(args.messages);
    const res = await this.client.messages.create(
      {
        model: args.model,
        max_tokens: args.maxTokens ?? 1024,
        temperature: args.temperature,
        system,
        messages: rest,
      },
      { signal: args.signal },
    );
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      requestId: res.id,
      text,
      usage: {
        promptTokens: res.usage.input_tokens,
        completionTokens: res.usage.output_tokens,
        totalTokens: res.usage.input_tokens + res.usage.output_tokens,
      },
      finishReason: res.stop_reason ?? undefined,
    };
  }

  async *stream(args: ProviderChatArgs): AsyncIterable<ProviderStreamEvent> {
    const { system, rest } = this.split(args.messages);
    let stream;
    try {
      stream = this.client.messages.stream(
        {
          model: args.model,
          max_tokens: args.maxTokens ?? 1024,
          temperature: args.temperature,
          system,
          messages: rest,
        },
        { signal: args.signal },
      );
    } catch (err) {
      yield { type: "error", errorMessage: (err as Error).message };
      return;
    }

    let aggregated = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: string | undefined;

    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          aggregated += event.delta.text;
          yield { type: "delta", delta: event.delta.text };
        } else if (event.type === "message_delta") {
          if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens;
          if (event.delta.stop_reason) finishReason = event.delta.stop_reason;
        } else if (event.type === "message_start") {
          inputTokens = event.message.usage.input_tokens;
        }
      }
    } catch (err) {
      yield { type: "error", errorMessage: (err as Error).message };
      return;
    }

    yield {
      type: "done",
      finishReason,
      usage: {
        promptTokens: inputTokens || args.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
        completionTokens: outputTokens || estimateTokens(aggregated),
        totalTokens: (inputTokens || 0) + (outputTokens || estimateTokens(aggregated)),
      },
    };
  }
}
