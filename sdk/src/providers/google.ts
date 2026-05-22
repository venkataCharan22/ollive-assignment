import { GoogleGenerativeAI, type Content, type GenerativeModel } from "@google/generative-ai";
import type { ChatMessage, ChatResponse, ProviderName } from "../types";
import { estimateTokens, type Provider, type ProviderChatArgs, type ProviderStreamEvent } from "./base";

/**
 * Gemini wrapper. Note that the Google SDK uses "user" / "model" roles and a
 * separate systemInstruction field, so we translate from the unified
 * ChatMessage shape.
 */
export class GoogleProvider implements Provider {
  readonly name: ProviderName = "google";
  private readonly client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("GoogleProvider requires an apiKey");
    this.client = new GoogleGenerativeAI(apiKey);
  }

  private model(modelId: string, system?: string): GenerativeModel {
    return this.client.getGenerativeModel({
      model: modelId,
      systemInstruction: system,
    });
  }

  private translate(messages: ChatMessage[]): { system?: string; contents: Content[] } {
    let system: string | undefined;
    const contents: Content[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        system = system ? `${system}\n\n${m.content}` : m.content;
      } else {
        contents.push({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        });
      }
    }
    return { system, contents };
  }

  async chat(args: ProviderChatArgs): Promise<ChatResponse> {
    const { system, contents } = this.translate(args.messages);
    const model = this.model(args.model, system);
    const res = await model.generateContent({
      contents,
      generationConfig: {
        temperature: args.temperature,
        maxOutputTokens: args.maxTokens,
      },
    });
    const text = res.response.text();
    const usage = res.response.usageMetadata;
    return {
      requestId: `gemini-${Date.now()}`,
      text,
      usage: {
        promptTokens: usage?.promptTokenCount ?? estimateTokens(JSON.stringify(args.messages)),
        completionTokens: usage?.candidatesTokenCount ?? estimateTokens(text),
        totalTokens: usage?.totalTokenCount ?? 0,
      },
      finishReason: res.response.candidates?.[0]?.finishReason,
    };
  }

  async *stream(args: ProviderChatArgs): AsyncIterable<ProviderStreamEvent> {
    const { system, contents } = this.translate(args.messages);
    const model = this.model(args.model, system);

    let stream;
    try {
      stream = await model.generateContentStream({
        contents,
        generationConfig: {
          temperature: args.temperature,
          maxOutputTokens: args.maxTokens,
        },
      });
    } catch (err) {
      yield { type: "error", errorMessage: (err as Error).message };
      return;
    }

    let aggregated = "";
    try {
      for await (const chunk of stream.stream) {
        if (args.signal?.aborted) {
          yield { type: "error", errorMessage: "aborted" };
          return;
        }
        const delta = chunk.text();
        if (delta) {
          aggregated += delta;
          yield { type: "delta", delta };
        }
      }
    } catch (err) {
      yield { type: "error", errorMessage: (err as Error).message };
      return;
    }

    const finalResponse = await stream.response;
    const usage = finalResponse.usageMetadata;

    yield {
      type: "done",
      finishReason: finalResponse.candidates?.[0]?.finishReason,
      usage: {
        promptTokens: usage?.promptTokenCount ?? estimateTokens(JSON.stringify(args.messages)),
        completionTokens: usage?.candidatesTokenCount ?? estimateTokens(aggregated),
        totalTokens: usage?.totalTokenCount ?? 0,
      },
    };
  }
}
