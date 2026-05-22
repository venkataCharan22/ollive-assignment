import OpenAI from "openai";
import type { ChatResponse, ProviderName } from "../types";
import { estimateTokens, type Provider, type ProviderChatArgs, type ProviderStreamEvent } from "./base";

export class OpenAIProvider implements Provider {
  readonly name: ProviderName = "openai";
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("OpenAIProvider requires an apiKey");
    this.client = new OpenAI({ apiKey });
  }

  async chat(args: ProviderChatArgs): Promise<ChatResponse> {
    const res = await this.client.chat.completions.create(
      {
        model: args.model,
        messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: args.temperature,
        max_tokens: args.maxTokens,
        stream: false,
      },
      { signal: args.signal },
    );
    const text = res.choices[0]?.message?.content ?? "";
    const usage = res.usage;
    return {
      requestId: res.id,
      text,
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
      finishReason: res.choices[0]?.finish_reason ?? undefined,
    };
  }

  async *stream(args: ProviderChatArgs): AsyncIterable<ProviderStreamEvent> {
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(
        {
          model: args.model,
          messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: args.temperature,
          max_tokens: args.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: args.signal },
      );
    } catch (err) {
      yield { type: "error", errorMessage: (err as Error).message };
      return;
    }

    let aggregated = "";
    let usage: ProviderStreamEvent["usage"];
    let finishReason: string | undefined;
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          aggregated += delta;
          yield { type: "delta", delta };
        }
        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
      }
    } catch (err) {
      yield { type: "error", errorMessage: (err as Error).message };
      return;
    }

    yield {
      type: "done",
      finishReason,
      usage: usage ?? {
        promptTokens: args.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
        completionTokens: estimateTokens(aggregated),
        totalTokens: 0,
      },
    };
  }
}
